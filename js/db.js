// שכבת IndexedDB. כל הנתונים והקבצים נשמרים מקומית במכשיר.
// מבנה: projects, folders, plans, versions, files (ה-PDF המקורי), thumbs,
// markups, measurements, links, calibrations, textindex, meta

const NAME = 'planapp';
const VER = 1;
export const STORES = {
  projects: { key: 'id' },
  folders: { key: 'id', idx: ['parentId'] },
  plans: { key: 'id', idx: ['folderId'] },
  versions: { key: 'id', idx: ['planId'] },
  files: { key: 'id' },
  thumbs: { key: 'id' },
  markups: { key: 'id', idx: ['versionId'] },
  measurements: { key: 'id', idx: ['versionId'] },
  links: { key: 'id', idx: ['versionId'] },
  calibrations: { key: 'id', idx: ['versionId'] },
  textindex: { key: 'id', idx: ['versionId'] },
  meta: { key: 'key' },
};

let dbp = null;
export function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const [n, c] of Object.entries(STORES)) {
        if (!d.objectStoreNames.contains(n)) {
          const s = d.createObjectStore(n, { keyPath: c.key });
          (c.idx || []).forEach((i) => s.createIndex(i, i));
        }
      }
    };
    r.onsuccess = () => {
      const d = r.result;
      d.onversionchange = () => d.close();
      res(d);
    };
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('בסיס הנתונים חסום על ידי לשונית אחרת'));
  });
  return dbp;
}

export const rq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function run(stores, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    let out;
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('העסקה בוטלה'));
    Promise.resolve()
      .then(() => fn(t))
      .then((v) => { out = v; })
      .catch((e) => { try { t.abort(); } catch { /* ignore */ } rej(e); });
  });
}

export const get = (s, k) => run(s, 'readonly', (t) => rq(t.objectStore(s).get(k)));
export const getAll = (s) => run(s, 'readonly', (t) => rq(t.objectStore(s).getAll()));
export const put = (s, v) => run(s, 'readwrite', (t) => rq(t.objectStore(s).put(v)));
export const putMany = (s, arr) => run(s, 'readwrite', async (t) => { const os = t.objectStore(s); for (const v of arr) os.put(v); });
export const del = (s, k) => run(s, 'readwrite', (t) => rq(t.objectStore(s).delete(k)));
export const byIndex = (s, i, k) => run(s, 'readonly', (t) => rq(t.objectStore(s).index(i).getAll(IDBKeyRange.only(k))));

export async function clearAll() {
  const names = Object.keys(STORES);
  await run(names, 'readwrite', async (t) => { for (const n of names) t.objectStore(n).clear(); });
}

// מחיקה לפי אינדקס בתוך עסקה קיימת
export async function delByIndex(t, store, index, key) {
  const os = t.objectStore(store);
  const keys = await rq(os.index(index).getAllKeys(IDBKeyRange.only(key)));
  for (const k of keys) os.delete(k);
}

// סריקת חנות בעזרת cursor. אם cb מחזיר false הסריקה נעצרת.
export function scan(store, cb) {
  return run(store, 'readonly', (t) => new Promise((res, rej) => {
    const r = t.objectStore(store).openCursor();
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return res();
      if (cb(c.value) === false) return res();
      c.continue();
    };
    r.onerror = () => rej(r.error);
  }));
}

export async function storageEstimate() {
  try {
    const e = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return { usage: e.usage || 0, quota: e.quota || 0, persisted };
  } catch { return { usage: 0, quota: 0, persisted: false }; }
}

export async function requestPersist() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}
