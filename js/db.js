// Tiny IndexedDB wrapper: a key/value store for app data and a blob store for local audio files.
const DB_NAME = 'echo-player';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const kv = {
  get: (key) => run('kv', 'readonly', (s) => s.get(key)),
  set: (key, value) => run('kv', 'readwrite', (s) => s.put(value, key)),
  del: (key) => run('kv', 'readwrite', (s) => s.delete(key)),
  clear: () => run('kv', 'readwrite', (s) => s.clear()),
};

export const files = {
  get: (id) => run('files', 'readonly', (s) => s.get(id)),
  put: (id, blob) => run('files', 'readwrite', (s) => s.put(blob, id)),
  del: (id) => run('files', 'readwrite', (s) => s.delete(id)),
  clear: () => run('files', 'readwrite', (s) => s.clear()),
};
