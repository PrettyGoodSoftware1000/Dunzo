// In-memory stub of the Firebase modules Dunzo imports, served in place of
// the gstatic CDN by the Playwright test. Implements just enough of
// firebase-app, firebase-auth, and firebase-firestore for the app's flows.

// ---------- app ----------
export function initializeApp(config) { return { config }; }

// ---------- auth ----------
const fakeUser = { uid: "testuser", displayName: "Test User", email: "test@example.com" };
export function getAuth() { return {}; }
export class GoogleAuthProvider {}
export function signInWithPopup() { return Promise.resolve({ user: fakeUser }); }
export function signOut() { return Promise.resolve(); }
export function onAuthStateChanged(auth, cb) { setTimeout(() => cb(fakeUser), 0); return () => {}; }

// ---------- firestore ----------
const store = new Map(); // full doc path -> plain data object
let idCounter = 0;
const listeners = new Set(); // { kind: 'doc'|'collection', path, cb }

function notifyAll() {
  for (const l of [...listeners]) fire(l);
}
function fire(l) {
  if (l.kind === "doc") {
    const data = store.get(l.path);
    l.cb({ exists: () => data !== undefined, data: () => data, id: l.path.split("/").pop() });
  } else {
    l.cb(collSnapshot(l.path, l.order));
  }
}
function collSnapshot(collPath, order) {
  const prefix = collPath + "/";
  const docs = [];
  for (const [path, data] of store) {
    if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
      docs.push({
        id: path.split("/").pop(),
        data: () => data,
        ref: { __type: "doc", path },
      });
    }
  }
  if (order) {
    docs.sort((a, b) => {
      const av = a.data()[order.field], bv = b.data()[order.field];
      const an = av?.toDate ? av.toDate().getTime() : av;
      const bn = bv?.toDate ? bv.toDate().getTime() : bv;
      return (an > bn ? 1 : an < bn ? -1 : 0) * (order.dir === "desc" ? -1 : 1);
    });
  }
  return { docs, empty: docs.length === 0, forEach: (f) => docs.forEach(f) };
}

export function getFirestore() { return { __type: "db" }; }
export function doc(parent, ...segs) {
  const base = parent.__type === "db" ? "" : parent.path + "/";
  return { __type: "doc", path: base + segs.join("/") };
}
export function collection(parent, ...segs) {
  const base = parent.__type === "db" ? "" : parent.path + "/";
  return { __type: "collection", path: base + segs.join("/") };
}
export function query(coll, ...clauses) {
  const order = clauses.find((c) => c?.__type === "orderBy");
  return { __type: "query", path: coll.path, order };
}
export function orderBy(field, dir = "asc") { return { __type: "orderBy", field, dir }; }
export function serverTimestamp() {
  const d = new Date();
  return { toDate: () => d, __serverTimestamp: true };
}
export function arrayUnion(...values) { return { __op: "union", values }; }
export function arrayRemove(...values) { return { __op: "remove", values }; }

function normalize(v) {
  if (v instanceof Date) { const d = v; return { toDate: () => d }; }
  return v;
}
function applyFields(target, fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (v && v.__op === "union") {
      const cur = Array.isArray(target[k]) ? target[k] : [];
      target[k] = [...new Set([...cur, ...v.values])];
    } else if (v && v.__op === "remove") {
      const cur = Array.isArray(target[k]) ? target[k] : [];
      target[k] = cur.filter((x) => !v.values.includes(x));
    } else {
      target[k] = normalize(v);
    }
  }
}

export async function addDoc(coll, data) {
  const id = "doc" + (++idCounter);
  const path = coll.path + "/" + id;
  const obj = {};
  applyFields(obj, data);
  store.set(path, obj);
  notifyAll();
  return { __type: "doc", path, id };
}
export async function setDoc(ref, data, opts) {
  const existing = (opts?.merge && store.get(ref.path)) || {};
  applyFields(existing, data);
  store.set(ref.path, existing);
  notifyAll();
}
export async function updateDoc(ref, fields) {
  const existing = store.get(ref.path) || {};
  applyFields(existing, fields);
  store.set(ref.path, existing);
  notifyAll();
}
export async function deleteDoc(ref) {
  store.delete(ref.path);
  notifyAll();
}
export async function getDocs(q) {
  return collSnapshot(q.path, q.order);
}
export function onSnapshot(target, cb) {
  const l = target.__type === "doc"
    ? { kind: "doc", path: target.path, cb }
    : { kind: "collection", path: target.path, order: target.order, cb };
  listeners.add(l);
  fire(l);
  return () => listeners.delete(l);
}
export function writeBatch() {
  const ops = [];
  return {
    update: (ref, fields) => ops.push(() => updateDoc(ref, fields)),
    set: (ref, data, opts) => ops.push(() => setDoc(ref, data, opts)),
    delete: (ref) => ops.push(() => deleteDoc(ref)),
    commit: async () => { for (const op of ops) await op(); },
  };
}
