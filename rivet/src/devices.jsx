import React, { useEffect, useRef, useState } from 'react';
import { Camera, Cpu, Mic, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { api } from './api';

const formatVideo = camera => [
  camera.width && camera.height ? `${camera.width} × ${camera.height}` : null,
  Number.isFinite(camera.frameRate) ? `${Math.round(camera.frameRate * 10) / 10} fps` : null,
  camera.facingMode === 'user' ? 'Front' : camera.facingMode === 'environment' ? 'Rear' : null,
].filter(Boolean).join(' · ');

function DeviceToggle({ label, checked, disabled, onChange }) {
  return <label className="toggle-row"><span>{label}</span><input type="checkbox" role="switch" checked={!!checked} disabled={disabled} onChange={event => onChange(event.target.checked)}/><span className="switch" aria-hidden="true"/></label>;
}

export function CameraControls({ source, engineRef, run, locked, openDevices }) {
  const camera = source.camera;
  if (!camera) return null;
  const unavailable = !camera.live || source.switching;
  return <div className="camera-controls">
    <div className="device-summary"><Camera/><div><strong>{camera.kind === 'screen' ? 'Screen capture' : 'Camera input'}</strong><span>{source.switching ? 'Switching input…' : formatVideo(camera) || 'Waiting for camera settings'}</span></div><i className={camera.live ? 'device-state active' : 'device-state'} aria-label={camera.live ? 'Input active' : 'Input disconnected'}/></div>
    {camera.zoomRange && <label className="camera-zoom"><span>Zoom</span><input aria-label="Camera zoom" type="range" min={camera.zoomRange.min} max={camera.zoomRange.max} step={camera.zoomRange.step} value={camera.zoom ?? camera.zoomRange.min} disabled={unavailable} onChange={event => run(() => engineRef.current.setCameraControls(source.id, { zoom: Number(event.target.value) }))}/><output>{camera.zoom === null ? 'Auto' : `${camera.zoom.toFixed(1)}×`}</output></label>}
    {camera.torchSupported && <DeviceToggle label="Camera torch" checked={camera.torch} disabled={unavailable} onChange={torch => run(() => engineRef.current.setCameraControls(source.id, { torch }))}/>}
    <div className="button-row">{camera.kind === 'camera' && <button disabled={locked || source.switching} onClick={openDevices}><Settings2/>Change input</button>}<button disabled={locked || source.switching} onClick={() => run(() => engineRef.current.removeSource(source.id))}><Trash2/>Remove input</button></div>
    {locked && <p className="device-note">Stop recording, streaming, and replay to change inputs.</p>}
  </div>;
}

function preferredInput(devices, current, activeId, saved) {
  if (devices === null) return current || activeId || saved?.id || '';
  if (current && devices.some(device => device.id === current)) return current;
  if (activeId && devices.some(device => device.id === activeId)) return activeId;
  if (saved) {
    if (devices.some(device => device.id === saved.id)) return saved.id;
    const matches = devices.filter(device => device.label === saved.label);
    return matches.length === 1 ? matches[0].id : '';
  }
  return devices[0]?.id || '';
}

export function SavedInputs({ engineRef, snapshot, run, locked, openDevices }) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const saved = snapshot.inputPreferences || {};
  const camera = saved.videoinput && !snapshot.sources.some(source => source.camera?.kind === 'camera' && source.camera.live);
  const microphone = saved.audioinput && !snapshot.micEnabled;
  if (!camera && !microphone) return null;
  async function reconnect() {
    if (inFlight.current || locked) return;
    inFlight.current = true; setPending(true);
    try { await run(() => engineRef.current.reconnectInputs()); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <div className="saved-inputs">
    <div><strong>{snapshot.inputPreferencesPersistent === false ? 'Reconnect your inputs' : 'Your inputs are saved'}</strong><span>{[camera && saved.videoinput.label, microphone && saved.audioinput.label].filter(Boolean).join(' · ')}</span></div>
    <div className="button-row"><button className="primary" disabled={pending || snapshot.deviceBusy || locked} onClick={reconnect}><RefreshCw/>{pending ? 'Reconnecting…' : 'Reconnect inputs'}</button><button onClick={openDevices}><Settings2/>Change</button></div>
    <p>{snapshot.inputPreferencesPersistent === false ? 'Browser storage is unavailable; choices are remembered for this session. ' : ''}Reconnect to activate them. Your camera opens in Preview.</p>
  </div>;
}

export function DeviceAccess({ engineRef, snapshot, run, locked }) {
  const saved = snapshot.inputPreferences || {};
  const [cameras, setCameras] = useState(null), [microphones, setMicrophones] = useState(null);
  const [cameraId, setCameraId] = useState(() => snapshot.sources.find(source => source.id === snapshot.previewId)?.camera?.deviceId || saved.videoinput?.id || ''), [microphoneId, setMicrophoneId] = useState(() => snapshot.microphone?.deviceId || saved.audioinput?.id || '');
  const [pending, setPending] = useState(false), [refreshing, setRefreshing] = useState(true), [refreshError, setRefreshError] = useState('');
  const refreshVersion = useRef(0);
  const selected = snapshot.sources.find(source => source.id === snapshot.previewId && source.camera?.kind === 'camera');
  const microphone = snapshot.microphone || {};
  const working = pending || snapshot.deviceBusy || refreshing;
  useEffect(() => {
    let mounted = true;
    async function refresh() {
      if (document.visibilityState === 'hidden') return;
      const version = ++refreshVersion.current;
      try {
        const inputs = await engineRef.current.refreshInputs();
        if (!mounted || version !== refreshVersion.current) return;
        const current = engineRef.current.snapshot();
        const camera = current.sources.find(source => source.id === current.previewId && source.camera?.kind === 'camera');
        setCameras(inputs.videoinput); setMicrophones(inputs.audioinput);
        setCameraId(id => preferredInput(inputs.videoinput, id, camera?.camera.deviceId, current.inputPreferences.videoinput));
        setMicrophoneId(id => preferredInput(inputs.audioinput, id, current.microphone?.deviceId, current.inputPreferences.audioinput));
        setRefreshError('');
      } catch { if (mounted && version === refreshVersion.current) setRefreshError('Could not refresh the device list. Your saved choices are still here.'); }
      finally { if (mounted && version === refreshVersion.current) setRefreshing(false); }
    }
    void refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { mounted = false; ++refreshVersion.current; navigator.mediaDevices?.removeEventListener?.('devicechange', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [engineRef]);
  async function act(operation) {
    ++refreshVersion.current; setRefreshing(false); setPending(true);
    try { await run(operation); } finally { setPending(false); }
  }
  async function discover(kind) {
    const devices = await engineRef.current.discoverInputs(kind);
    const current = engineRef.current.snapshot();
    setRefreshError('');
    if (kind === 'videoinput') { setCameras(devices); setCameraId(id => preferredInput(devices, id, selected?.camera?.deviceId, current.inputPreferences.videoinput)); }
    else { setMicrophones(devices); setMicrophoneId(id => preferredInput(devices, id, current.microphone.deviceId, current.inputPreferences.audioinput)); }
  }
  function choose(kind, id, devices) {
    ++refreshVersion.current;
    const device = devices.find(item => item.id === id);
    if (kind === 'videoinput') setCameraId(id); else setMicrophoneId(id);
    if (device) engineRef.current.rememberInput(kind, device);
  }
  const cameraChoices = cameras ?? (saved.videoinput ? [saved.videoinput] : []);
  const microphoneChoices = microphones ?? (saved.audioinput ? [saved.audioinput] : []);
  return <div className="device-access">
    <p className="help">{snapshot.inputPreferencesPersistent === false ? "Browser storage is unavailable; choices are remembered for this session." : "Your choices stay saved in this browser."} Available inputs refresh automatically; permission is requested only when you connect or find an input.</p>
    {refreshError && <p className="device-note" role="status">{refreshError}</p>}
    <section className="device-group"><div className="device-group-title"><Camera/><h3>Camera</h3><button disabled={working} onClick={() => act(() => discover('videoinput'))}><RefreshCw/>{cameras !== null || saved.videoinput ? 'Refresh cameras' : 'Find cameras'}</button></div>
      {cameraChoices.length > 0 ? <><label className="field"><span>Camera input</span><select aria-label="Camera input" value={cameraId} disabled={working || locked} onChange={event => choose('videoinput', event.target.value, cameraChoices)}>{!cameraId && <option value="">Choose a camera</option>}{cameraChoices.map((device, index) => <option value={device.id} key={`${device.id}-${index}`}>{device.label}</option>)}</select></label><button className="primary" disabled={working || locked || !cameraId} onClick={() => act(() => selected ? engineRef.current.switchCamera(selected.id, { deviceId: cameraId }) : engineRef.current.addCamera({ deviceId: cameraId }))}><Camera/>{selected ? 'Replace selected camera' : 'Add selected camera'}</button></> : cameras !== null && <p className="device-note">No camera inputs were reported by this browser.</p>}
      {saved.videoinput && cameras === null && <p className="device-note">Saved: {saved.videoinput.label}. Browser access will be checked when you connect.</p>}
      {saved.videoinput && cameras !== null && !cameraId && <p className="device-note">Your saved camera is unavailable. Choose an input or reconnect the device.</p>}
      {selected && <p className="device-current"><strong>Selected: {selected.camera.label}</strong><span>{formatVideo(selected.camera)}</span></p>}
    </section>
    <section className="device-group"><div className="device-group-title"><Mic/><h3>Microphone</h3><button disabled={working} onClick={() => act(() => discover('audioinput'))}><RefreshCw/>{microphones !== null || saved.audioinput ? 'Refresh microphones' : 'Find microphones'}</button></div>
      {microphoneChoices.length > 0 ? <><label className="field"><span>Microphone input</span><select aria-label="Microphone input" value={microphoneId} disabled={working || locked} onChange={event => choose('audioinput', event.target.value, microphoneChoices)}>{!microphoneId && <option value="">Choose a microphone</option>}{microphoneChoices.map((device, index) => <option value={device.id} key={`${device.id}-${index}`}>{device.label}</option>)}</select></label><button className="primary" disabled={working || locked || !microphoneId} onClick={() => act(() => engineRef.current.setMic(true, { deviceId: microphoneId }))}><Mic/>{snapshot.micEnabled ? 'Switch microphone' : 'Use selected microphone'}</button></> : microphones !== null && <p className="device-note">No microphone inputs were reported by this browser.</p>}
      {saved.audioinput && microphones === null && <p className="device-note">Saved: {saved.audioinput.label}. Browser access will be checked when you connect.</p>}
      {saved.audioinput && microphones !== null && !microphoneId && <p className="device-note">Your saved microphone is unavailable. Choose an input or reconnect the device.</p>}
      {snapshot.micEnabled && <><p className="device-current"><strong>{microphone.label || 'Microphone active'}</strong><span>{[microphone.sampleRate ? `${microphone.sampleRate / 1000} kHz` : null, microphone.channelCount ? `${microphone.channelCount} channel${microphone.channelCount === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}</span></p>{microphone.echoControl && <DeviceToggle label="Echo cancellation" checked={microphone.echoCancellation} disabled={working || locked} onChange={echoCancellation => act(() => engineRef.current.setMicProcessing({ echoCancellation }))}/>} {microphone.noiseControl && <DeviceToggle label="Noise suppression" checked={microphone.noiseSuppression} disabled={working || locked} onChange={noiseSuppression => act(() => engineRef.current.setMicProcessing({ noiseSuppression }))}/>}<button className="device-mic-off" disabled={working} onClick={() => act(() => engineRef.current.setMic(false))}><Mic/>Turn microphone off</button></>}
    </section>
    {locked && <p className="device-note">Input selection is paused during recording, streaming, and replay. Existing inputs keep running.</p>}
  </div>;
}

export function HardwareStatus({ hardware, active, run, refresh }) {
  const [pending, setPending] = useState(false);
  const state = hardware?.state || 'unconfigured';
  const checking = pending || state === 'checking';
  async function update(path, body) { setPending(true); try { await run(async () => { await api(path, body); await refresh(); }); } finally { setPending(false); } }
  return <section className="panel hardware-panel"><div className="section-heading"><Cpu/><h2>Local encoding</h2><span className={`hardware-state ${state === 'ready' ? 'ready' : ''}`}>{checking ? 'Checking' : state === 'ready' ? 'Checked' : state === 'error' ? 'Check failed' : 'Not checked'}</span></div>
    <div className="hardware-summary"><strong>{hardware?.label || 'Check the local encoder'}</strong><p>{hardware?.detail || hardware?.error || 'Find out which encoder the Linux service can use for streams and MP4 conversions.'}</p>{hardware?.encoder && <code>{hardware.encoder}</code>}</div>
    <div className="hardware-controls"><label className="field"><span>Encoder preference</span><select aria-label="Encoder preference" value={hardware?.mode || 'auto'} disabled={active || checking} onChange={event => update('/api/hardware/selection', { mode: event.target.value })}><option value="auto">Automatic</option><option value="cpu">CPU</option><option value="android" disabled={!hardware?.available}>Android hardware{hardware?.available ? '' : ' · unavailable'}</option></select></label><button disabled={active || checking} onClick={() => update('/api/hardware/check', {})}><RefreshCw/>{checking ? 'Checking…' : 'Check hardware'}</button></div>
    <p className="help">This setting applies to Linux streaming and conversion. Local browser recording uses the browser’s encoder.</p>
    {active && <p className="device-note">Stop active output before checking or changing the encoder.</p>}
  </section>;
}
