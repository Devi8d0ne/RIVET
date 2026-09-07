import { api, db } from './api';
import { recordingMimeType } from './engine';

const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_WRITE_BYTES = 32 * 1024 * 1024;
const MAX_STREAM_QUEUE_BYTES = 32 * 1024 * 1024;

function makeRecorder(stream) {
  const mime = recordingMimeType();
  if (!mime || !mime.startsWith('video/webm')) throw new Error('Recording needs a browser with WebM video support, such as Chrome on Android.');
  const width = stream.getVideoTracks?.()[0]?.getSettings?.().width || 1280;
  const videoBitsPerSecond = width >= 1920 ? 6000000 : width >= 1280 ? 3000000 : 1200000;
  return new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond, audioBitsPerSecond: 128000 });
}

/** Every local chunk is committed to browser storage before it is sent to Linux. */
export class LocalRecording {
  constructor(onState) { this.onState = onState; this.seq = 0; this.pending = []; this.bytes = 0; this.pendingWriteBytes = 0; this.writes = Promise.resolve(); }
  async start(stream, title) {
    this.recorder = makeRecorder(stream);
    this.id = (await api('/api/recordings', { title, mime: this.recorder.mimeType })).id;
    await db('sessions', 'put', { id: this.id, title });
    this.startedAt = Date.now();
    this.recorder.ondataavailable = event => {
      if (!event.data.size) return;
      // Android may deliver a large event after the tab was suspended. Split it
      // before upload and stop capture if browser persistence falls behind.
      this.pendingWriteBytes += event.data.size;
      if (this.pendingWriteBytes > MAX_PENDING_WRITE_BYTES) {
        this.error = 'Recording stopped because browser storage could not keep up. Already captured media is being saved.';
        if (this.recorder.state !== 'inactive') this.recorder.stop();
      }
      this.writes = this.writes.then(async () => {
        if (this.persistenceFailed) return;
        for (let offset = 0; offset < event.data.size; offset += CHUNK_BYTES) {
          const seq = this.seq;
          const chunk = { id: this.id, seq, key: `${this.id}:${seq}`, blob: event.data.slice(offset, offset + CHUNK_BYTES) };
          await db('chunks', 'put', chunk);
          this.seq++;
          // Pending uploads hold keys, never the accumulated video blobs.
          this.pending.push({ key: chunk.key, seq });
          this.bytes += chunk.blob.size;
          this.notify(); void this.flush();
        }
      }).catch(error => { this.persistenceFailed = true; this.error = `Recording stopped: ${error.message || 'local backup storage failed'}`; this.notify(); if (this.recorder.state !== 'inactive') this.recorder.stop(); })
        .finally(() => { this.pendingWriteBytes -= event.data.size; });
    };
    this.recorder.onerror = () => { this.error = 'The browser stopped recording. Your saved chunks are retained.'; this.notify(); };
    try { this.recorder.start(1000); }
    catch (error) { await db('sessions', 'delete', this.id); throw error; }
    this.timer = setInterval(() => { this.notify(); void this.flush(); }, 1500);
    this.notify();
  }
  notify() {
    const message = this.error || this.saveError;
    const error = message && message !== this.reportedError ? message : undefined;
    this.reportedError = message;
    this.onState({ id: this.id, active: this.recorder?.state === 'recording', seconds: (Date.now() - this.startedAt) / 1000, bytes: this.bytes, pending: this.pending.length, saveError: this.saveError, error });
  }
  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.pending.length) {
        const saved = this.pending[0];
        const chunk = await db('chunks', 'get', saved.key);
        if (!chunk) throw new Error('The browser backup is no longer available.');
        await api(`/api/recordings/${this.id}/chunk?seq=${chunk.seq}`, chunk.blob, true);
        await db('chunks', 'delete', chunk.key); this.pending.shift();
      }
      this.saveError = null;
    } catch { this.saveError = 'Saving paused. Local backup retained.'; }
    finally { this.flushing = false; this.notify(); }
  }
  async stop() {
    clearInterval(this.timer);
    if (this.recorder.state !== 'inactive') await new Promise(resolve => { this.recorder.addEventListener('stop', resolve, { once: true }); this.recorder.stop(); });
    await this.writes;
    while (this.flushing) await new Promise(resolve => setTimeout(resolve, 100));
    await this.flush();
    if (this.pending.length) throw new Error('The recording is backed up in this browser. Reconnect the local service and select Recover recordings in Library.');
    const result = await api(`/api/recordings/${this.id}/finish`, {});
    await db('sessions', 'delete', this.id); return result;
  }
}

