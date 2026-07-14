// ============================================================
// Dunzo — a browser-based tracker backed by Firebase
// ============================================================
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------- Config sanity check ----------
const $ = (id) => document.getElementById(id);

if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("PASTE_")) {
  // index.html shows the setup screen; just stop here.
  throw new Error("Firebase config not filled in — see README.md");
}

// ---------- Firebase init ----------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

// ---------- App state ----------
let currentUser = null;
let userTags = []; // [{ name, color }]
let trackables = []; // [{ id, ...data }]
let activeTagFilter = null; // tag name, "__dunzo__", or null
let editingTrackableId = null; // null = creating new
let notesTrackableId = null;
let pendingNoteImages = []; // data URLs staged for the note being composed
let unsubTrackables = null;
let unsubUserDoc = null;
let unsubNotes = null;

const DUNZO_TAG = "__dunzo__";
const DUNZO_COLOR = "#34a860";

const EMOJIS = [
  "⭐", "✅", "🔥", "🎯", "📌", "📅", "💪", "🏃",
  "📚", "💻", "🏠", "🚗", "✈️", "🎁", "🎂", "💰",
  "🩺", "💊", "🐶", "🐱", "🌱", "🍽️", "🧹", "🛒",
  "📞", "✉️", "🎓", "🎵", "⚽", "🎮", "❤️", "🧠",
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ============================================================
// Date helpers
// ============================================================

/** Today at local midnight. */
function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Parse "YYYY-MM-DD" as a local date (avoids UTC off-by-one). */
function parseLocalDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Monday of ISO week "YYYY-Www". */
function isoWeekMonday(weekStr) {
  const [yearPart, weekPart] = weekStr.split("-W");
  const year = Number(yearPart);
  const week = Number(weekPart);
  const jan4 = new Date(year, 0, 4);
  const jan4IsoDay = (jan4.getDay() + 6) % 7; // Mon=0 … Sun=6
  const week1Monday = new Date(year, 0, 4 - jan4IsoDay);
  return new Date(week1Monday.getTime() + (week - 1) * 7 * MS_PER_DAY);
}

function daysBetween(from, to) {
  return Math.round((to - from) / MS_PER_DAY);
}

/**
 * The date a trackable sorts by (its effective due date), or null.
 *  - exact: the chosen date
 *  - goal day: that day; goal week: the Sunday ending that week;
 *    goal month: the last day of that month
 *  - countdown: creation date + N days
 */
function effectiveDueDate(t) {
  switch (t.dateType) {
    case "exact":
      return t.exactDate ? parseLocalDate(t.exactDate) : null;
    case "goal":
      if (t.goalKind === "day" && t.goalValue) return parseLocalDate(t.goalValue);
      if (t.goalKind === "week" && t.goalValue) {
        const monday = isoWeekMonday(t.goalValue);
        return new Date(monday.getTime() + 6 * MS_PER_DAY); // Sunday
      }
      if (t.goalKind === "month" && t.goalValue) {
        const [y, m] = t.goalValue.split("-").map(Number);
        return new Date(y, m, 0); // day 0 of next month = last day of this month
      }
      return null;
    case "countdown": {
      const created = createdAtDate(t);
      if (!created || !t.countdownDays) return null;
      return new Date(created.getTime() + t.countdownDays * MS_PER_DAY);
    }
    default:
      return null;
  }
}

function createdAtDate(t) {
  if (!t.createdAt) return null;
  const d = t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
  d.setHours(0, 0, 0, 0);
  return d;
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function fmtDate(d) {
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}${sameYear ? "" : ", " + d.getFullYear()}`;
}

/** The date line shown on a trackable card. */
function dateLabel(t) {
  const now = today();
  const due = effectiveDueDate(t);

  if (t.dateType === "countdown") {
    if (!due) return { text: "", overdue: false, soon: false };
    const left = daysBetween(now, due);
    if (left > 1) return { text: `${left} days left`, overdue: false, soon: left <= 3 };
    if (left === 1) return { text: "1 day left", overdue: false, soon: true };
    if (left === 0) return { text: "Due today!", overdue: false, soon: true };
    return { text: `${-left} day${left === -1 ? "" : "s"} overdue`, overdue: true, soon: false };
  }

  if (t.dateType === "exact" && due) {
    const diff = daysBetween(now, due);
    let text = `Due ${fmtDate(due)}`;
    if (diff === 0) text = "Due today!";
    else if (diff < 0) text = `${fmtDate(due)} — ${-diff} day${diff === -1 ? "" : "s"} overdue`;
    return { text, overdue: diff < 0, soon: diff >= 0 && diff <= 3 };
  }

  if (t.dateType === "goal" && due) {
    let text;
    if (t.goalKind === "day") text = `Goal: ${fmtDate(due)}`;
    else if (t.goalKind === "week") {
      const monday = isoWeekMonday(t.goalValue);
      text = `Goal: week of ${fmtDate(monday)}–${fmtDate(due)}`;
    } else {
      const [y, m] = t.goalValue.split("-").map(Number);
      text = `Goal: ${MONTHS[m - 1]} ${y}`;
    }
    const diff = daysBetween(now, due);
    if (diff < 0) text += ` — ${-diff} day${diff === -1 ? "" : "s"} past`;
    return { text, overdue: diff < 0, soon: diff >= 0 && diff <= 3 };
  }

  // No date: show how long it's been listed
  const created = createdAtDate(t);
  const days = created ? daysBetween(created, now) : 0;
  return {
    text: days === 0 ? "Listed today" : `Listed for ${days} day${days === 1 ? "" : "s"}`,
    overdue: false,
    soon: false,
  };
}

// ============================================================
// Auth
// ============================================================
$("google-signin-btn").addEventListener("click", async () => {
  $("auth-error").classList.add("hidden");
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    $("auth-error").textContent = "Sign-in failed: " + err.message;
    $("auth-error").classList.remove("hidden");
  }
});

$("signout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    $("auth-screen").classList.add("hidden");
    $("app-screen").classList.remove("hidden");
    $("user-name").textContent = user.displayName || user.email || "";
    startListening();
  } else {
    stopListening();
    $("app-screen").classList.add("hidden");
    $("auth-screen").classList.remove("hidden");
  }
});

// ============================================================
// Firestore listeners
// ============================================================
function startListening() {
  const uid = currentUser.uid;

  unsubUserDoc = onSnapshot(doc(db, "users", uid), (snap) => {
    userTags = (snap.exists() && snap.data().tags) || [];
    render();
  });

  const q = query(collection(db, "users", uid, "trackables"), orderBy("createdAt", "asc"));
  unsubTrackables = onSnapshot(q, (snap) => {
    trackables = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
}

function stopListening() {
  unsubTrackables?.();
  unsubUserDoc?.();
  unsubNotes?.();
  unsubTrackables = unsubUserDoc = unsubNotes = null;
  trackables = [];
  userTags = [];
  activeTagFilter = null;
}

async function saveUserTags() {
  await setDoc(doc(db, "users", currentUser.uid), { tags: userTags }, { merge: true });
}

// ============================================================
// Rendering
// ============================================================
function render() {
  renderTagBar();
  renderList();
}

function renderTagBar() {
  const bar = $("tag-bar");
  bar.innerHTML = "";

  for (const tag of userTags) {
    bar.appendChild(makeTagChip(tag.name, tag.color, activeTagFilter === tag.name, () => {
      activeTagFilter = activeTagFilter === tag.name ? null : tag.name;
      render();
    }));
  }

  if (trackables.some((t) => t.done)) {
    bar.appendChild(makeTagChip("Dunzo ✅", DUNZO_COLOR, activeTagFilter === DUNZO_TAG, () => {
      activeTagFilter = activeTagFilter === DUNZO_TAG ? null : DUNZO_TAG;
      render();
    }));
  }
}

function makeTagChip(label, color, active, onClick) {
  const chip = document.createElement("button");
  chip.className = "tag-chip" + (active ? " active" : "");
  chip.style.background = color;
  chip.textContent = label;
  chip.addEventListener("click", onClick);
  return chip;
}

function visibleTrackables() {
  let list;
  if (activeTagFilter === DUNZO_TAG) {
    list = trackables.filter((t) => t.done);
  } else if (activeTagFilter) {
    list = trackables.filter((t) => !t.done && (t.tagNames || []).includes(activeTagFilter));
  } else {
    list = trackables.filter((t) => !t.done);
  }

  // Sort: dated items by effective due date (soonest first),
  // then dateless items by creation date (oldest first).
  return list.slice().sort((a, b) => {
    const da = effectiveDueDate(a);
    const db_ = effectiveDueDate(b);
    if (da && db_) return da - db_;
    if (da) return -1;
    if (db_) return 1;
    return (createdAtDate(a) || 0) - (createdAtDate(b) || 0);
  });
}

function renderList() {
  const container = $("trackable-list");
  container.innerHTML = "";
  const list = visibleTrackables();
  $("empty-msg").classList.toggle("hidden", list.length > 0 || trackables.some((t) => !t.done));

  for (const t of list) {
    container.appendChild(renderCard(t));
  }
}

function renderCard(t) {
  const card = document.createElement("div");
  card.className = "trackable-card" + (t.done ? " done" : "");

  const top = document.createElement("div");
  top.className = "trackable-top";

  const emoji = document.createElement("span");
  emoji.className = "trackable-emoji";
  emoji.textContent = t.emoji || "⭐";

  const name = document.createElement("span");
  name.className = "trackable-name";
  name.textContent = t.name;

  const { text, overdue, soon } = dateLabel(t);
  const date = document.createElement("span");
  date.className = "trackable-date" + (overdue ? " overdue" : soon ? " due-soon" : "");
  date.textContent = text;

  top.append(emoji, name, date);
  card.appendChild(top);

  const tagNames = t.tagNames || [];
  if (tagNames.length) {
    const tagsRow = document.createElement("div");
    tagsRow.className = "trackable-tags";
    for (const tn of tagNames) {
      const tagDef = userTags.find((u) => u.name === tn);
      const mini = document.createElement("span");
      mini.className = "mini-tag";
      mini.style.background = tagDef ? tagDef.color : "#8892a8";
      mini.textContent = tn;
      tagsRow.appendChild(mini);
    }
    card.appendChild(tagsRow);
  }

  const actions = document.createElement("div");
  actions.className = "trackable-actions";

  const dunzoBtn = document.createElement("button");
  if (t.done) {
    dunzoBtn.className = "btn btn-small btn-undunzo";
    dunzoBtn.textContent = "Un-Dunzo";
    dunzoBtn.addEventListener("click", () => setDone(t, false));
  } else {
    dunzoBtn.className = "btn btn-small btn-dunzo";
    dunzoBtn.textContent = "Dunzo!";
    dunzoBtn.addEventListener("click", () => setDone(t, true));
  }

  const editBtn = document.createElement("button");
  editBtn.className = "btn btn-small";
  editBtn.textContent = "Edit Me";
  editBtn.addEventListener("click", () => openTrackableModal(t));

  const notesBtn = document.createElement("button");
  notesBtn.className = "btn btn-small";
  notesBtn.textContent = "Notes";
  notesBtn.addEventListener("click", () => openNotesModal(t));

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn btn-small btn-ghost";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", async () => {
    if (confirm(`Delete "${t.name}" forever? Its notes will be gone too.`)) {
      await deleteDoc(doc(db, "users", currentUser.uid, "trackables", t.id));
    }
  });

  actions.append(dunzoBtn, editBtn, notesBtn, deleteBtn);
  card.appendChild(actions);
  return card;
}

async function setDone(t, done) {
  await updateDoc(doc(db, "users", currentUser.uid, "trackables", t.id), {
    done,
    doneAt: done ? serverTimestamp() : null,
  });
}

// ============================================================
// Add / Edit Trackable modal
// ============================================================
let modalState = {
  emoji: "⭐",
  dateType: "none",
  goalKind: "day",
  selectedTags: new Set(),
};

// Build the emoji picker once
const picker = $("emoji-picker");
for (const e of EMOJIS) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = e;
  b.addEventListener("click", () => {
    modalState.emoji = e;
    $("emoji-btn").textContent = e;
    picker.classList.add("hidden");
  });
  picker.appendChild(b);
}
$("emoji-btn").addEventListener("click", () => picker.classList.toggle("hidden"));

$("add-btn").addEventListener("click", () => openTrackableModal(null));
$("trackable-cancel").addEventListener("click", () => $("trackable-modal").classList.add("hidden"));

function openTrackableModal(t) {
  editingTrackableId = t ? t.id : null;
  modalState = {
    emoji: t?.emoji || "⭐",
    dateType: t?.dateType || "none",
    goalKind: t?.goalKind || "day",
    selectedTags: new Set(t?.tagNames || []),
  };

  $("trackable-modal-title").textContent = t ? "Edit Trackable" : "New Trackable";
  $("emoji-btn").textContent = modalState.emoji;
  $("trackable-name").value = t?.name || "";
  $("exact-date").value = t?.dateType === "exact" ? t.exactDate || "" : "";
  $("goal-day").value = t?.goalKind === "day" ? t.goalValue || "" : "";
  $("goal-week").value = t?.goalKind === "week" ? t.goalValue || "" : "";
  $("goal-month").value = t?.goalKind === "month" ? t.goalValue || "" : "";
  $("countdown-days").value = t?.dateType === "countdown" ? t.countdownDays || "" : "";
  $("new-tag-name").value = "";
  $("trackable-error").classList.add("hidden");
  picker.classList.add("hidden");

  syncDateTypeUI();
  renderModalTags();
  $("trackable-modal").classList.remove("hidden");
  $("trackable-name").focus();
}

// Date-type choice buttons
for (const btn of document.querySelectorAll("#date-type-row .choice-btn")) {
  btn.addEventListener("click", () => {
    modalState.dateType = btn.dataset.value;
    syncDateTypeUI();
  });
}
for (const btn of document.querySelectorAll("#goal-kind-row .choice-btn")) {
  btn.addEventListener("click", () => {
    modalState.goalKind = btn.dataset.value;
    syncDateTypeUI();
  });
}

function syncDateTypeUI() {
  for (const btn of document.querySelectorAll("#date-type-row .choice-btn")) {
    btn.classList.toggle("selected", btn.dataset.value === modalState.dateType);
  }
  $("exact-fields").classList.toggle("hidden", modalState.dateType !== "exact");
  $("goal-fields").classList.toggle("hidden", modalState.dateType !== "goal");
  $("countdown-fields").classList.toggle("hidden", modalState.dateType !== "countdown");

  for (const btn of document.querySelectorAll("#goal-kind-row .choice-btn")) {
    btn.classList.toggle("selected", btn.dataset.value === modalState.goalKind);
  }
  $("goal-day").classList.toggle("hidden", modalState.goalKind !== "day");
  $("goal-week").classList.toggle("hidden", modalState.goalKind !== "week");
  $("goal-month").classList.toggle("hidden", modalState.goalKind !== "month");
}

function renderModalTags() {
  const wrap = $("modal-tag-list");
  wrap.innerHTML = "";
  if (!userTags.length) {
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "No tags yet — create one below.";
    wrap.appendChild(hint);
    return;
  }
  for (const tag of userTags) {
    wrap.appendChild(makeTagChip(tag.name, tag.color, modalState.selectedTags.has(tag.name), () => {
      if (modalState.selectedTags.has(tag.name)) modalState.selectedTags.delete(tag.name);
      else modalState.selectedTags.add(tag.name);
      renderModalTags();
    }));
  }
}

$("create-tag-btn").addEventListener("click", async () => {
  const name = $("new-tag-name").value.trim();
  const color = $("new-tag-color").value;
  if (!name) return;
  if (userTags.some((t) => t.name === name)) {
    showTrackableError("A tag with that name already exists.");
    return;
  }
  userTags.push({ name, color });
  modalState.selectedTags.add(name);
  $("new-tag-name").value = "";
  renderModalTags();
  await saveUserTags();
});

function showTrackableError(msg) {
  $("trackable-error").textContent = msg;
  $("trackable-error").classList.remove("hidden");
}

$("trackable-save").addEventListener("click", async () => {
  const name = $("trackable-name").value.trim();
  if (!name) return showTrackableError("Give your trackable a name.");

  const data = {
    name,
    emoji: modalState.emoji,
    dateType: modalState.dateType,
    tagNames: [...modalState.selectedTags],
    exactDate: null,
    goalKind: null,
    goalValue: null,
    countdownDays: null,
  };

  if (modalState.dateType === "exact") {
    if (!$("exact-date").value) return showTrackableError("Pick a due date.");
    data.exactDate = $("exact-date").value;
  } else if (modalState.dateType === "goal") {
    data.goalKind = modalState.goalKind;
    const input = { day: "goal-day", week: "goal-week", month: "goal-month" }[modalState.goalKind];
    if (!$(input).value) return showTrackableError("Pick a goal date.");
    data.goalValue = $(input).value;
  } else if (modalState.dateType === "countdown") {
    const days = parseInt($("countdown-days").value, 10);
    if (!days || days < 1) return showTrackableError("Enter how many days to count down.");
    data.countdownDays = days;
  }

  const uid = currentUser.uid;
  if (editingTrackableId) {
    await updateDoc(doc(db, "users", uid, "trackables", editingTrackableId), data);
  } else {
    await addDoc(collection(db, "users", uid, "trackables"), {
      ...data,
      done: false,
      doneAt: null,
      createdAt: serverTimestamp(),
    });
  }
  $("trackable-modal").classList.add("hidden");
});

// ============================================================
// Notes modal
// ============================================================
$("notes-close").addEventListener("click", () => {
  $("notes-modal").classList.add("hidden");
  unsubNotes?.();
  unsubNotes = null;
  resetNoteCompose();
});

function openNotesModal(t) {
  notesTrackableId = t.id;
  $("notes-modal-title").textContent = `Notes — ${t.emoji || ""} ${t.name}`;
  resetNoteCompose();
  $("notes-modal").classList.remove("hidden");

  const q = query(
    collection(db, "users", currentUser.uid, "trackables", t.id, "notes"),
    orderBy("createdAt", "desc")
  );
  unsubNotes?.();
  unsubNotes = onSnapshot(q, (snap) => {
    renderNotes(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

function renderNotes(notes) {
  const list = $("notes-list");
  list.innerHTML = "";
  if (!notes.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No notes yet.";
    list.appendChild(p);
    return;
  }
  for (const n of notes) {
    const card = document.createElement("div");
    card.className = "note-card";

    const del = document.createElement("button");
    del.className = "note-delete";
    del.textContent = "✕";
    del.title = "Delete note";
    del.addEventListener("click", async () => {
      if (confirm("Delete this note?")) {
        await deleteDoc(doc(db, "users", currentUser.uid, "trackables", notesTrackableId, "notes", n.id));
      }
    });
    card.appendChild(del);

    const when = document.createElement("div");
    when.className = "note-date";
    const d = n.createdAt?.toDate ? n.createdAt.toDate() : null;
    when.textContent = d ? d.toLocaleString() : "";
    card.appendChild(when);

    if (n.text) {
      const p = document.createElement("p");
      p.textContent = n.text;
      card.appendChild(p);
    }

    if (n.images?.length) {
      const imgs = document.createElement("div");
      imgs.className = "note-images";
      for (const src of n.images) {
        const img = document.createElement("img");
        img.src = src; // GIF data URLs animate automatically
        img.addEventListener("click", () => openLightbox(src));
        imgs.appendChild(img);
      }
      card.appendChild(imgs);
    }

    list.appendChild(card);
  }
}

function openLightbox(src) {
  const box = document.createElement("div");
  box.className = "lightbox";
  const img = document.createElement("img");
  img.src = src;
  box.appendChild(img);
  box.addEventListener("click", () => box.remove());
  document.body.appendChild(box);
}

function resetNoteCompose() {
  pendingNoteImages = [];
  $("note-text").value = "";
  $("note-image-input").value = "";
  $("note-image-previews").innerHTML = "";
  $("note-image-count").textContent = "";
  $("notes-error").classList.add("hidden");
}

function showNotesError(msg) {
  $("notes-error").textContent = msg;
  $("notes-error").classList.remove("hidden");
}

// ---------- Image handling ----------
// Notes live in Firestore documents, which max out at ~1 MB. JPEGs and
// PNGs get resized/compressed in the browser to fit; GIFs can't be
// recompressed without losing animation, so they must already be small.
const MAX_IMAGE_BYTES = 350 * 1024; // per image, after compression
const MAX_NOTE_BYTES = 900 * 1024; // total per note

function dataUrlBytes(dataUrl) {
  return Math.ceil((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function compressImage(file) {
  const rawUrl = await readFileAsDataUrl(file);

  if (file.type === "image/gif") {
    if (dataUrlBytes(rawUrl) > MAX_IMAGE_BYTES) {
      throw new Error(`"${file.name}" is too big. GIFs must be under ${Math.round(MAX_IMAGE_BYTES / 1024)} KB to keep their animation.`);
    }
    return rawUrl;
  }

  // Resize + re-encode JPEG/PNG via canvas, stepping quality down to fit
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = rawUrl;
  });

  const maxDim = 1200;
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0, width, height);

  for (const quality of [0.85, 0.7, 0.55, 0.4, 0.25]) {
    const out = canvas.toDataURL("image/jpeg", quality);
    if (dataUrlBytes(out) <= MAX_IMAGE_BYTES) return out;
  }
  throw new Error(`"${file.name}" couldn't be compressed small enough.`);
}

$("note-image-input").addEventListener("change", async (e) => {
  $("notes-error").classList.add("hidden");
  for (const file of e.target.files) {
    try {
      const dataUrl = await compressImage(file);
      const total = pendingNoteImages.reduce((s, u) => s + dataUrlBytes(u), 0);
      if (total + dataUrlBytes(dataUrl) > MAX_NOTE_BYTES) {
        showNotesError("That's too many images for one note — save this note and add more images in a new note.");
        break;
      }
      pendingNoteImages.push(dataUrl);
    } catch (err) {
      showNotesError(err.message);
    }
  }
  e.target.value = "";
  renderNotePreviews();
});

function renderNotePreviews() {
  const wrap = $("note-image-previews");
  wrap.innerHTML = "";
  pendingNoteImages.forEach((src, i) => {
    const img = document.createElement("img");
    img.src = src;
    img.title = "Click to remove";
    img.style.cursor = "pointer";
    img.addEventListener("click", () => {
      pendingNoteImages.splice(i, 1);
      renderNotePreviews();
    });
    wrap.appendChild(img);
  });
  $("note-image-count").textContent = pendingNoteImages.length
    ? `${pendingNoteImages.length} image${pendingNoteImages.length === 1 ? "" : "s"} attached`
    : "";
}

$("note-save-btn").addEventListener("click", async () => {
  const text = $("note-text").value.trim();
  if (!text && !pendingNoteImages.length) {
    showNotesError("Write something or attach an image first.");
    return;
  }
  await addDoc(
    collection(db, "users", currentUser.uid, "trackables", notesTrackableId, "notes"),
    { text, images: pendingNoteImages, createdAt: serverTimestamp() }
  );
  resetNoteCompose();
});
