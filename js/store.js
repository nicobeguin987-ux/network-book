// Local-first document store backed by IndexedDB.
// Exposes the small API the app is written against:
//   collection(name).onSnapshot(fn) / .add(doc) / .doc(id).set(doc) / .doc(id).delete()
// Everything stays in this browser profile. Nothing is sent anywhere.

const DB_NAME = 'network-book';
const VERSION = 1;
export const STORES = ['contacts', 'people', 'notes', 'tasks', 'drafts', 'meta'];

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other tabs of Network Book and reload.'));
  });
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function openStore() {
  const idb = await openIdb();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* optional */ }
  const mem = {}, subs = {}, pending = new Set();
  for (const s of STORES) {
    mem[s] = new Map();
    await new Promise((resolve, reject) => {
      const req = idb.transaction(s).objectStore(s).openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { mem[s].set(c.key, c.value); c.continue(); } else resolve(); };
      req.onerror = () => reject(req.error);
    });
  }
  const snapshot = s => {
    const docs = [...mem[s]].map(([id, d]) => ({ id, exists: true, data: () => d }));
    return { docs, size: docs.length, empty: !docs.length };
  };
  const notify = s => {
    if (pending.has(s)) return;
    pending.add(s);
    setTimeout(() => { pending.delete(s); (subs[s] || []).forEach(fn => fn(snapshot(s))); }, 0);
  };
  const tx = (s, fn) => new Promise((resolve, reject) => {
    const t = idb.transaction(s, 'readwrite');
    fn(t.objectStore(s));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Write aborted'));
  });
  const quota = e => (e && e.name === 'QuotaExceededError') ? Object.assign(new Error('Storage full'), { code: 'quota_exceeded' }) : e;

  function collection(s) {
    if (!mem[s]) throw new TypeError('Unknown collection ' + s);
    const api = {
      onSnapshot(fn) { (subs[s] = subs[s] || []).push(fn); setTimeout(() => fn(snapshot(s)), 0); return () => { subs[s] = subs[s].filter(x => x !== fn); }; },
      async add(d) { const id = newId(); await api.doc(id).set(d); return { id }; },
      doc(id) {
        return {
          id,
          async get() { const d = mem[s].get(id); return { id, exists: !!d, data: () => d }; },
          async set(d) { const v = structuredClone(d); try { await tx(s, st => st.put(v, id)); } catch (e) { throw quota(e); } mem[s].set(id, v); notify(s); },
          async delete() { await tx(s, st => st.delete(id)); mem[s].delete(id); notify(s); },
        };
      },
      all() { return [...mem[s]]; },
      async putMany(entries) {
        const list = entries.map(([id, d]) => [id, structuredClone(d)]);
        try { await tx(s, st => { for (const [id, d] of list) st.put(d, id); }); } catch (e) { throw quota(e); }
        for (const [id, d] of list) mem[s].set(id, d);
        notify(s);
      },
      async clear() { await tx(s, st => st.clear()); mem[s].clear(); notify(s); },
    };
    return api;
  }

  return {
    collection,
    /** Everything as one plain object (for backups). */
    dump() {
      const out = {};
      for (const s of STORES) out[s] = Object.fromEntries(mem[s]);
      return out;
    },
    /** Replace every store with the given dump. */
    async restore(dump) {
      for (const s of STORES) {
        await collection(s).clear();
        const entries = Object.entries((dump && dump[s]) || {});
        if (entries.length) await collection(s).putMany(entries);
      }
    },
    async wipe() { for (const s of STORES) await collection(s).clear(); },
  };
}
