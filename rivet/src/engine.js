const WIDTH = 1280;
const HEIGHT = 720;
export const QUALITY_PROFILES = Object.freeze({
  light: Object.freeze({ width: 854, height: 480, fps: 24, bitrate: 1_200_000 }),
  standard: Object.freeze({ width: 1280, height: 720, fps: 30, bitrate: 2_000_000 }),
  high: Object.freeze({ width: 1920, height: 1080, fps: 30, bitrate: 4_000_000 }),
});
const SEGMENT_MS = 10_000;
const MAX_REPLAY_BYTES = 12 * 1024 * 1024;
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, Number(value) || 0));
const sourceId = () => globalThis.crypto?.randomUUID?.() || `source-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const INPUT_PREFERENCES_KEY = 'rivet.input-preferences.v1';
const INPUT_KINDS = ['videoinput', 'audioinput'];
const inputName = kind => kind === 'videoinput' ? 'camera' : 'microphone';
function cleanInputPreference(value, kind) {
  if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 1024
    || typeof value.label !== 'string' || value.label.length > 512) return null;
  return { id: value.id, label: value.label,
    ...(kind === 'videoinput' && ['user', 'environment', 'left', 'right'].includes(value.facingMode) ? { facingMode: value.facingMode } : {}) };
}
function readInputPreferences() {
  const empty = { videoinput: null, audioinput: null };
  let serialized;
  try { serialized = globalThis.localStorage.getItem(INPUT_PREFERENCES_KEY); }
  catch { return { preferences: empty, persistent: false }; }
  try {
    const stored = JSON.parse(serialized);
    return { preferences: Object.fromEntries(INPUT_KINDS.map(kind => [kind, cleanInputPreference(stored?.[kind], kind)])), persistent: true };
  } catch { return { preferences: empty, persistent: true }; }
}

export function recordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  return ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4']
    .find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function waitForMedia(element, event, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      element.removeEventListener(event, ready);
      element.removeEventListener('error', failed);
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('This browser could not decode that media file. Try an MP4, WebM, WAV, MP3, PNG, or JPEG.')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('The media source did not become ready in time.')); }, timeout);
    element.addEventListener(event, ready, { once: true });
    element.addEventListener('error', failed, { once: true });
  });
}

/** Local canvas compositor and Web Audio mixer. No remote assets or services. */
export class StudioEngine {
  constructor(canvas, onChange = () => {}, { quality = 'standard' } = {}) {
    if (!canvas?.getContext) throw new Error('A program canvas is required.');
    if (!Object.hasOwn(QUALITY_PROFILES, quality)) throw new Error('Choose a light, standard, or high quality profile.');
    this.quality = quality;
    this.canvas = canvas;
    this.canvas.width = QUALITY_PROFILES[quality].width;
    this.canvas.height = QUALITY_PROFILES[quality].height;
    this.ctx = canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('Canvas rendering is unavailable in this browser.');
    this.onChange = onChange;
    this.sources = [{ id: 'slate', name: 'RIVET studio', type: 'slate', volume: 1 }];
    this.programId = 'slate';
    this.previewId = 'slate';
    this.insetId = null;
    this.overlay = {
      home: 'HOME', away: 'AWAY', homeScore: 0, awayScore: 0,
      period: '1', clock: '00:00', visible: true, lowerThird: '', lowerVisible: false,
      preset: 'classic', raceTo: 7, down: 1, distance: 10, homeFouls: 0, awayFouls: 0,
      possession: 'none', graphicMode: 'scoreboard', sponsorText: '', sponsorVisible: false,
    };
    this.masterVolume = 0.8;
    this.mediaVolume = 0.8;
    this.micVolume = 0.85;
    this.micEnabled = false;
    this.ducking = false;
    this.error = null;
    this._destroyed = false;
    this._micGeneration = 0;
    this._deviceBusy = 0;
    this._captureLocked = false;
    const rememberedInputs = readInputPreferences();
    this.inputPreferences = rememberedInputs.preferences;
    this.inputPreferencesPersistent = rememberedInputs.persistent;
    this._inputPreferenceVersions = { videoinput: 0, audioinput: 0 };
    this._reconnectPromise = null;
    this._micOptions = { echoCancellation: true, noiseSuppression: true, autoGainControl: false };
    this._cameraControlWork = new Map();
    this._lastFrame = -Infinity;
    this._replay = { active: false, recorder: null, timer: null, segments: [], pending: null };
    this._toneNodes = new Set();
    this._ensureAudio();
    this._render(0);
    this._tick = (time) => {
      if (this._destroyed) return;
      const frameInterval = 1000 / QUALITY_PROFILES[this.quality].fps;
      const elapsed = time - this._lastFrame;
      if (elapsed >= frameInterval) {
        this._lastFrame = Number.isFinite(elapsed) ? time - Math.max(0, elapsed % frameInterval) : time;
        this._render(time);
        this._updateDucking();
      }
      this._raf = requestAnimationFrame(this._tick);
    };
    this._raf = requestAnimationFrame(this._tick);
  }

  _ensureAudio() {
    if (this.audio) return;
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) throw new Error('Web Audio is unavailable. Open RIVET in a current Chromium browser.');
    this.audio = new Context({ latencyHint: 'interactive' });
    this.destination = this.audio.createMediaStreamDestination();
    this.master = this.audio.createGain();
    this.master.gain.value = this.masterVolume;
    this.masterAnalyser = this.audio.createAnalyser();
    this.masterAnalyser.fftSize = 256;
    this.master.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.destination);
    this._masterSamples = new Float32Array(this.masterAnalyser.fftSize);
    this.mediaBus = this.audio.createGain();
    this.mediaBus.gain.value = this.mediaVolume;
    this.mediaBus.connect(this.master);
    // Only media and stingers are monitored. The microphone never feeds speakers.
    this.monitor = this.audio.createGain();
    this.monitor.gain.value = 0.7;
    this.mediaBus.connect(this.monitor);
    this.monitor.connect(this.audio.destination);
    this.micAnalyser = this.audio.createAnalyser();
    this.micAnalyser.fftSize = 256;
    this._micSamples = new Float32Array(this.micAnalyser.fftSize);
    this.micGain = this.audio.createGain();
    this.micGain.gain.value = this.micVolume;
    this.micGain.connect(this.micAnalyser);
    this.micAnalyser.connect(this.master);
    // A silent source keeps the composed stream's audio track present between cues.
    this._silence = this.audio.createOscillator();
    this._silenceGain = this.audio.createGain();
    this._silenceGain.gain.value = 0;
    this._silence.connect(this._silenceGain);
    this._silenceGain.connect(this.master);
    this._silence.start();
  }

  async init() {
    if (this._destroyed) throw new Error('This studio has been closed.');
    if (this.audio.state === 'suspended') await this.audio.resume();
    return this;
  }

  snapshot() {
    return {
      sources: this.sources.map((source) => ({
        id: source.id, name: source.name, type: source.type,
        volume: source.volume, ended: Boolean(source.ended),
        playing: source.element && 'paused' in source.element ? !source.element.paused : source.type === 'camera',
        duration: Number.isFinite(source.element?.duration) ? source.element.duration : undefined,
        currentTime: Number.isFinite(source.element?.currentTime) ? source.element.currentTime : 0,
        ...(source.type === 'camera' ? { camera: this._cameraInfo(source), switching: Boolean(source.switching) } : {}),
      })),
      programId: this.programId, previewId: this.previewId, insetId: this.insetId, overlay: { ...this.overlay },
      quality: this.quality, output: { ...QUALITY_PROFILES[this.quality] }, capabilities: this.capabilities(),
      masterVolume: this.masterVolume, mediaVolume: this.mediaVolume, micVolume: this.micVolume,
      micEnabled: this.micEnabled, ducking: this.ducking,
      microphone: this._microphoneInfo(), deviceBusy: this._deviceBusy > 0,
      inputPreferences: Object.fromEntries(INPUT_KINDS.map(kind => [kind, this.inputPreferences[kind] ? { ...this.inputPreferences[kind] } : null])),
      inputPreferencesPersistent: this.inputPreferencesPersistent,
      replayBuffering: this._replay.active, replayReady: this._replay.segments.length > 0,
      error: this.error,
    };
  }

  _emit() { if (!this._destroyed) this.onChange(this.snapshot()); }
  _report(error) { this.error = error?.message || String(error); this._emit(); }
  clearError() { this.error = null; this._emit(); }
  _source(id) {
    const source = this.sources.find((item) => item.id === id);
    if (!source) throw new Error('That source is no longer available.');
    return source;
  }
  getElement(id) { return this._source(id).element || null; }

  setCaptureLocked(locked) { this._captureLocked = Boolean(locked); }

  async _deviceOperation(operation) {
    this._deviceBusy += 1; this._emit();
    try { return await operation(); }
    finally { this._deviceBusy -= 1; this._emit(); }
  }

  _trackDetails(track) {
    if (!track) return { settings: {}, capabilities: {} };
    let capabilities = {};
    try { capabilities = track.getCapabilities?.() || {}; } catch { /* Some browser tracks expose settings only. */ }
    return { settings: track.getSettings?.() || {}, capabilities };
  }

  _cameraInfo(source) {
    const track = source.stream?.getVideoTracks()[0];
    const { settings, capabilities } = this._trackDetails(track);
    const zoom = capabilities.zoom;
    return {
      kind: source.captureKind || 'camera', label: track?.label || source.name,
      width: settings.width, height: settings.height, frameRate: settings.frameRate,
      deviceId: settings.deviceId || '', facingMode: settings.facingMode,
      zoom: typeof settings.zoom === 'number' ? settings.zoom : null,
      zoomRange: zoom && Number.isFinite(zoom.min) && Number.isFinite(zoom.max) && zoom.max > zoom.min
        ? { min: zoom.min, max: zoom.max, step: Number.isFinite(zoom.step) && zoom.step > 0 ? zoom.step : 0.1 } : null,
      torchSupported: capabilities.torch === true,
      torch: typeof settings.torch === 'boolean' ? settings.torch : null,
      live: track?.readyState === 'live' && !source.ended,
    };
  }

  _microphoneInfo() {
    const track = this._micStream?.getAudioTracks()[0];
    const { settings, capabilities } = this._trackDetails(track);
    const canToggle = key => Array.isArray(capabilities[key]) && capabilities[key].includes(true) && capabilities[key].includes(false);
    return {
      label: track?.label || '', deviceId: settings.deviceId || '', sampleRate: settings.sampleRate,
      channelCount: settings.channelCount, echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      echoControl: canToggle('echoCancellation'), noiseControl: canToggle('noiseSuppression'),
    };
  }

  rememberInput(kind, selection) {
    if (!INPUT_KINDS.includes(kind)) throw new Error('Choose a camera or microphone preference.');
    const preference = cleanInputPreference(selection, kind);
    if (!preference) throw new Error('Choose an available input with a valid device ID.');
    this.inputPreferences = { ...this.inputPreferences, [kind]: preference };
    this._inputPreferenceVersions[kind]++;
    try { globalThis.localStorage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify(this.inputPreferences)); this.inputPreferencesPersistent = true; }
    catch { this.inputPreferencesPersistent = false; }
    this._emit();
  }

  _rememberTrack(kind, track, selection, version) {
    if (version !== this._inputPreferenceVersions[kind]) return;
    const settings = track?.getSettings?.() || {};
    const preference = cleanInputPreference({ id: settings.deviceId || selection?.id,
      label: track?.label || selection?.label || '', facingMode: settings.facingMode || selection?.facingMode }, kind);
    if (preference) this.rememberInput(kind, preference);
  }

  /** Passive discovery: no permission request, capture, or busy state. */
  async refreshInputs() {
    const unavailable = { videoinput: null, audioinput: null };
    if (this._destroyed || !navigator.mediaDevices?.enumerateDevices) return unavailable;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return Object.fromEntries(INPUT_KINDS.map(kind => {
        const usable = devices.filter(device => device.kind === kind && device.deviceId && device.label)
          .map(device => ({ id: device.deviceId, label: device.label }));
        return [kind, usable.length ? usable : null];
      }));
    } catch { return unavailable; }
  }

  async _resolveInput(kind, preference) {
    if (!preference) return null;
    const devices = (await this.refreshInputs())[kind];
    if (!devices) return { ...preference }; // Explicit reconnect still uses an exact ID if permission redacts the list.
    const exact = devices.find(device => device.id === preference.id);
    if (exact) return { ...preference, ...exact };
    const matches = preference.label ? devices.filter(device => device.label === preference.label) : [];
    if (matches.length === 1) return { ...preference, ...matches[0] };
    throw new Error(`The saved ${inputName(kind)}${preference.label ? ` “${preference.label}”` : ''} is ${matches.length > 1 ? 'ambiguous' : 'unavailable'}. Open Devices and choose the input again.`);
  }

  async _cameraSelection(options) {
    if (Object.hasOwn(options, 'deviceId')) {
      if (typeof options.deviceId !== 'string' || !options.deviceId) throw new Error('Choose an available camera input.');
      const saved = this.inputPreferences.videoinput;
      return this._resolveInput('videoinput', { ...(saved?.id === options.deviceId ? saved : {}), id: options.deviceId, label: saved?.id === options.deviceId ? saved.label : '' });
    }
    if (Object.hasOwn(options, 'facingMode')) return { facingMode: options.facingMode };
    return this._resolveInput('videoinput', this.inputPreferences.videoinput);
  }

  _assertInputChangeAllowed() {
    if (this._destroyed) throw new Error('This studio has been closed.');
    if (this._captureLocked) throw new Error('Stop recording, streaming, and replay before connecting or changing camera inputs.');
  }

  async _openInput(constraints, kind, selection) {
    try { return await navigator.mediaDevices.getUserMedia(constraints); }
    catch (error) {
      if (selection?.id && ['NotFoundError', 'OverconstrainedError'].includes(error.name)) {
        throw new Error(`The selected ${inputName(kind)}${selection.label ? ` “${selection.label}”` : ''} is unavailable. Open Devices and choose the input again.`);
      }
      throw error; // Permission failures never cause a request for a different input.
    }
  }

  reconnectInputs() {
    try { this._assertInputChangeAllowed(); } catch (error) { return Promise.reject(error); }
    if (this._reconnectPromise) return this._reconnectPromise;
    const micGeneration = this._micGeneration;
    this._reconnectPromise = this._deviceOperation(async () => {
      if (this.inputPreferences.videoinput && !this.sources.some(source => source.captureKind === 'camera' && source.stream?.active)) {
        await this.addCamera();
      }
      this._assertInputChangeAllowed();
      if (this.inputPreferences.audioinput && !this.micEnabled) {
        if (micGeneration !== this._micGeneration) throw new Error('Microphone reconnect was canceled. Your camera remains available.');
        try { await this.setMic(true, {}, { requireUnlocked: true }); }
        catch (error) { throw new Error(`${error.message} Any connected camera remains available; choose the microphone in Devices to retry.`); }
      }
    }).finally(() => { this._reconnectPromise = null; });
    return this._reconnectPromise;
  }

  /** Explicit permission action; reuse already-visible devices and release temporary capture. */
  async discoverInputs(kind) {
    if (!INPUT_KINDS.includes(kind)) throw new Error('Choose camera or microphone input discovery.');
    if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices.enumerateDevices) throw new Error('Device selection requires browser camera/microphone support on localhost or HTTPS.');
    return this._deviceOperation(async () => {
      const visible = (await this.refreshInputs())[kind];
      if (visible) return visible;
      if (this._destroyed) throw new Error('This studio has been closed.');
      const alreadyActive = kind === 'videoinput' ? this.sources.some(source => source.captureKind === 'camera' && source.stream?.active) : this.micEnabled;
      let permissionStream;
      try {
        if (!alreadyActive && this._captureLocked) throw new Error('Stop recording, streaming, and replay before requesting access to another input.');
        if (!alreadyActive) permissionStream = await navigator.mediaDevices.getUserMedia(kind === 'videoinput' ? { video: true, audio: false } : { video: false, audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(device => device.kind === kind).map((device, index) => ({
          id: device.deviceId, label: device.label || `${kind === 'videoinput' ? 'Camera' : 'Microphone'} ${index + 1}`,
        }));
      } finally { permissionStream?.getTracks().forEach(track => track.stop()); }
    });
  }

  capabilities() {
    const canvasCapture = typeof this.canvas.captureStream === 'function';
    const mimeType = recordingMimeType();
    return {
      canvasCapture,
      recording: canvasCapture && Boolean(mimeType),
      webmRecording: canvasCapture && mimeType.startsWith('video/webm'),
      camera: typeof navigator.mediaDevices?.getUserMedia === 'function',
      microphone: typeof navigator.mediaDevices?.getUserMedia === 'function',
      screen: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
    };
  }

  /** End cached video output before resizing; callers must stop external recorders first. */
  setQuality(quality) {
    if (!Object.hasOwn(QUALITY_PROFILES, quality)) throw new Error('Choose a light, standard, or high quality profile.');
    if (quality === this.quality) return;
    if (this._replay.active || this._replay.recorder) throw new Error('Stop the replay buffer before changing output quality.');
    if (this._destroyed) throw new Error('This studio has been closed.');
    this._programStream?.getVideoTracks().forEach((track) => track.stop());
    this._programStream = null;
    this.quality = quality;
    this.canvas.width = QUALITY_PROFILES[quality].width;
    this.canvas.height = QUALITY_PROFILES[quality].height;
    this._lastFrame = -Infinity;
    this._render(performance.now());
    this._emit();
  }

  getStream() {
    if (this._destroyed) throw new Error('This studio has been closed.');
    if (!this.canvas.captureStream) throw new Error('Canvas recording is unavailable in this browser.');
    if (!this._programStream) {
      this._programStream = this.canvas.captureStream(QUALITY_PROFILES[this.quality].fps);
      for (const track of this.destination.stream.getAudioTracks()) this._programStream.addTrack(track);
    }
    return this._programStream;
  }

  setOverlay(partial) {
    const textKeys = ['home', 'away', 'period', 'clock', 'lowerThird', 'sponsorText'];
    const boolKeys = ['visible', 'lowerVisible', 'sponsorVisible'];
    const next = { ...this.overlay };
    for (const key of textKeys) if (key in partial) next[key] = String(partial[key]).slice(0, key === 'lowerThird' ? 160 : key === 'sponsorText' ? 80 : 30);
    for (const key of boolKeys) if (key in partial) next[key] = Boolean(partial[key]);
    for (const key of ['homeScore', 'awayScore']) if (key in partial) next[key] = Math.floor(clamp(partial[key], 0, 999));
    for (const [key, min, max] of [['raceTo', 1, 99], ['down', 1, 4], ['distance', 0, 99], ['homeFouls', 0, 9], ['awayFouls', 0, 9]]) {
      if (key in partial) next[key] = Math.floor(clamp(partial[key], min, max));
    }
    for (const [key, options] of [
      ['preset', ['classic', 'basketball', 'football', 'soccer', 'pool']],
      ['possession', ['home', 'away', 'none']], ['graphicMode', ['scoreboard', 'matchup']],
    ]) {
      if (key in partial) {
        if (!options.includes(partial[key])) throw new Error(`Unsupported ${key}: ${partial[key]}`);
        next[key] = partial[key];
      }
    }
    this.overlay = next;
    this._render(performance.now());
    this._emit();
  }

  async addFile(file) {
    await this.init();
    const name = file.name || 'Local media';
    const ext = name.split('.').pop().toLowerCase();
    let type = file.type.split('/')[0];
    if (!['image', 'audio', 'video'].includes(type)) {
      if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) type = 'image';
      else if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext)) type = 'audio';
      else if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) type = 'video';
      else throw new Error('Choose a local image, audio clip, or video clip.');
    }
    const url = URL.createObjectURL(file);
    const source = { id: sourceId(), name, type, volume: 1, url };
    try {
      if (type === 'image') {
        source.element = new Image();
        const ready = waitForMedia(source.element, 'load');
        source.element.src = url;
        await ready;
      } else {
        const element = document.createElement(type);
        source.element = element;
        element.preload = 'auto';
        element.playsInline = true;
        element.loop = type === 'video';
        const ready = waitForMedia(element, 'loadeddata');
        element.src = url;
        element.load();
        await ready;
        source.audioNode = this.audio.createMediaElementSource(element);
        source.gain = this.audio.createGain();
        source.gain.gain.value = 0;
        source.audioNode.connect(source.gain);
        source.gain.connect(this.mediaBus);
        for (const event of ['play', 'pause', 'ended']) element.addEventListener(event, () => this._emit());
        element.addEventListener('error', () => this._report(new Error(`Playback failed for ${name}. Try another format.`)));
      }
      if (this._destroyed) throw new Error('The studio was closed while importing media.');
      this.sources.push(source);
      if (type !== 'audio') this.previewId = source.id;
      this._routeSources();
      this._emit();
      if (type === 'video') {
        try { await source.element.play(); }
        catch { this._report(new Error(`${name} was imported. Press its play button to start playback.`)); }
      }
      return { id: source.id, name, type };
    } catch (error) {
      source.audioNode?.disconnect();
      source.gain?.disconnect();
      source.element?.pause?.();
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  async _prepareCapture(stream, name, captureKind = 'camera') {
    const element = document.createElement('video');
    element.autoplay = true;
    element.muted = true;
    element.playsInline = true;
    try {
      const ready = waitForMedia(element, 'loadeddata');
      element.srcObject = stream;
      await Promise.all([ready, element.play()]);
      if (this._destroyed) throw new Error('The studio was closed while opening the source.');
      const source = { id: sourceId(), name, type: 'camera', captureKind, volume: 0, stream, element };
      for (const track of stream.getTracks()) track.addEventListener('ended', () => {
        if (!this.sources.includes(source) || source.switching) return;
        source.ended = true;
        this._report(new Error(`${name} disconnected. Re-add it to resume capture.`));
      });
      return source;
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      element.srcObject = null;
      throw error;
    }
  }

  async _addCapture(stream, name, captureKind = 'camera') {
    const source = await this._prepareCapture(stream, name, captureKind);
    this.sources.push(source); this.previewId = source.id; this._emit();
    return { id: source.id, name: source.name, type: source.type };
  }

  _cameraConstraints({ facingMode = 'environment', deviceId } = {}) {
    return { video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facingMode } }),
      width: { ideal: this.canvas.width }, height: { ideal: this.canvas.height },
      frameRate: { ideal: QUALITY_PROFILES[this.quality].fps, max: QUALITY_PROFILES[this.quality].fps },
    }, audio: false };
  }

  async addCamera(options = {}) {
    this._assertInputChangeAllowed();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires localhost or HTTPS and a browser with capture support.');
    const version = this._inputPreferenceVersions.videoinput;
    return this._deviceOperation(async () => {
      await this.init();
      const selection = await this._cameraSelection(options);
      this._assertInputChangeAllowed();
      const chosen = { ...options, ...(selection?.id ? { deviceId: selection.id } : {}), ...(selection?.facingMode ? { facingMode: selection.facingMode } : {}) };
      const stream = await this._openInput(this._cameraConstraints(chosen), 'videoinput', selection);
      try {
        this._assertInputChangeAllowed();
        const source = await this._prepareCapture(stream, chosen.deviceId ? stream.getVideoTracks()[0]?.label || 'Camera' : chosen.facingMode === 'user' ? 'Front camera' : 'Camera');
        try { this._assertInputChangeAllowed(); }
        catch (error) { this._releaseSource(source); throw error; }
        this.sources.push(source); this.previewId = source.id;
        this._rememberTrack('videoinput', stream.getVideoTracks()[0], selection, version);
        this._emit();
        return { id: source.id, name: source.name, type: source.type };
      } catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
    });
  }

  async switchCamera(id, options) {
    this._assertInputChangeAllowed();
    const previous = this._source(id);
    if (previous.captureKind !== 'camera') throw new Error('Select a camera source to change its input.');
    if (previous.switching) throw new Error('This camera is already switching inputs.');
    const version = this._inputPreferenceVersions.videoinput;
    return this._deviceOperation(async () => {
      const selection = await this._cameraSelection(options || {});
      this._assertInputChangeAllowed();
      if (!this.sources.includes(previous) || previous.switching) throw new Error('The camera input changed while its device list was refreshing.');
      const oldSettings = this._cameraInfo(previous);
      previous.switching = true;
      // Android cameras may be exclusive: release the old input before opening its replacement.
      previous.stream.getTracks().forEach(track => track.stop());
      this._emit();
      const replace = async cameraOptions => {
        const stream = await this._openInput(this._cameraConstraints(cameraOptions), 'videoinput', { id: cameraOptions.deviceId, label: selection?.label });
        if (this._destroyed || this._captureLocked) { stream.getTracks().forEach(track => track.stop()); this._assertInputChangeAllowed(); }
        const next = await this._prepareCapture(stream, stream.getVideoTracks()[0]?.label || 'Camera');
        const index = this.sources.indexOf(previous);
        if (index === -1 || this._destroyed || this._captureLocked) { this._releaseSource(next); throw new Error('The camera source changed or output started while its input was opening.'); }
        next.id = id; this.sources[index] = next; this._releaseSource(previous); this._emit();
        return next;
      };
      try {
        const next = await replace({ ...(options || {}), ...(selection?.id ? { deviceId: selection.id } : {}), ...(selection?.facingMode ? { facingMode: selection.facingMode } : {}) });
        this._rememberTrack('videoinput', next.stream.getVideoTracks()[0], selection, version);
      }
      catch (error) {
        if (this._destroyed || !this.sources.includes(previous)) throw error;
        if (this._captureLocked || ['NotAllowedError', 'SecurityError'].includes(error.name)) {
          previous.ended = true; previous.switching = false; this._emit(); throw error;
        }
        try { await replace({ deviceId: oldSettings.deviceId, facingMode: oldSettings.facingMode }); }
        catch { previous.ended = true; previous.switching = false; this._emit(); throw new Error(`Camera switch failed: ${error.message}. Re-add the camera to resume capture.`); }
        throw new Error(`Camera switch failed: ${error.message}. The previous input was restored.`);
      }
    });
  }

  _releaseSource(source) {
    source.audioNode?.disconnect(); source.gain?.disconnect();
    source.stream?.getTracks().forEach(track => track.stop());
    source.element?.pause?.();
    if (source.element && 'srcObject' in source.element) source.element.srcObject = null;
    source.element?.removeAttribute?.('src');
    if (source.url) URL.revokeObjectURL(source.url);
  }

  removeSource(id) {
    const source = this._source(id);
    if (id === 'slate') throw new Error('The holding slate is always available.');
    if (this._captureLocked && source.type === 'camera') throw new Error('Stop recording, streaming, and replay before removing a camera input.');
    if (source.switching) throw new Error('Wait for the camera input switch to finish.');
    this.sources = this.sources.filter(item => item !== source);
    if (this.programId === id) this.programId = 'slate';
    if (this.previewId === id) this.previewId = 'slate';
    if (this.insetId === id) this.insetId = null;
    this._releaseSource(source); this._routeSources(); this._render(performance.now()); this._emit();
  }

  setCameraControls(id, patch) {
    const source = this._source(id);
    const info = this._cameraInfo(source);
    if (!info.live || source.switching) return Promise.reject(new Error('This camera input is not active.'));
    const controls = {};
    if ('zoom' in patch) {
      if (!info.zoomRange) return Promise.reject(new Error('This camera does not report zoom control.'));
      controls.zoom = clamp(patch.zoom, info.zoomRange.min, info.zoomRange.max);
    }
    if ('torch' in patch) {
      if (!info.torchSupported) return Promise.reject(new Error('This camera does not report torch control.'));
      controls.torch = Boolean(patch.torch);
    }
    const existing = this._cameraControlWork.get(id);
    if (existing) { existing.pending = { ...existing.pending, ...controls }; return existing.promise; }
    const work = { pending: controls };
    this._cameraControlWork.set(id, work);
    work.promise = (async () => {
      try {
        while (work.pending) {
          const desired = work.pending; work.pending = null;
          const currentSource = this._source(id);
          if (currentSource !== source || currentSource.switching) throw new Error('The camera changed while applying its controls.');
          const track = source.stream.getVideoTracks()[0];
          const constraints = track.getConstraints();
          const advanced = (constraints.advanced || []).map(item => Object.fromEntries(Object.entries(item).filter(([key]) => !(key in desired)))).filter(item => Object.keys(item).length);
          await track.applyConstraints({ ...constraints, advanced: [...advanced, desired] });
          const actual = track.getSettings();
          this._emit();
          if ('torch' in desired && actual.torch !== desired.torch) throw new Error('The camera did not apply the requested torch setting.');
          if ('zoom' in desired && (typeof actual.zoom !== 'number' || Math.abs(actual.zoom - desired.zoom) > info.zoomRange.step + 0.01)) throw new Error('The camera did not apply the requested zoom setting.');
        }
      } finally { this._cameraControlWork.delete(id); }
    })();
    return work.promise;
  }

  async addScreen() {
    await this.init();
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen capture is unavailable here. Use camera or local video sources.');
    const fps = QUALITY_PROFILES[this.quality].fps;
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: fps, max: fps } }, audio: false });
    return this._addCapture(stream, 'Screen capture', 'screen');
  }

  setPreview(id) {
    const source = this._source(id);
    if (source.type === 'audio') throw new Error('Audio clips use their mixer play control. Select a camera, video, or image for preview.');
    this.previewId = id;
    this._emit();
  }

  setProgram(id) {
    const source = this._source(id);
    if (source.type === 'audio') throw new Error('Audio clips are mix-only. Choose a camera, video, image, or replay for program.');
    const previousProgram = this.programId;
    this.programId = id;
    if (this.previewId === id) this.previewId = previousProgram;
    this._routeSources();
    this._render(performance.now());
    this._emit();
  }

  markReplay(id) {
    const source = this._source(id);
    if (!['video', 'replay'].includes(source.type)) throw new Error('Only a video clip can be marked as a replay.');
    source.type = 'replay';
    this._emit();
  }

  setInset(id) {
    if (id !== null) {
      const source = this._source(id);
      if (!['camera', 'video', 'replay', 'image'].includes(source.type)) throw new Error('Choose a camera, video, or image for the inset.');
    }
    this.insetId = id;
    this._render(performance.now());
    this._emit();
  }

  take() {
    this._source(this.previewId);
    const previous = this.programId;
    this.programId = this.previewId;
    this.previewId = previous;
    this._routeSources();
    this._render(performance.now());
    this._emit();
  }

  _routeSources() {
    for (const source of this.sources) {
      if (!source.gain) continue;
      const audible = source.type === 'audio' || source.id === this.programId;
      source.gain.gain.setTargetAtTime(audible ? source.volume : 0, this.audio.currentTime, 0.015);
    }
  }

  setSourceVolume(id, volume) { this._source(id).volume = clamp(volume); this._routeSources(); this._emit(); }
  setMasterVolume(volume) {
    this.masterVolume = clamp(volume);
    this.master.gain.setTargetAtTime(this.masterVolume, this.audio.currentTime, 0.015);
    this._emit();
  }
  setMonitorVolume(volume) { this.monitor.gain.setTargetAtTime(clamp(volume), this.audio.currentTime, 0.015); }
  setMediaVolume(volume) {
    this.mediaVolume = clamp(volume);
    this.mediaBus.gain.setTargetAtTime(this.mediaVolume * (this._ducked ? 0.25 : 1), this.audio.currentTime, 0.015);
    this._emit();
  }
  setMicVolume(volume) {
    this.micVolume = clamp(volume);
    this.micGain.gain.setTargetAtTime(this.micVolume, this.audio.currentTime, 0.015);
    this._emit();
  }

  async setMic(enabled, options = {}, { requireUnlocked = false } = {}) {
    if (enabled && requireUnlocked) this._assertInputChangeAllowed();
    if (enabled && this.micEnabled && !Object.keys(options).length) return;
    if (enabled && this.micEnabled && this._captureLocked) throw new Error('Stop recording, streaming, and replay before switching microphone inputs.');
    const generation = ++this._micGeneration;
    if (!enabled) {
      this._micNode?.disconnect();
      this._micNode = null;
      this._micStream?.getTracks().forEach((track) => track.stop());
      this._micStream = null;
      this.micEnabled = false;
      this._emit();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires localhost or HTTPS and a browser with capture support.');
    const version = this._inputPreferenceVersions.audioinput;
    return this._deviceOperation(async () => {
      await this.init();
      const current = this._microphoneInfo();
      const saved = this.inputPreferences.audioinput;
      if (Object.hasOwn(options, 'deviceId') && (typeof options.deviceId !== 'string' || !options.deviceId)) throw new Error('Choose an available microphone input.');
      const preference = Object.hasOwn(options, 'deviceId')
        ? { id: options.deviceId, label: saved?.id === options.deviceId ? saved.label : '' }
        : this.micEnabled && current.deviceId ? { id: current.deviceId, label: current.label } : saved;
      const selection = await this._resolveInput('audioinput', preference);
      if (generation !== this._micGeneration || this._destroyed) return;
      if (requireUnlocked || this.micEnabled) this._assertInputChangeAllowed();
      const { deviceId: previousDeviceId, ...previousProcessing } = this._micOptions;
      const { deviceId: requestedDeviceId, ...processingOptions } = options;
      const processing = { ...previousProcessing, ...processingOptions };
      const deviceId = selection?.id;
      const requested = { ...processing, ...(deviceId ? { deviceId } : {}) };
      const wasEnabled = this.micEnabled;
      const stream = await this._openInput({ audio: { ...processing, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false }, 'audioinput', selection);
      if (generation !== this._micGeneration || this._destroyed) { stream.getTracks().forEach(track => track.stop()); return; }
      if ((requireUnlocked || wasEnabled) && this._captureLocked) { stream.getTracks().forEach(track => track.stop()); throw new Error('Output started while the microphone was connecting. Stop output before reconnecting inputs.'); }
      let nextNode;
      try { nextNode = this.audio.createMediaStreamSource(stream); nextNode.connect(this.micGain); }
      catch (error) { nextNode?.disconnect(); stream.getTracks().forEach(track => track.stop()); throw error; }
      const previousNode = this._micNode, previousStream = this._micStream;
      this._micNode = nextNode; this._micStream = stream; this._micOptions = requested; this.micEnabled = true;
      previousNode?.disconnect(); previousStream?.getTracks().forEach(track => track.stop());
      this._rememberTrack('audioinput', stream.getAudioTracks()[0], selection, version);
      for (const track of stream.getTracks()) track.addEventListener('ended', () => {
        if (this._micStream !== stream) return;
        this._micNode?.disconnect(); this._micNode = null; this._micStream = null; this.micEnabled = false;
        this._report(new Error('The microphone disconnected. Enable it again to resume commentary.'));
      });
      this._emit();
    });
  }

  async setMicProcessing(patch) {
    const track = this._micStream?.getAudioTracks()[0];
    if (!track || !this.micEnabled) throw new Error('Enable a microphone before changing its processing.');
    const generation = this._micGeneration;
    const info = this._microphoneInfo();
    const desired = {};
    for (const [key, supported] of [['echoCancellation', info.echoControl], ['noiseSuppression', info.noiseControl]]) {
      if (key in patch) {
        if (!supported) throw new Error(`This microphone does not report ${key === 'echoCancellation' ? 'echo cancellation' : 'noise suppression'} control.`);
        desired[key] = Boolean(patch[key]);
      }
    }
    try { await track.applyConstraints({ ...track.getConstraints(), ...desired }); }
    catch (error) { if (!['OverconstrainedError', 'NotSupportedError'].includes(error.name)) throw error; }
    if (generation !== this._micGeneration || this._destroyed || this._micStream?.getAudioTracks()[0] !== track) return;
    let actual = track.getSettings();
    if (Object.keys(desired).some(key => actual[key] !== desired[key])) {
      if (this._captureLocked) throw new Error('This browser needs to reopen the microphone to change processing. Stop recording, streaming, and replay first.');
      // Some browsers advertise processing support but only apply it when opening an input.
      const replacementGeneration = this._micGeneration + 1;
      await this.setMic(true, desired);
      if (this._micGeneration !== replacementGeneration || !this._micStream || this._destroyed) return;
      actual = this._micStream.getAudioTracks()[0].getSettings();
    }
    this._micOptions = { ...this._micOptions, ...Object.fromEntries(Object.keys(desired).map(key => [key, actual[key]])) };
    this._emit();
    for (const key of Object.keys(desired)) if (actual[key] !== desired[key]) throw new Error('The microphone did not apply the requested processing setting.');
  }

  setDucking(enabled) { this.ducking = Boolean(enabled); this._emit(); }
  _level(analyser, values) {
    analyser.getFloatTimeDomainData(values);
    let power = 0;
    for (const sample of values) power += sample * sample;
    return clamp(Math.sqrt(power / values.length) * 3);
  }
  meters() {
    return {
      master: this._level(this.masterAnalyser, this._masterSamples),
      mic: this.micEnabled ? this._level(this.micAnalyser, this._micSamples) : 0,
    };
  }
  _updateDucking() {
    const talking = this.ducking && this.micEnabled && this._level(this.micAnalyser, this._micSamples) > 0.06;
    if (talking) this._lastVoice = performance.now();
    const lower = this.ducking && this.micEnabled && performance.now() - (this._lastVoice || -1000) < 450;
    if (lower !== this._ducked) {
      this._ducked = lower;
      this.mediaBus.gain.setTargetAtTime(this.mediaVolume * (lower ? 0.25 : 1), this.audio.currentTime, lower ? 0.04 : 0.25);
    }
  }

  async toggleSource(id) {
    await this.init();
    const source = this._source(id);
    if (!['audio', 'video', 'replay'].includes(source.type)) throw new Error('This source does not have playback controls.');
    if (source.element.paused) await source.element.play();
    else source.element.pause();
    this._emit();
  }

  seekSource(id, seconds) {
    const source = this._source(id);
    if (!['audio', 'video', 'replay'].includes(source.type)) throw new Error('This source cannot be scrubbed.');
    if (!Number.isFinite(source.element.duration)) throw new Error('This clip is not ready for seeking.');
    source.element.currentTime = clamp(seconds, 0, source.element.duration);
    this._emit();
  }

  async playTone(kind = 'sting') {
    await this.init();
    const notes = kind === 'whistle' ? [[1800, 0, 0.17], [2000, 0.18, 0.22]]
      : kind === 'buzzer' ? [[145, 0, 0.8], [152, 0, 0.8]]
        : kind === 'goal' || kind === 'cheer' ? [[523.25, 0, 0.18], [659.25, 0.13, 0.18], [783.99, 0.26, 0.18], [1046.5, 0.39, 0.48]]
          : [[392, 0, 0.15], [523.25, 0.12, 0.15], [783.99, 0.24, 0.35]];
    for (const [frequency, delay, duration] of notes) {
      const oscillator = this.audio.createOscillator();
      const gain = this.audio.createGain();
      oscillator.type = kind === 'buzzer' ? 'sawtooth' : 'sine';
      oscillator.frequency.value = frequency;
      const start = this.audio.currentTime + delay;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(kind === 'buzzer' ? 0.09 : 0.18, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
      oscillator.connect(gain);
      gain.connect(this.master);
      gain.connect(this.monitor);
      this._toneNodes.add(oscillator);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this._toneNodes.delete(oscillator); };
      oscillator.start(start);
      oscillator.stop(start + duration + 0.03);
    }
  }

  stopAudio() {
    for (const oscillator of this._toneNodes) { try { oscillator.stop(); } catch { /* Already ended. */ } }
    for (const source of this.sources) if (source.type === 'audio') source.element.pause();
    this._emit();
  }

  async startReplayBuffer() {
    await this.init();
    if (this._replay.active) return;
    if (typeof MediaRecorder === 'undefined') throw new Error('This browser does not support local video recording.');
    if (this._replay.recorder) await this._rotateReplay();
    this._replay.active = true;
    try { this._beginReplaySegment(); }
    catch (error) { this._replay.active = false; throw error; }
    this._emit();
  }

  _beginReplaySegment() {
    if (!this._replay.active || this._destroyed) return;
    const chunks = [];
    const mimeType = recordingMimeType();
    const recorder = new MediaRecorder(this.getStream(), {
      ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: QUALITY_PROFILES[this.quality].bitrate, audioBitsPerSecond: 96_000,
    });
    this._replay.recorder = recorder;
    this._replay.started = performance.now();
    let capturedBytes = 0;
    recorder.ondataavailable = (event) => {
      if (event.data?.size) { chunks.push(event.data); capturedBytes += event.data.size; }
      // A backgrounded tab can delay its segment timer; cap its retained chunks too.
      if (capturedBytes > MAX_REPLAY_BYTES && recorder.state !== 'inactive') recorder.stop();
    };
    recorder.onerror = (event) => {
      this._replay.active = false;
      clearTimeout(this._replay.timer);
      const error = event.error || new Error('The replay recorder failed.');
      this._replay.pending?.reject(error);
      this._replay.pending = null;
      this._report(error);
    };
    recorder.onstop = () => {
      clearTimeout(this._replay.timer);
      const duration = (performance.now() - this._replay.started) / 1000;
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' });
      const segment = { blob, duration };
      this._replay.recorder = null;
      if (!this._destroyed && blob.size && blob.size <= MAX_REPLAY_BYTES) {
        this._replay.segments.push(segment);
        while (this._replay.segments.length > 3 || this._replay.segments.reduce((sum, item) => sum + item.blob.size, 0) > MAX_REPLAY_BYTES) this._replay.segments.shift();
      }
      const pending = this._replay.pending;
      this._replay.pending = null;
      if (blob.size && !this._destroyed) pending?.resolve(segment);
      else pending?.reject(new Error('The replay segment contained no media. Try again after a few seconds.'));
      if (this._replay.active && !this._destroyed) {
        try { this._beginReplaySegment(); }
        catch (error) { this._replay.active = false; this._report(error); }
      }
      this._emit();
    };
    try { recorder.start(1000); }
    catch (error) {
      this._replay.recorder = null;
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      throw error;
    }
    this._replay.timer = setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, SEGMENT_MS);
  }

  _rotateReplay() {
    if (this._replay.pending) return this._replay.pending.promise;
    const recorder = this._replay.recorder;
    if (!recorder) return Promise.resolve(this._replay.segments.at(-1));
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    this._replay.pending = { promise, resolve, reject };
    clearTimeout(this._replay.timer);
    if (recorder.state !== 'inactive') recorder.stop();
    return promise;
  }

  async captureReplay() {
    if (!this._replay.active && !this._replay.segments.length) throw new Error('Enable the replay buffer first, then let it capture at least two seconds.');
    const age = (performance.now() - (this._replay.started || performance.now())) / 1000;
    if (this._replay.recorder && age >= 2) return this._rotateReplay();
    const latest = this._replay.segments.at(-1);
    if (latest) return latest;
    throw new Error('Replay is warming up. Let it capture at least two seconds.');
  }

  async stopReplayBuffer() {
    this._replay.active = false;
    clearTimeout(this._replay.timer);
    if (this._replay.recorder) await this._rotateReplay();
    this._emit();
  }

  _render(time) {
    this.ctx.save();
    this.ctx.scale(this.canvas.width / WIDTH, this.canvas.height / HEIGHT);
    this._drawComposition(this.ctx, this.programId, time);
    this.ctx.restore();
  }

  drawPreview(ctx, width = ctx.canvas.width, height = ctx.canvas.height) {
    ctx.save();
    ctx.scale(width / WIDTH, height / HEIGHT);
    this._drawComposition(ctx, this.previewId, performance.now());
    ctx.restore();
  }

  _drawComposition(ctx, id, time) {
    const source = this.sources.find((item) => item.id === id);
    ctx.fillStyle = '#0c0e10';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    if (!source || source.type === 'slate') this._drawSlate(ctx, time);
    else if (source.switching) this._drawMessage(ctx, 'SWITCHING CAMERA', source.name);
    else if (source.ended) this._drawMessage(ctx, 'SOURCE DISCONNECTED', source.name);
    else if (source.element) {
      const element = source.element;
      const width = element.videoWidth || element.naturalWidth;
      const height = element.videoHeight || element.naturalHeight;
      if (width && height && (source.type === 'image' || element.readyState >= 2)) {
        const scale = Math.min(WIDTH / width, HEIGHT / height);
        ctx.drawImage(element, (WIDTH - width * scale) / 2, (HEIGHT - height * scale) / 2, width * scale, height * scale);
      } else this._drawMessage(ctx, 'SOURCE READY', source.name);
    }
    if (this.overlay.visible) {
      if (this.overlay.graphicMode === 'matchup') this._drawMatchup(ctx);
      else this._drawScoreboard(ctx);
    }
    if (this.insetId) this._drawInset(ctx);
    if (source?.type === 'replay') this._drawReplayBadge(ctx, 40, 40);
    if (this.overlay.lowerVisible && this.overlay.lowerThird) this._drawLowerThird(ctx);
    if (this.overlay.sponsorVisible && this.overlay.sponsorText) this._drawSponsor(ctx);
  }

  _drawSlate(ctx, time) {
    ctx.fillStyle = '#0c0e10';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    // A native title slate remains useful with zero imported media or network.
    ctx.save();
    ctx.strokeStyle = '#eadbc411';
    ctx.lineWidth = 1;
    ctx.strokeRect(32, 32, WIDTH - 64, HEIGHT - 64);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#eadbc4';
    ctx.font = '700 180px "Barlow Condensed", "Arial Narrow", sans-serif';
    ctx.fillText('RIVET', WIDTH / 2, 364, 1100);
    ctx.fillStyle = '#ad9f8c';
    ctx.font = '400 32px system-ui, sans-serif';
    ctx.fillText('Your game. Your broadcast.', WIDTH / 2, 418);
    ctx.fillStyle = '#c77340';
    ctx.fillRect(610, 460, 60, 3);
    ctx.restore();
  }

  _drawMessage(ctx, title, subtitle) {
    ctx.save(); ctx.textAlign = 'center';
    ctx.fillStyle = '#eaf0ed'; ctx.font = '700 35px system-ui, sans-serif'; ctx.fillText(title, 640, 345);
    ctx.fillStyle = '#81948c'; ctx.font = '400 20px system-ui, sans-serif'; ctx.fillText(subtitle, 640, 386, 1100);
    ctx.restore();
  }

  _drawScoreboard(ctx) {
    const o = this.overlay;
    ctx.save();
    const metadata = this._sportMetadata();
    if (metadata) {
      ctx.fillStyle = '#181411ed'; ctx.fillRect(160, 545, 960, 36);
      ctx.fillStyle = '#c5ac91'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '600 22px "Barlow Condensed", sans-serif'; ctx.fillText(metadata, 640, 563, 910);
    }
    ctx.fillStyle = '#080a0ded'; ctx.fillRect(160, 581, 960, 95);
    ctx.fillStyle = '#c77340'; ctx.fillRect(160, 581, 5, 95); ctx.fillRect(1115, 581, 5, 95);
    ctx.font = '700 40px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#eadbc4'; ctx.textBaseline = 'middle';
    ctx.fillText(o.home.toUpperCase(), 190, 631, 235);
    ctx.fillStyle = '#c77340'; ctx.font = '700 52px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'center'; ctx.fillText(String(o.homeScore), 475, 631, 100);
    ctx.fillStyle = '#322923'; ctx.fillRect(534, 581, 212, 95);
    ctx.fillStyle = '#c5ac91'; ctx.font = '600 18px system-ui, sans-serif';
    ctx.fillText(`${this._periodLabel()} ${o.period}`, 640, 603, 190);
    ctx.fillStyle = '#eadbc4'; ctx.font = '700 36px ui-monospace, monospace'; ctx.fillText(o.clock, 640, 644, 190);
    ctx.fillStyle = '#c77340'; ctx.font = '700 52px "Barlow Condensed", sans-serif';
    ctx.fillText(String(o.awayScore), 805, 631, 100);
    ctx.fillStyle = '#eadbc4'; ctx.font = '700 40px "Barlow Condensed", sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(o.away.toUpperCase(), 1090, 631, 235);
    if (o.possession !== 'none') {
      const x = o.possession === 'home' ? 178 : 1102;
      ctx.fillStyle = '#c77340'; ctx.beginPath(); ctx.arc(x, 653, 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  _periodLabel() {
    return { classic: 'PERIOD', basketball: 'QTR', football: 'QTR', soccer: 'HALF', pool: 'RACK' }[this.overlay.preset];
  }

  _sportMetadata() {
    const o = this.overlay;
    const possession = o.possession === 'none' ? '' : `${o[o.possession].toUpperCase()} POSSESSION`;
    const sport = o.preset === 'pool' ? `RACE TO ${o.raceTo}`
      : o.preset === 'football' ? `${['', '1ST', '2ND', '3RD', '4TH'][o.down]} & ${o.distance}`
        : o.preset === 'basketball' ? `FOULS  ${o.homeFouls} — ${o.awayFouls}` : '';
    return [sport, possession].filter(Boolean).join('   •   ');
  }

  _drawMatchup(ctx) {
    const o = this.overlay;
    ctx.save();
    ctx.fillStyle = '#0c0e10'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.strokeStyle = '#eadbc422'; ctx.lineWidth = 1; ctx.strokeRect(40, 40, 1200, 640);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#c77340'; ctx.font = '600 28px "Barlow Condensed", sans-serif';
    ctx.fillText(o.preset === 'classic' ? 'MATCHUP' : o.preset.toUpperCase(), 640, 126);
    ctx.fillStyle = '#eadbc4'; ctx.font = '700 78px "Barlow Condensed", sans-serif';
    ctx.fillText(o.home.toUpperCase(), 326, 267, 475);
    ctx.fillText(o.away.toUpperCase(), 954, 267, 475);
    ctx.fillStyle = '#c77340'; ctx.font = '700 120px "Barlow Condensed", sans-serif';
    ctx.fillText(String(o.homeScore), 326, 386);
    ctx.fillText(String(o.awayScore), 954, 386);
    ctx.fillStyle = '#8c7c6b'; ctx.font = '600 32px "Barlow Condensed", sans-serif'; ctx.fillText('VS', 640, 298);
    ctx.fillStyle = '#eadbc4'; ctx.font = '600 35px ui-monospace, monospace'; ctx.fillText(o.clock, 640, 361, 200);
    ctx.fillStyle = '#ad9f8c'; ctx.font = '600 22px system-ui, sans-serif'; ctx.fillText(`${this._periodLabel()} ${o.period}`, 640, 408, 230);
    ctx.fillStyle = '#c5ac91'; ctx.font = '600 28px "Barlow Condensed", sans-serif'; ctx.fillText(this._sportMetadata(), 640, 588, 1100);
    ctx.restore();
  }

  _drawInset(ctx) {
    const source = this.sources.find((item) => item.id === this.insetId);
    if (!source?.element) return;
    const element = source.element;
    const width = element.videoWidth || element.naturalWidth;
    const height = element.videoHeight || element.naturalHeight;
    const x = 888, y = 44, insetWidth = 352, insetHeight = 198;
    ctx.save();
    ctx.fillStyle = '#0c0e10'; ctx.fillRect(x, y, insetWidth, insetHeight);
    if (!source.ended && width && height && (source.type === 'image' || element.readyState >= 2)) {
      const scale = Math.min(insetWidth / width, insetHeight / height);
      ctx.drawImage(element, x + (insetWidth - width * scale) / 2, y + (insetHeight - height * scale) / 2, width * scale, height * scale);
    } else {
      ctx.fillStyle = '#ad9f8c'; ctx.font = '600 22px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(source.ended ? 'SOURCE DISCONNECTED' : 'SOURCE READY', x + insetWidth / 2, y + insetHeight / 2, insetWidth - 20);
    }
    ctx.strokeStyle = '#c77340'; ctx.lineWidth = 3; ctx.strokeRect(x, y, insetWidth, insetHeight);
    if (source.type === 'replay') this._drawReplayBadge(ctx, x + 6, y + 6, 0.65);
    ctx.restore();
  }

  _drawReplayBadge(ctx, x, y, scale = 1) {
    ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
    ctx.fillStyle = '#c77340'; ctx.fillRect(0, 0, 148, 48);
    ctx.fillStyle = '#0c0e10'; ctx.font = '700 30px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('REPLAY', 74, 25);
    ctx.restore();
  }

  _drawSponsor(ctx) {
    ctx.save();
    ctx.font = '600 21px system-ui, sans-serif';
    const width = Math.min(600, ctx.measureText(this.overlay.sponsorText).width + 30);
    ctx.fillStyle = '#0c0e10e8'; ctx.fillRect(1240 - width, 684, width, 30);
    ctx.fillStyle = '#eadbc4'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(this.overlay.sponsorText, 1225, 699, width - 30);
    ctx.restore();
  }

  _drawLowerThird(ctx) {
    ctx.save();
    ctx.fillStyle = '#101114ee'; ctx.fillRect(160, 462, 960, 70);
    ctx.fillStyle = '#c77340'; ctx.fillRect(160, 462, 5, 70);
    ctx.fillStyle = '#eadbc4'; ctx.font = '700 36px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillText(this.overlay.lowerThird, 184, 497, 910);
    ctx.restore();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    ++this._micGeneration;
    cancelAnimationFrame(this._raf);
    this._replay.active = false;
    clearTimeout(this._replay.timer);
    if (this._replay.recorder?.state !== 'inactive' && this._replay.recorder) this._replay.recorder.stop();
    this._replay.pending?.reject(new Error('The studio closed before the replay was saved.'));
    this._replay.pending = null;
    this._replay.segments = [];
    for (const source of this.sources) {
      source.audioNode?.disconnect();
      source.gain?.disconnect();
      source.stream?.getTracks().forEach((track) => track.stop());
      source.element?.pause?.();
      if (source.element && 'srcObject' in source.element) source.element.srcObject = null;
      if (source.element && source.type !== 'slate') source.element.removeAttribute('src');
      if (source.url) URL.revokeObjectURL(source.url);
    }
    this._micNode?.disconnect();
    this._micStream?.getTracks().forEach((track) => track.stop());
    this._programStream?.getTracks().forEach((track) => track.stop());
    this.destination.stream.getTracks().forEach((track) => track.stop());
    for (const oscillator of this._toneNodes) { try { oscillator.stop(); } catch { /* Already ended. */ } }
    this._silence.stop();
    void this.audio.close();
    this.onChange = () => {};
  }
}
