import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDown, ArrowRight, ArrowUp, Bell, Camera, Check, Circle, Clapperboard, Copy, Download, Film, FolderOpen, HardDrive, ImagePlus, Layers, Mic, Monitor, MonitorUp, Music2, Pause, Play, Plus, Radio, RotateCcw, Save, Settings2, Square, Trash2, Upload, Video, Volume2, X } from 'lucide-react';
import { StudioEngine } from './engine';
import { api, formatBytes, formatTime, recoverRecordings } from './api';
import { LocalRecording, LiveBroadcast, saveClip } from './capture';
import { WidgetPicker, SportControls } from './widgets';
import { CameraControls, DeviceAccess, HardwareStatus, SavedInputs } from './devices';
import './devices.css';
import './style.css';

function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(`rivet.${key}`)) ?? fallback; } catch { return fallback; } }
function useSaved(key, fallback) { const [value, setValue] = useState(() => stored(key, fallback)); useEffect(() => { try { localStorage.setItem(`rivet.${key}`, JSON.stringify(value)); } catch {} }, [key, value]); return [value, setValue]; }
const initialOverlay = { home: 'HOME', away: 'AWAY', homeScore: 0, awayScore: 0, period: '1', clock: '00:00', visible: true, lowerThird: '', lowerVisible: false };
const initialSnapshot = { sources: [{ id: 'slate', name: 'Holding slate', type: 'slate' }], previewId: 'slate', programId: 'slate', micEnabled: false, replayBuffering: false, replayReady: false, micVolume: 1, mediaVolume: .8, masterVolume: .8 };
const makeSceneId = () => `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const fallbackScene = { id: 'scene-default', name: 'Default', sourceIds: ['slate'], insetId: null };

function Toggle({ checked, onChange, children, disabled }) { return <label className="toggle-row"><span>{children}</span><input type="checkbox" role="switch" checked={!!checked} disabled={disabled} onChange={event => onChange(event.target.checked)}/><span className="switch" aria-hidden="true"/></label>; }
function Modal({ title, close, children }) {
  const ref = useRef(null);
  useEffect(() => { const previous = document.activeElement; ref.current?.showModal(); const handler = e => { e.preventDefault(); close(); }; ref.current?.addEventListener('cancel', handler); return () => { previous?.focus(); }; }, []);
  return <dialog ref={ref} onClick={event => { if (event.target === ref.current) close(); }}><header><h2>{title}</h2><button className="icon-button" onClick={close} aria-label="Close dialog"><X/></button></header>{children}</dialog>;
}
function Fader({ name, icon: Icon, value, onChange, engineRef }) { return <div className="fader"><span><Icon/>{name}</span><input aria-label={`${name} volume`} type="range" min="0" max="1" step=".01" value={value ?? 1} onChange={e => onChange(Number(e.target.value))}/><output>{Math.round((value ?? 1) * 100)}%</output><LevelMeter engineRef={engineRef} name={name}/></div>; }
function LevelMeter({ engineRef, name }) {
  const fill = useRef(null);
  useEffect(() => {
    if (!engineRef) return;
    const timer = setInterval(() => {
      const meter = engineRef.current?.meters();
      if (fill.current && meter) fill.current.style.width = `${Math.min(100, (name === 'Mic' ? meter.mic : meter.master) * 150)}%`;
    }, 100);
    return () => clearInterval(timer);
  }, [engineRef, name]);
  return <div className="level" aria-label={`${name} level`}><i ref={fill} style={{width:0}}/></div>;
}
function SourceTile({ source, selected, live, onClick }) { return <button className={`source-tile ${selected ? 'selected' : ''}`} onClick={onClick}><span className="source-thumb">{source.type === 'slate' ? <b>RIVET</b> : source.type === 'camera' ? <Camera/> : source.type === 'audio' ? <Music2/> : source.type === 'image' ? <ImagePlus/> : <Film/>}{live && <i title="In program"><Check/></i>}</span><span>{source.type === 'slate' ? 'Holding slate' : source.name}</span></button>; }

function Library({ recordings, jobs, refresh, run, notify, recordingActive }) {
  const [selected, select] = useState(null), [uploadUrl, setUploadUrl] = useState(''), [height, setHeight] = useState(720), [quality, setQuality] = useState('balanced');
  async function submit(event) { event.preventDefault(); await run(async () => { if (selected.mode === 'upload') { await api(`/api/recordings/${selected.record.id}/upload`, { url: uploadUrl }); notify('Upload queued. The original stays on this device.'); } else { await api(`/api/recordings/${selected.record.id}/transcode`, { height: Number(height), quality }); notify('Conversion queued. Your original is preserved.'); } select(null); setUploadUrl(''); await refresh(); }); }
  return <div className="workspace-page"><div className="page-heading"><div><h1>Your recordings</h1><p>Full shows, replays, and converted files. Stored on this device.</p></div><button onClick={() => run(async () => { const count = await recoverRecordings(); await refresh(); notify(count ? `Recovered ${count} recording${count === 1 ? '' : 's'}.` : 'No browser backups need recovery.'); })} disabled={recordingActive}><RotateCcw/>Recover recordings</button></div>{jobs.length > 0 && <section className="panel jobs"><h2>Conversions</h2>{jobs.map(job => <div className="job" key={job.id}><span><strong>{job.status === 'complete' ? 'MP4 ready' : `MP4 conversion · ${job.status}`}</strong>{job.error && <small>{job.error}</small>}</span>{['queued', 'running'].includes(job.status) && <button onClick={() => run(async () => { await api(`/api/jobs/${job.id}/cancel`, {}); await refresh(); })}>Cancel</button>}</div>)}</section>}{!recordings.length ? <section className="empty-library"><Clapperboard/><h2>Your next game starts here.</h2><p>Record a show or capture a replay in the studio.<br/>It will appear here, ready to play, convert, or share.</p></section> : <div className="recording-grid">{recordings.map(record => <article className="panel recording-card" key={record.id}><video controls playsInline preload="metadata" src={record.url}/><div className="recording-details"><h2>{record.title}</h2><p>{formatBytes(record.size)} · {new Date(record.created).toLocaleString()} · {record.mime?.includes('mp4') ? 'MP4' : 'WebM'}</p>{record.status !== 'complete' && <p className="warning">{record.status === 'recording' ? 'Recording in progress' : 'Interrupted recording · saved media retained'}</p>}{record.upload && <p>Upload: {record.upload.status}{record.upload.error ? ` · ${record.upload.error}` : ''}</p>}<div className="button-row"><a className="button" download={`${record.title}.${record.mime?.includes('mp4') ? 'mp4' : 'webm'}`} href={record.url}><Download/>Save file</a><button disabled={record.status !== 'complete'} onClick={() => select({ mode: 'transcode', record })}><Film/>Convert</button><button disabled={record.status !== 'complete'} onClick={() => select({ mode: 'upload', record })}><Upload/>Upload</button></div></div></article>)}</div>}{selected && <Modal title={selected.mode === 'upload' ? 'Queue an upload' : 'Convert recording'} close={() => select(null)}><form onSubmit={submit}><p>{selected.record.title}</p>{selected.mode === 'upload' ? <><label className="field"><span>Secure upload address</span><input autoFocus required type="url" value={uploadUrl} onChange={e => setUploadUrl(e.target.value)} placeholder="https://your-storage/upload-address"/></label><p className="help">Use a signed HTTPS PUT upload link from your storage provider. This is a file upload destination, not a channel page. Queued uploads retry when the network returns.</p></> : <><label className="field"><span>Video size</span><select value={height} onChange={e => setHeight(e.target.value)}><option value="360">360p · smallest</option><option value="480">480p · compact</option><option value="720">720p · HD</option><option value="1080">1080p · full HD</option></select></label><label className="field"><span>Quality</span><select value={quality} onChange={e => setQuality(e.target.value)}><option value="small">Smaller file</option><option value="balanced">Balanced</option><option value="high">Higher quality</option></select></label><p className="help">Creates an MP4 with H.264 video and AAC audio, entirely on this device. The original remains available.</p></>}<button className="primary" type="submit">{selected.mode === 'upload' ? <Upload/> : <Film/>}{selected.mode === 'upload' ? 'Queue upload' : 'Convert to MP4'}</button></form></Modal>}</div>;
}

function Output({ destinations, setDestinations, quality, setQuality, active, available, goLive, run, hardware, refresh }) {
  function edit(index, patch) { setDestinations(current => current.map((item, i) => i === index ? { ...item, ...patch } : item)); }
  return <div className="workspace-page output-page"><div className="page-heading"><div><h1>Broadcast on your terms.</h1><p>Keep producing locally. Connect a destination when you’re ready to go live.</p></div></div><HardwareStatus hardware={hardware} active={active} run={run} refresh={refresh}/><section className="panel"><h2>Production quality</h2><div className="quality-grid">{[['light', 'Light', '480p · 24 fps', 'For lower-powered devices'], ['standard', 'Standard', '720p · 30 fps', 'A balanced starting point'], ['high', 'High', '1080p · 30 fps', 'Test encoding and heat first']].map(([id, label, size, description]) => <button disabled={active} className={quality === id ? 'quality selected' : 'quality'} key={id} onClick={() => run(() => setQuality(id))}><strong>{label}</strong><span>{size}</span><small>{description}</small></button>)}</div><p className="help">Change quality between recordings and broadcasts. Actual frame rate depends on your device.</p></section><section className="panel"><div className="section-heading"><h2>Stream destinations</h2><span>Up to 4</span></div><p className="help">Paste the server and key from YouTube, Facebook, Twitch, Kick, or your own RTMP service. Keys stay in this session.</p>{destinations.map((destination, index) => <div className="destination" key={index}><div className="destination-header"><input aria-label={`Destination ${index + 1} name`} value={destination.name} placeholder="Destination name" onChange={e => edit(index, { name: e.target.value })}/><button className="icon-button" aria-label={`Remove destination ${index + 1}`} disabled={active} onClick={() => setDestinations(destinations.filter((_, i) => i !== index))}><X/></button></div><label className="field"><span>Stream server</span><input required disabled={active} value={destination.url} onChange={e => edit(index, { url: e.target.value })} placeholder="rtmps://your-platform/live"/></label><label className="field"><span>Stream key</span><input type="password" autoComplete="off" disabled={active} value={destination.key} onChange={e => edit(index, { key: e.target.value })} placeholder="Paste your stream key"/></label></div>)}<div className="button-row"><button disabled={active || destinations.length >= 4} onClick={() => setDestinations([...destinations, { name: `Destination ${destinations.length + 1}`, url: '', key: '' }])}><Plus/>Add destination</button><button className="primary" disabled={!available || active} onClick={goLive}><Radio/>Start broadcast</button></div>{!available && <p className="warning">Live output and conversions need FFmpeg in the local Linux environment. Local browser recording remains available.</p>}<p className="help">Starting a broadcast sends the program video and audio to the destinations above. Check playback on the destination to confirm delivery. A failed destination stops this broadcast; local recording continues.</p></section></div>;
}

function SceneBuilder({ scenes, setScenes, snapshot, engineRef, run, notify, activeSceneId, setActiveSceneId }) {
  const [sceneName, setSceneName] = useState('');
  const [activeIndexes, setActiveIndexes] = useState({});
  const sources = snapshot.sources.filter((source) => source.type !== 'audio');
  const hasNoScenes = !scenes.length;

  function normalizeSceneName(raw) { return String(raw || '').trim().slice(0, 36) || 'Scene'; }
  function sanitizeSourceIds(sourceIds) {
    const seen = new Set();
    return sourceIds
      .map((sourceId) => String(sourceId))
      .filter((sourceId) => {
        if (seen.has(sourceId)) return false;
        if (!snapshot.sources.some((source) => source.id === sourceId && source.type !== 'audio')) return false;
        seen.add(sourceId);
        return true;
      });
  }
  function sourceForScene(scene, sourceId) {
    return snapshot.sources.find((source) => source.id === sourceId);
  }
  function sceneSourceIds(scene) {
    return sanitizeSourceIds(Array.isArray(scene?.sourceIds) ? scene.sourceIds : []);
  }
  function nextSceneName() {
    return normalizeSceneName(sceneName || `Scene ${scenes.length + 1}`);
  }
  function rememberFromCurrent() {
    const sourceIds = sceneSourceIds({ sourceIds: [snapshot.programId, snapshot.previewId, snapshot.insetId, ...sources.map((source) => source.id)] });
    const next = {
      id: makeSceneId(),
      name: nextSceneName(),
      sourceIds,
      insetId: sceneSourceIds({ sourceIds: [snapshot.insetId] })[0] || null,
    };
    setScenes(current => [...current, next]);
    setActiveIndexes((current) => ({ ...current, [next.id]: 0 }));
    setActiveSceneId(next.id);
    setSceneName('');
    notify(`Saved ${next.name} with ${next.sourceIds.length} source slot${next.sourceIds.length === 1 ? '' : 's'}.`);
  }
  function applyScene(scene) {
    return run(async () => {
      const ids = sceneSourceIds(scene);
      if (!ids.length) throw new Error('Scene has no valid sources to apply.');
      const programId = ids[0];
      const previewId = ids[1] ?? snapshot.previewId;
      const sceneInset = scene.insetId || null;
      const insetSource = sourceForScene(scene, sceneInset);

      engineRef.current.setProgram(programId);
      if (sourceForScene(scene, previewId)) engineRef.current.setPreview(previewId);
      engineRef.current.setInset(insetSource ? insetSource.id : null);
      setActiveIndexes((current) => ({ ...current, [scene.id]: 0 }));
      setActiveSceneId(scene.id);
      notify(`Scene ${scene.name} is live.`);
    });
  }

  function updateScene(sceneId) {
    setScenes(current => current.map((scene) => {
      if (scene.id !== sceneId) return scene;
      const mergedIds = [snapshot.programId, snapshot.previewId, snapshot.insetId, ...scene.sourceIds, ...sources.map((source) => source.id)];
      const sourceIds = sanitizeSourceIds(mergedIds);
      const insetId = scene.insetId && sourceIds.includes(scene.insetId) ? scene.insetId : sourceIds[0] || null;
      return { ...scene, sourceIds, insetId };
    }));
  }

  function removeScene(sceneId) {
    if (!confirm('Delete this scene?')) return;
    setScenes((current) => current.filter((scene) => scene.id !== sceneId));
    setActiveIndexes((current) => {
      const next = { ...current };
      delete next[sceneId];
      return next;
    });
    if (activeSceneId === sceneId) setActiveSceneId(scenes.find((scene) => scene.id !== sceneId)?.id || null);
    notify('Scene removed.');
  }

  function renameScene(sceneId, name) {
    setScenes((current) => current.map((scene) => scene.id === sceneId ? { ...scene, name: normalizeSceneName(name) } : scene));
  }
  function cycleSource(scene) {
    return run(() => {
      const ids = sceneSourceIds(scene);
      if (ids.length <= 1) return;
      const next = ((activeIndexes[scene.id] || 0) + 1) % ids.length;
      const programId = ids[next];
      const previewId = ids[(next + 1) % ids.length];
      if (!sourceForScene(scene, programId)) return;
      engineRef.current.setProgram(programId);
      if (sourceForScene(scene, previewId)) engineRef.current.setPreview(previewId);
      setActiveIndexes((current) => ({ ...current, [scene.id]: next }));
      setActiveSceneId(scene.id);
    });
  }
  function setInset(sceneId, insetId) {
    setScenes((current) => current.map((scene) => scene.id === sceneId ? { ...scene, insetId } : scene));
  }
  function toggleSceneSource(sceneId, sourceId) {
    setScenes((current) => current.map((scene) => {
      if (scene.id !== sceneId) return scene;
      const ids = sceneSourceIds(scene);
      const exists = ids.includes(sourceId);
      const next = exists ? ids.filter((existing) => existing !== sourceId) : [...ids, sourceId];
      const sourceIds = sanitizeSourceIds(next);
      const insetId = sourceForScene(scene, scene.insetId) && sourceIds.includes(scene.insetId) ? scene.insetId : null;
      if (!sourceIds.length) {
        return { ...scene, sourceIds: ['slate'], insetId: null };
      }
      return { ...scene, sourceIds, insetId };
    }));
  }
  function moveSceneSource(sceneId, sourceId, direction) {
    setScenes((current) => current.map((scene) => {
      if (scene.id !== sceneId) return scene;
      const sourceIds = sceneSourceIds(scene);
      const currentIndex = sourceIds.indexOf(sourceId);
      const nextIndex = currentIndex + direction;
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= sourceIds.length) return scene;
      const reordered = [...sourceIds];
      [reordered[currentIndex], reordered[nextIndex]] = [reordered[nextIndex], reordered[currentIndex]];
      return { ...scene, sourceIds: reordered };
    }));
    setActiveIndexes((current) => ({ ...current, [sceneId]: 0 }));
  }

  return <section className="panel scenes">
    <h2>Scenes</h2>
    <label className="field"><span>New scene name</span>
      <input value={sceneName} placeholder="Example: Two cameras + score" onChange={(event) => setSceneName(event.target.value)} />
    </label>
    <div className="button-row">
      <button className="primary" onClick={rememberFromCurrent}><Save/>Create scene</button>
      <button onClick={() => setSceneName('')}><Copy/>Reset name</button>
    </div>
    {hasNoScenes && <p className="help">Save a scene from your current source setup to build one-click presets.</p>}
    <div className="scene-list">
      {scenes.map((scene) => {
        const sourceIds = sceneSourceIds(scene);
        const activeSource = sourceIds[activeIndexes[scene.id] || 0] || sourceIds[0] || null;
        return <article className={`scene-item ${activeSceneId === scene.id ? 'active' : ''}`} key={scene.id}>
          <label className="field"><span>Scene name</span><input value={scene.name} onChange={(event) => renameScene(scene.id, event.target.value)} /></label>
          <p className="scene-hint">Active source: {sourceForScene(scene, activeSource)?.name || 'N/A'}</p>
          <div className="scene-order-heading"><span>Source order</span><small>Program → Preview → Next</small></div>
          <ol className="scene-order">
            {sourceIds.map((sourceId, index) => {
              const source = sourceForScene(scene, sourceId);
              return <li key={sourceId}>
                <span className="scene-slot">{index === 0 ? 'PGM' : index === 1 ? 'PVW' : index + 1}</span>
                <span className="scene-source-name">{source?.name || sourceId}</span>
                <span className="scene-order-actions">
                  <button className="icon-button" disabled={index === 0} onClick={() => moveSceneSource(scene.id, sourceId, -1)} aria-label={`Move ${source?.name || sourceId} earlier`}><ArrowUp/></button>
                  <button className="icon-button" disabled={index === sourceIds.length - 1} onClick={() => moveSceneSource(scene.id, sourceId, 1)} aria-label={`Move ${source?.name || sourceId} later`}><ArrowDown/></button>
                  <button className="icon-button" disabled={sourceIds.length === 1} onClick={() => toggleSceneSource(scene.id, sourceId)} aria-label={`Remove ${source?.name || sourceId} from scene`}><X/></button>
                </span>
              </li>;
            })}
          </ol>
          <label className="field"><span>Inset source</span>
            <select value={scene.insetId || ''} onChange={(event) => setInset(scene.id, event.target.value || null)}>
              <option value="">No inset</option>
              {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
            </select>
          </label>
          <div className="button-row">
            <button onClick={() => applyScene(scene)}><Layers/>Apply</button>
            <button onClick={() => cycleSource(scene)} disabled={sourceIds.length <= 1}><ArrowRight/>Next source</button>
            <button onClick={() => updateScene(scene.id)}><Copy/>Update</button>
            <button className="icon-button" onClick={() => removeScene(scene.id)} aria-label="Delete scene"><Trash2/></button>
          </div>
          <div className="scene-source-list">
            {sources.filter((source) => !sourceIds.includes(source.id)).map((source) => <button key={source.id} className="scene-source" onClick={() => toggleSceneSource(scene.id, source.id)}><Plus/>{source.name}</button>)}
            {sources.every((source) => sourceIds.includes(source.id)) && <small>Every available visual source is in this scene.</small>}
          </div>
        </article>;
      })}
    </div>
  </section>;
}

function App() {
  const programCanvas = useRef(null), previewCanvas = useRef(null), engine = useRef(null), recorder = useRef(null), broadcast = useRef(null), fileInput = useRef(null);
  const [view, setView] = useState('studio'), [snapshot, setSnapshot] = useState(initialSnapshot), [overlay, setOverlay] = useSaved('overlay', initialOverlay), [title, setTitle] = useSaved('title', 'Untitled broadcast'), [quality, setQualityState] = useSaved('quality', 'standard'), [scenes, setScenes] = useSaved('scenes', [fallbackScene]), [activeSceneId, setActiveSceneId] = useSaved('activeSceneId', fallbackScene.id);
  const [seconds, setSeconds] = useState(0), [clockRunning, setClockRunning] = useState(false), [clockMode, setClockMode] = useSaved('clockMode', 'up'), [message, setMessage] = useState(null), [sourceDialog, setSourceDialog] = useState(false), [deviceDialog, setDeviceDialog] = useState(false), [busy, setBusy] = useState(false), [recording, setRecording] = useState(null), [live, setLive] = useState(null), [status, setStatus] = useState({ ffmpeg: false }), [recordings, setRecordings] = useState([]), [jobs, setJobs] = useState([]), [destinations, setDestinations] = useState([{ name: 'My channel', url: '', key: '' }]);
  const [installPrompt, setInstallPrompt] = useState(null), [installed, setInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true);
  const recordingActive = !!recording?.active, liveActive = !!live?.active;
  const captureLocked = recordingActive || liveActive || snapshot.replayBuffering;
  function notify(text, error = false) { setMessage({ text, error }); }
  async function run(fn) { try { return await fn(); } catch (error) { notify(error.message || 'This action could not be completed.', true); } }
  function update(patch) { setOverlay(current => ({ ...current, ...patch })); }
  async function refresh() { const [health, library, conversions] = await Promise.all([api('/api/status'), api('/api/recordings'), api('/api/jobs').catch(() => ({ jobs: [] }))]); setStatus(health); setRecordings(library.recordings); setJobs(conversions.jobs); if (broadcast.current && health.stream.status === 'error') { await broadcast.current.stop(); broadcast.current = null; notify(health.stream.error || 'Broadcast interrupted. Local recording continues.', true); } }
  useEffect(() => {
    const studio = new StudioEngine(programCanvas.current, data => { setSnapshot(data); if (data.error) notify(data.error, true); }, { quality }); engine.current = studio; studio.setQuality?.(quality); setSnapshot(studio.snapshot());
    let frame; let last = 0;
    function render(now) { if (now - last > 90) { const canvas = previewCanvas.current; if (canvas) studio.drawPreview(canvas.getContext('2d'), canvas.width, canvas.height); last = now; } frame = requestAnimationFrame(render); }
    frame = requestAnimationFrame(render); void run(refresh); const poll = setInterval(() => void refresh().catch(() => {}), 5000);
    return () => { cancelAnimationFrame(frame); clearInterval(poll); studio.destroy(); };
  }, []);
  useEffect(() => { engine.current?.setCaptureLocked(captureLocked); }, [captureLocked]);
  useEffect(() => { engine.current?.setOverlay({ ...overlay, clock: formatTime(seconds) }); }, [overlay, seconds]);
  useEffect(() => { if (!clockRunning) return; const start = Date.now(), base = seconds; const tick = setInterval(() => { const elapsed = Math.floor((Date.now() - start) / 1000); const next = clockMode === 'down' ? Math.max(0, base - elapsed) : base + elapsed; setSeconds(next); if (clockMode === 'down' && next === 0) setClockRunning(false); }, 200); return () => clearInterval(tick); }, [clockRunning, clockMode]);
  useEffect(() => { const prevent = e => { if (recorder.current || broadcast.current) { e.preventDefault(); e.returnValue = ''; } }; addEventListener('beforeunload', prevent); return () => removeEventListener('beforeunload', prevent); }, []);
  useEffect(() => { if (!message || message.error) return; const timer = setTimeout(() => setMessage(null), 5500); return () => clearTimeout(timer); }, [message]);
  useEffect(() => {
    if (!scenes.length) { setScenes([fallbackScene]); setActiveSceneId(fallbackScene.id); return; }
    if (!activeSceneId || !scenes.some((scene) => scene.id === activeSceneId)) setActiveSceneId(scenes[0]?.id || fallbackScene.id);
  }, [scenes, activeSceneId, setActiveSceneId, setScenes]);
  useEffect(() => {
    const handleBeforeInstallPrompt = event => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const handleAppInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
      notify('RIVET is now on your home screen.');
    };
    addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    addEventListener('appinstalled', handleAppInstalled);
    return () => {
      removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);
  async function importFiles(files) { for (const file of files) await engine.current.addFile(file); setSourceDialog(false); }
  async function installHomeScreen() {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      const result = await installPrompt.userChoice;
      setInstallPrompt(null);
      if (result?.outcome !== 'accepted') notify('Install dismissed. You can use your browser menu to pin it later.');
    } catch {
      notify('Install flow was blocked by your browser.', true);
      setInstallPrompt(null);
    }
  }
  async function toggleRecord() {
    if (!recorder.current && engine.current?.snapshot().deviceBusy) return;
    if (busy) return; setBusy(true);
    await run(async () => { if (recorder.current) { const active = recorder.current; recorder.current = null; try { await active.stop(); notify('Recording saved in your library.'); } finally { setRecording(null); await refresh(); } } else { await engine.current.init(); const next = new LocalRecording(state => { setRecording(state); if (state.error) notify(state.error, true); }); await next.start(engine.current.getStream(), title); recorder.current = next; notify('Recording locally. You can keep working without internet.'); } });
    setBusy(false);
  }
  async function goLive() {
    if (broadcast.current) { await run(() => broadcast.current.stop()); broadcast.current = null; setLive(null); return; }
    if (engine.current?.snapshot().deviceBusy) return;
    if (view !== 'output' || !destinations.length || destinations.some(item => !item.url)) { setView('output'); return; }
    setBusy(true); await run(async () => { await engine.current.init(); const next = new LiveBroadcast(state => { setLive(state); if (state.error) notify(state.error, true); }); await next.start(engine.current.getStream(), destinations.map(({ url, key }) => ({ url, key })), quality); broadcast.current = next; notify('Encoder started. Confirm playback on your destination.'); setView('studio'); }); setBusy(false);
  }
  async function captureReplay() { await run(async () => { const clip = await engine.current.captureReplay(); const clipTitle = `${title} · replay ${new Date().toLocaleTimeString()}`; await saveClip(clip.blob, clipTitle); const replaySource = await engine.current.addFile(new File([clip.blob], `${clipTitle}.webm`, { type: 'video/webm' })); engine.current.markReplay(replaySource.id); await refresh(); notify(`Saved ${Math.round(clip.duration)} seconds. Replay selected in Preview.`); }); }
  const activeSource = snapshot.sources.find(source => source.id === snapshot.previewId);
  return <div className="app"><aside className="rail"><div className="brand-mark" aria-label="RIVET"><img src="/icon.svg" alt="" width="48" height="48"/></div><nav>{[[ 'studio', Monitor, 'Studio'], ['library', Film, 'Library'], ['output', Settings2, 'Output']].map(([id, Icon, label]) => <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)} aria-current={view === id ? 'page' : undefined}><Icon/><span>{label}</span></button>)}</nav></aside><header className="topbar"><div className="brand"><img className="brand-icon" src="/icon.svg" alt="" width="30" height="30"/><span>RIVET</span></div><input className="broadcast-title" aria-label="Broadcast title" maxLength="100" value={title} onChange={e => setTitle(e.target.value)}/>{installed ? <span className="local-state">Installed on this device</span> : installPrompt ? <button className="install-button" onClick={installHomeScreen}><Download/>Add to home screen</button> : null}<span className={`local-state ${liveActive ? 'live' : ''}`}><i/>{liveActive ? 'Encoder active' : 'Local studio'}</span><div className="transport"><button disabled={busy || (!recordingActive && snapshot.deviceBusy)} className={recordingActive ? 'record recording' : 'record'} onClick={toggleRecord}>{recordingActive ? <Square/> : <Circle/>}<span>{recordingActive ? formatTime(recording.seconds) : 'Record'}</span></button><button disabled={busy || (!liveActive && snapshot.deviceBusy)} className="primary" onClick={goLive}>{liveActive ? <Square/> : <Radio/>}<span>{liveActive ? 'End stream' : 'Go live'}</span></button></div></header><main><div className={`studio-layout ${view !== 'studio' ? 'concealed' : ''}`}><div className="production"><section className="monitor-section"><div className="monitors"><div className="monitor preview"><div className="monitor-label">Preview<span>{snapshot.sources.find(s => s.id === snapshot.previewId)?.name}</span></div><canvas ref={previewCanvas} width="640" height="360" aria-label="Preview video"/></div><div className="monitor program"><div className="monitor-label">Program<span>{recordingActive ? '● Recording' : 'Local output'}</span></div><canvas ref={programCanvas} aria-label="Program video"/></div></div><div className="switcher-actions"><button className="primary" onClick={() => run(() => engine.current.take())}><ArrowRight/>Take to program</button><button disabled={!snapshot.replayBuffering} onClick={captureReplay}><RotateCcw/>Capture replay</button></div></section><section className="panel sources"><div className="section-heading"><h2>Sources</h2><button className="device-button" onClick={() => setDeviceDialog(true)}><Settings2/>Devices</button><span>{snapshot.sources.length} available</span></div><SavedInputs engineRef={engine} snapshot={snapshot} run={run} locked={captureLocked} openDevices={() => setDeviceDialog(true)}/><div className="source-strip">{snapshot.sources.filter(s => s.type !== 'audio').map(source => <SourceTile key={source.id} source={source} selected={snapshot.previewId === source.id} live={snapshot.programId === source.id} onClick={() => engine.current.setPreview(source.id)}/>)}<button className="add-source" onClick={() => setSourceDialog(true)}><Plus/><span>Add source</span></button></div>{activeSource && !['slate', 'audio'].includes(activeSource.type) && <div className="source-playback"><button onClick={() => run(() => engine.current.setInset(snapshot.insetId === activeSource.id ? null : activeSource.id))}><Video/>{snapshot.insetId === activeSource.id ? 'Remove inset' : 'Picture in picture'}</button></div>}{activeSource && ['video', 'audio', 'replay'].includes(activeSource.type) && <div className="source-playback"><button onClick={() => run(() => engine.current.toggleSource(activeSource.id))}><Play/>Play / pause</button><button onClick={() => run(() => engine.current.seekSource(activeSource.id, 0))}><RotateCcw/>Restart clip</button></div>}{activeSource?.type === 'camera' && <CameraControls source={activeSource} engineRef={engine} run={run} locked={captureLocked} openDevices={() => setDeviceDialog(true)}/>}</section><section className="panel mixer"><div className="section-heading"><h2>Audio mixer</h2><button className={snapshot.micEnabled ? 'engaged' : ''} onClick={() => run(() => engine.current.setMic(!snapshot.micEnabled))}><Mic/>{snapshot.micEnabled ? 'Mic on' : 'Enable mic'}</button><Toggle checked={snapshot.ducking} onChange={value => engine.current.setDucking(value)}>Voice ducking</Toggle></div><Fader name="Mic" icon={Mic} value={snapshot.micVolume} engineRef={engine} onChange={value => engine.current.setMicVolume(value)}/><Fader name="Media" icon={Music2} value={snapshot.mediaVolume} onChange={value => engine.current.setMediaVolume(value)}/><Fader name="Master" icon={Volume2} value={snapshot.masterVolume} engineRef={engine} onChange={value => engine.current.setMasterVolume(value)}/>{snapshot.sources.filter(s => s.type === 'audio').map(source => <div className="audio-source" key={source.id}><button onClick={() => run(() => engine.current.toggleSource(source.id))}><Play/>{source.name}</button><input type="range" min="0" max="1" step=".01" defaultValue="1" aria-label={`${source.name} volume`} onChange={e => engine.current.setSourceVolume(source.id, Number(e.target.value))}/></div>)}</section><section className="panel soundboard"><h2>Soundboard</h2><div>{[['chime', Bell, 'Chime'], ['buzzer', Radio, 'Buzzer'], ['sting', Music2, 'Sting']].map(([kind, Icon, name]) => <button key={kind} onClick={() => run(() => engine.current.playTone(kind))}><Icon/>{name}</button>)}<button onClick={() => engine.current.stopAudio()}><Square/>Stop audio</button></div></section></div><aside className="controls"><WidgetPicker overlay={overlay} update={update}/><SportControls clockMode={clockMode} setClockMode={setClockMode} overlay={overlay} update={update} seconds={seconds} setSeconds={setSeconds} clockRunning={clockRunning} setClockRunning={setClockRunning}/><SceneBuilder scenes={scenes} setScenes={setScenes} snapshot={snapshot} engineRef={engine} run={run} notify={notify} activeSceneId={activeSceneId} setActiveSceneId={setActiveSceneId}/><section className="panel graphics"><h2>On-screen graphics</h2><label className="field"><span>Lower third title</span><input placeholder="Enter title text" maxLength="100" value={overlay.lowerThird} onChange={e => update({ lowerThird: e.target.value })}/></label><Toggle checked={overlay.lowerVisible} onChange={lowerVisible => update({ lowerVisible })}>Show title</Toggle><label className="field sponsor-field"><span>Sponsor name</span><input aria-label="Sponsor name" maxLength="70" placeholder="Presented by…" value={overlay.sponsorText || ''} onChange={e => update({ sponsorText: e.target.value })}/></label><Toggle checked={overlay.sponsorVisible} onChange={sponsorVisible => update({ sponsorVisible })}>Show sponsor</Toggle><span className="field-label">Local artwork</span><button onClick={() => fileInput.current.click()}><Upload/>Import artwork</button></section><section className="panel replay"><h2>Replay buffer</h2><Toggle checked={snapshot.replayBuffering} disabled={snapshot.deviceBusy && !snapshot.replayBuffering} onChange={value => run(() => value ? !engine.current.snapshot().deviceBusy && engine.current.startReplayBuffer() : engine.current.stopReplayBuffer())}>Enable replay buffer</Toggle><p>Keep the last segment ready to save.</p><small>{snapshot.replayBuffering ? snapshot.replayReady ? 'Recent action ready · up to 10 seconds' : 'Building your first segment…' : 'Uses extra encoding while enabled.'}</small></section></aside></div>{view === 'library' && <Library recordings={recordings} jobs={jobs} refresh={refresh} run={run} notify={notify} recordingActive={recordingActive}/>} {view === 'output' && <Output destinations={destinations} setDestinations={setDestinations} quality={quality} setQuality={value => { engine.current.setQuality(value); setQualityState(value); }} active={recordingActive || liveActive || snapshot.replayBuffering || snapshot.deviceBusy} available={status.ffmpeg} goLive={goLive} run={run} hardware={status.hardware} refresh={refresh}/>}</main><footer><span><HardDrive/>{recordingActive ? `${formatBytes(recording.bytes)} recorded locally${recording.pending ? ' · saving' : ''}` : 'Saved on this device'}</span><span>{quality === 'light' ? '480p · 24' : quality === 'high' ? '1080p · 30' : '720p · 30'} fps target <Monitor/></span></footer><input ref={fileInput} className="hidden" type="file" multiple accept="image/*,video/*,audio/*" onChange={e => { const files = [...e.target.files]; e.target.value = ''; void run(() => importFiles(files)); }}/>{message && <div className={`toast ${message.error ? 'error' : ''}`} role={message.error ? 'alert' : 'status'}><span>{message.text}</span><button className="icon-button" onClick={() => setMessage(null)} aria-label="Dismiss message"><X/></button></div>}{deviceDialog && <Modal title="Device access" close={() => setDeviceDialog(false)}><DeviceAccess engineRef={engine} snapshot={snapshot} run={run} locked={captureLocked}/></Modal>}{sourceDialog && <Modal title="Add a source" close={() => setSourceDialog(false)}><div className="source-choices"><button onClick={() => run(async () => { await engine.current.addCamera({ facingMode: 'environment' }); setSourceDialog(false); })}><Camera/><strong>Camera</strong><small>Rear camera or default webcam</small></button><button onClick={() => run(async () => { await engine.current.addCamera({ facingMode: 'user' }); setSourceDialog(false); })}><Video/><strong>Front camera</strong><small>Commentary and interviews</small></button><button onClick={() => fileInput.current.click()}><FolderOpen/><strong>Local media</strong><small>Video, audio, images, and artwork</small></button><button onClick={() => run(async () => { await engine.current.addScreen(); setSourceDialog(false); })}><MonitorUp/><strong>Screen or window</strong><small>Available where your browser supports capture</small></button></div><p className="help">Sources stay local. Select one in Preview, then take it to Program.</p></Modal>}</div>;
}

createRoot(document.getElementById('root')).render(<App/>);
