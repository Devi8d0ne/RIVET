let sessionToken;
export async function api(path, body, raw = false, retry = true) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    if (body !== undefined && !sessionToken) sessionToken = (await api('/api/session')).token;
    const response = await fetch(path, {
      signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'X-Rivet-Token': sessionToken }, body: raw ? body : JSON.stringify(body) }),
    });
    if (response.status === 403 && body !== undefined && retry) { sessionToken = null; return api(path, body, raw, false); }
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || 'The local service could not complete this action.'); error.status = response.status; throw error; }
    return result;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('The local service is unavailable. Keep the local RIVET service running.');
    throw error;
  } finally { clearTimeout(timeout); }
}

let database;
function openDB() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('rivet-local-v1', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('chunks', { keyPath: 'key' }); request.result.createObjectStore('sessions', { keyPath: 'id' }); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  return database;
}
export async function db(store, method, value) {
  const instance = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = instance.transaction(store, method.startsWith('get') ? 'readonly' : 'readwrite');
    const request = transaction.objectStore(store)[method](value);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error || request.error);
    transaction.onabort = () => reject(transaction.error || new Error('Local backup storage is full.'));
  });
}
export const formatBytes = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
export const formatTime = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

export async function recoverRecordings() {
  const sessions = await db('sessions', 'getAll');
  // Enumerate lightweight keys; loading every Blob at once can exhaust a phone
  // after a long recording made while the local service was unavailable.
  const keys = await db('chunks', 'getAllKeys');
  for (const session of sessions) {
    const prefix = `${session.id}:`;
    const pending = keys.filter(key => key.startsWith(prefix)).sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
    for (const key of pending) {
      const chunk = await db('chunks', 'get', key);
      if (!chunk) continue;
      await api(`/api/recordings/${session.id}/chunk?seq=${chunk.seq}`, chunk.blob, true);
      await db('chunks', 'delete', chunk.key);
    }
    await api(`/api/recordings/${session.id}/finish`, {});
    await db('sessions', 'delete', session.id);
  }
  return sessions.length;
}
