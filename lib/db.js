/** 本地快照存储（IndexedDB）。chrome.storage.local 只有 5MB，几千条用户会撑爆。 */

const DB_NAME = "x-mutual-check";
const DB_VER = 1;
const STORE = "snapshots";
const MAX_PER_USER = 12;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        s.createIndex("userId", "userId", { unique: false });
        s.createIndex("ts", "ts", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode) {
  const db = await openDb();
  return db.transaction(STORE, mode).objectStore(STORE);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveSnapshot(snapshot) {
  const store = await tx("readwrite");
  const id = await wrap(store.add(snapshot));
  await prune(snapshot.userId);
  return id;
}

export async function listSnapshots(userId) {
  const store = await tx("readonly");
  const idx = store.index("userId");
  const all = await wrap(idx.getAll(IDBKeyRange.only(userId)));
  return all.sort((a, b) => b.ts - a.ts);
}

export async function latestSnapshot(userId, excludeId = null) {
  const all = await listSnapshots(userId);
  return all.find((s) => s.id !== excludeId) || null;
}

export async function getSnapshot(id) {
  const store = await tx("readonly");
  return wrap(store.get(id));
}

async function prune(userId) {
  const all = await listSnapshots(userId);
  if (all.length <= MAX_PER_USER) return;
  const store = await tx("readwrite");
  for (const s of all.slice(MAX_PER_USER)) store.delete(s.id);
}

export async function clearUser(userId) {
  const all = await listSnapshots(userId);
  const store = await tx("readwrite");
  for (const s of all) store.delete(s.id);
}

export async function storageInfo() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
}
