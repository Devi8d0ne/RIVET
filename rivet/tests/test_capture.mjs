import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const captureSource = (await readFile(new URL('../src/capture.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
const apiSource = await readFile(new URL('../src/api.js', import.meta.url), 'utf8');

function harness({ request, failStart = false } = {}) {
  const stores = { sessions: new Map(), chunks: new Map() };
  const calls = [];
  async function db(store, method, value) {
    calls.push([store, method, typeof value === 'object' ? value.key || value.id : value]);
    if (method === 'put') { stores[store].set(value.key || value.id, value); return value.key || value.id; }
    if (method === 'get') return stores[store].get(value);
    if (method === 'delete') return stores[store].delete(value);
    if (method === 'getAllKeys') return [...stores[store].keys()];
    if (method === 'getAll') {
      assert.notEqual(store, 'chunks', 'Recovery must not load every video Blob');
      return [...stores[store].values()];
    }
    throw new Error('Unknown storage method');
  }
  class Recorder {
    constructor(stream, options) { this.mimeType = options.mimeType; this.options = options; this.state = 'inactive'; this.listeners = new Map(); }
    start() { if (failStart) throw new Error('encoder unavailable'); this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.listeners.get('stop')?.(); }
    addEventListener(event, callback) { this.listeners.set(event, callback); }
    emit(blob) { this.ondataavailable({ data: blob }); }
  }
  const apiCalls = [];
  async function api(path, body, raw) {
    apiCalls.push({ path, body, raw });
    if (request) return request(path, body, raw, stores);
    return path.endsWith('/finish') ? { status: 'complete' } : { id: 'recording-id' };
  }
  const context = vm.createContext({ api, db, recordingMimeType: () => 'video/webm', MediaRecorder: Recorder,
    Blob, Date, Promise, Error, setTimeout, setInterval: () => 1, clearInterval() {} });
  vm.runInContext(captureSource + '\nthis.testExports = { LocalRecording, LiveBroadcast, saveClip };', context);
  return { ...context.testExports, context, stores, calls, apiCalls, api, db };
}

async function flushSettled(recording) {
  await recording.writes;
  while (recording.flushing) await new Promise(resolve => setTimeout(resolve, 0));
}

test('service outage retains video in storage and only lightweight pending entries in memory', async () => {
  const h = harness({ request(path) { if (path.includes('/chunk?')) throw new Error('service offline'); return { id: 'recording-id' }; } });
  const recording = new h.LocalRecording(() => {});
  await recording.start({}, 'Match');
  for (let index = 0; index < 40; index++) recording.recorder.emit(new Blob(['frame-' + index]));
  await flushSettled(recording);
  assert.equal(recording.pending.length, 40);
  assert.equal(h.stores.chunks.size, 40);
  assert.ok(recording.pending.every(entry => !('blob' in entry)));
  assert.match(recording.saveError, /backup retained/);
  await assert.rejects(recording.stop(), /backed up in this browser/);
  assert.equal(h.stores.sessions.size, 1);
});

test('large Android recorder events are split into bounded ordered uploads', async () => {
  const h = harness();
  const recording = new h.LocalRecording(() => {});
  await recording.start({}, 'Match');
  recording.recorder.emit(new Blob([new Uint8Array(9 * 1024 * 1024)]));
  await flushSettled(recording);
  await recording.stop();
  const chunks = h.apiCalls.filter(call => call.path.includes('/chunk?'));
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map(call => call.body.size), [4 * 1024 * 1024, 4 * 1024 * 1024, 1024 * 1024]);
  assert.deepEqual(chunks.map(call => call.path.split('seq=')[1]), ['0', '1', '2']);
  assert.equal(h.stores.chunks.size, 0);
});

test('all replay slices exist in browser storage before upload can fail', async () => {
  const h = harness({ request(path, body, raw, stores) {
    if (path.includes('/chunk?')) { assert.equal(stores.chunks.size, 3); throw new Error('service offline'); }
    return { id: 'replay-id' };
  } });
  await assert.rejects(h.saveClip(new Blob([new Uint8Array(9 * 1024 * 1024)], { type: 'video/webm' }), 'Replay'), /service offline/);
  assert.equal(h.stores.chunks.size, 3);
  assert.equal([...h.stores.chunks.values()].reduce((size, chunk) => size + chunk.blob.size, 0), 9 * 1024 * 1024);
});

test('failed browser streaming encoder closes the already-created backend stream', async () => {
  const h = harness({ failStart: true });
  const broadcast = new h.LiveBroadcast(() => {});
  await assert.rejects(broadcast.start({}, [{ url: 'rtmp://example.test/live', key: 'local-test' }]), /encoder unavailable/);
  assert.ok(h.apiCalls.some(call => call.path === '/api/stream/recording-id/stop'));
  assert.equal(broadcast.stopped, true);
});

test('capture bitrate follows actual video width and live start forwards quality', async () => {
  for (const [width, bitrate, quality] of [[854, 1200000, 'light'], [1280, 3000000, 'standard'], [1920, 6000000, 'high']]) {
    const h = harness();
    const broadcast = new h.LiveBroadcast(() => {});
    const stream = { getVideoTracks: () => [{ getSettings: () => ({ width }) }] };
    await broadcast.start(stream, [{ url: 'rtmp://example.test/live', key: 'test' }], quality);
    assert.equal(broadcast.recorder.options.videoBitsPerSecond, bitrate);
    assert.equal(h.apiCalls[0].body.quality, quality);
    await broadcast.stop();
  }
});

test('stream chunks are split in order and stalled uploads cannot exceed 32 MiB', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const h = harness({ request(path) { return path.includes('/chunk?') ? wait : { id: 'stream-id' }; } });
  const broadcast = new h.LiveBroadcast(() => {});
  await broadcast.start({}, []);
  broadcast.recorder.emit(new Blob([new Uint8Array(9 * 1024 * 1024)]));
  assert.deepEqual(Array.from(broadcast.queue, item => item.seq), [0, 1, 2]);
  assert.ok(broadcast.queue.every(item => item.blob.size <= 4 * 1024 * 1024));
  broadcast.recorder.emit(new Blob([new Uint8Array(24 * 1024 * 1024)]));
  assert.equal(broadcast.stopped, true);
  assert.equal(broadcast.queueBytes, 0);
  assert.equal(broadcast.queue.length, 0);
  release({ ok: true });
  while (broadcast.flushing) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(broadcast.queueBytes, 0);
});

test('recovery loads one persisted Blob at a time in numeric sequence order', async () => {
  const h = harness();
  h.stores.sessions.set('recover', { id: 'recover' });
  for (const seq of [10, 2, 0]) h.stores.chunks.set(`recover:${seq}`, { id: 'recover', seq, key: `recover:${seq}`, blob: new Blob([String(seq)]) });
  const source = apiSource.slice(apiSource.indexOf('export async function recoverRecordings')).replace('export ', '');
  vm.runInContext(source + '\nthis.recoverTest = recoverRecordings;', h.context);
  assert.equal(await h.context.recoverTest(), 1);
  assert.deepEqual(h.apiCalls.filter(call => call.path.includes('/chunk?')).map(call => call.path.split('seq=')[1]), ['0', '2', '10']);
  assert.ok(h.calls.some(call => call[0] === 'chunks' && call[1] === 'getAllKeys'));
  assert.equal(h.stores.sessions.size, 0);
});