/** Streaming uses its own recorder and bounded queue; it cannot stop a recording. */
export class LiveBroadcast {
  constructor(onState) { this.onState = onState; this.seq = 0; this.queue = []; this.queueBytes = 0; this.stopped = false; }
  async start(stream, destinations, quality = 'standard') {
    this.recorder = makeRecorder(stream);
    this.id = (await api('/api/stream/start', { destinations, quality })).id;
    this.recorder.ondataavailable = event => {
      if (!event.data.size || this.stopped) return;
      for (let offset = 0; offset < event.data.size; offset += CHUNK_BYTES) {
        const blob = event.data.slice(offset, offset + CHUNK_BYTES);
        if (this.queue.length >= 10 || this.queueBytes + blob.size > MAX_STREAM_QUEUE_BYTES) {
          void this.fail('Stream stopped because the encoder could not keep up. Local recording continues.'); return;
        }
        this.queue.push({ seq: this.seq++, blob }); this.queueBytes += blob.size;
      }
      void this.flush();
    };
    this.recorder.onerror = () => void this.fail('The browser encoder stopped. Local recording is independent.');
    try { this.recorder.start(1000); }
    catch (error) { await this.stop(); throw error; }
    this.onState({ active: true, id: this.id });
  }
  async flush() {
    if (this.flushing || this.stopped) return;
    this.flushing = true;
    try {
      while (this.queue.length && !this.stopped) {
        const chunk = this.queue[0]; let attempts = 0;
        for (;;) {
          try { await api(`/api/stream/${this.id}/chunk?seq=${chunk.seq}`, chunk.blob, true); break; }
          catch (error) { if (error.status !== 429 || ++attempts > 5) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
        }
        const sent = this.queue.shift();
        if (sent) this.queueBytes -= sent.blob.size;
      }
    } catch (error) { await this.fail(error.message); }
    finally { this.flushing = false; }
  }
  async fail(message) { await this.stop(); this.onState({ active: false, error: message }); }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.recorder?.state !== 'inactive') this.recorder?.stop();
    this.queue = []; this.queueBytes = 0;
    try { if (this.id) await api(`/api/stream/${this.id}/stop`, {}); } catch { /* The service also detects encoder disconnects. */ }
    this.onState({ active: false });
  }
}

export async function saveClip(blob, title) {
  const id = (await api('/api/recordings', { title, mime: blob.type || 'video/webm' })).id;
  await db('sessions', 'put', { id, title });
  const pending = [];
  // The complete replay must be recoverable before the first network request.
  for (let offset = 0, seq = 0; offset < blob.size; offset += CHUNK_BYTES, seq++) {
    const chunk = { id, seq, key: `${id}:${seq}`, blob: blob.slice(offset, offset + CHUNK_BYTES) };
    await db('chunks', 'put', chunk); pending.push({ key: chunk.key, seq });
  }
  for (const saved of pending) {
    const chunk = await db('chunks', 'get', saved.key);
    await api(`/api/recordings/${id}/chunk?seq=${saved.seq}`, chunk.blob, true);
    await db('chunks', 'delete', saved.key);
  }
  await api(`/api/recordings/${id}/finish`, {}); await db('sessions', 'delete', id); return id;
}
