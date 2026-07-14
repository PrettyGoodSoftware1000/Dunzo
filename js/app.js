// ============================================================
// Dunzo — a browser-based tracker backed by Firebase
// ============================================================
import { firebaseConfig } from "./firebase-config.js";
import { EMOJI_DATA } from "./emoji-data.js";
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
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  collection,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("PASTE_")) {
  // index.html shows the setup screen; just stop here.
  throw new Error("Firebase config not filled in — see README.md");
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

// ---------- App state ----------
let currentUser = null;
let categories = []; // [{ name, color, emoji }] (stored as "tags" in Firestore)
let trackables = []; // [{ id, ...data }]
let activeTagFilter = null; // category name, "__dunzo__", or null
let viewMode = "list"; // "list" | "calendar"
let calMonth = null; // Date pinned to the 1st of the displayed month
let searchOpen = false;
let editingTrackableId = null;
let viewingTrackable = null; // trackable object open in the trackable view
let boardItems = []; // whiteboard items for the open trackable
let boardZTop = 1;
let unsubTrackables = null;
let unsubUserDoc = null;

const DUNZO_TAG = "__dunzo__";
const DUNZO_COLOR = "#5ee85e";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// 24 bright colors, all readable with black type and visible on the dark bg
const CATEGORY_COLORS = [
  "#ff5c5c", "#ff7f50", "#ffa440", "#ffc53d", "#ffe74c", "#d4f24b",
  "#9ee84f", "#5ee85e", "#4ce0a3", "#3fe8d5", "#41d3f2", "#4fb3ff",
  "#7c9cff", "#9d8bff", "#bd7bff", "#d95cff", "#ff5cd8", "#ff5c9e",
  "#ff8fa3", "#ffb38f", "#f2d59b", "#a8f2c0", "#9bd6f2", "#cfc4ff",
];

// ============================================================
// Date helpers
// ============================================================
function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseLocalDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

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

function effectiveDueDate(t) {
  switch (t.dateType) {
    case "exact":
      return t.exactDate ? parseLocalDate(t.exactDate) : null;
    case "goal":
      if (t.goalKind === "day" && t.goalValue) return parseLocalDate(t.goalValue);
      if (t.goalKind === "week" && t.goalValue) {
        return new Date(isoWeekMonday(t.goalValue).getTime() + 6 * MS_PER_DAY); // Sunday
      }
      if (t.goalKind === "month" && t.goalValue) {
        const [y, m] = t.goalValue.split("-").map(Number);
        return new Date(y, m, 0); // last day of the month
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

  const created = createdAtDate(t);
  const days = created ? daysBetween(created, now) : 0;
  return {
    text: days === 0 ? "Listed today" : `Listed for ${days} day${days === 1 ? "" : "s"}`,
    overdue: false,
    soon: false,
  };
}

// ============================================================
// Category helpers
// ============================================================
function categoryOf(t) {
  const names = t.tagNames || [];
  for (const n of names) {
    const c = categories.find((c) => c.name === n);
    if (c) return c;
  }
  return null;
}

function titleColor(t) {
  const c = categoryOf(t);
  return c ? c.color : "#e8eaf2";
}

function categoryEmoji(t) {
  const c = categoryOf(t);
  return c?.emoji || "";
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
    categories = ((snap.exists() && snap.data().tags) || []).map((c) => ({
      emoji: "", // default for categories created before emojis existed
      ...c,
    }));
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
  unsubTrackables = unsubUserDoc = null;
  trackables = [];
  categories = [];
  activeTagFilter = null;
}

async function saveCategories() {
  await setDoc(doc(db, "users", currentUser.uid), { tags: categories }, { merge: true });
}

function trackableRef(id) {
  return doc(db, "users", currentUser.uid, "trackables", id);
}

// ============================================================
// Rendering
// ============================================================
function render() {
  renderTagBar();
  if (viewMode === "list") {
    $("trackable-list").classList.remove("hidden");
    $("calendar-view").classList.add("hidden");
    renderList();
  } else {
    $("trackable-list").classList.add("hidden");
    $("empty-msg").classList.add("hidden");
    $("calendar-view").classList.remove("hidden");
    renderCalendar();
  }
}

function renderTagBar() {
  const bar = $("tag-bar");
  bar.innerHTML = "";

  for (const cat of categories) {
    bar.appendChild(makeTagChip(cat, activeTagFilter === cat.name, () => {
      activeTagFilter = activeTagFilter === cat.name ? null : cat.name;
      render();
    }));
  }

  if (trackables.some((t) => t.done)) {
    bar.appendChild(makeTagChip({ name: "Dunzo", color: DUNZO_COLOR, emoji: "✅" },
      activeTagFilter === DUNZO_TAG, () => {
        activeTagFilter = activeTagFilter === DUNZO_TAG ? null : DUNZO_TAG;
        render();
      }));
  }
}

function makeTagChip(cat, active, onClick) {
  const chip = document.createElement("button");
  chip.className = "tag-chip" + (active ? " active" : "");
  chip.style.background = cat.color;
  chip.textContent = (cat.emoji ? cat.emoji + " " : "") + cat.name;
  chip.addEventListener("click", onClick);
  return chip;
}

function matchesSearch(t) {
  const q = $("search-input").value.trim().toLowerCase();
  if (!searchOpen || !q) return true;
  const scope = $("search-scope").value;
  const inName = (t.name || "").toLowerCase().includes(q);
  const inContent = (t.contentText || "").toLowerCase().includes(q);
  if (scope === "name") return inName;
  if (scope === "content") return inContent;
  return inName || inContent;
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
  list = list.filter(matchesSearch);

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

  for (const t of list) container.appendChild(renderRow(t));
}

function renderRow(t) {
  const row = document.createElement("div");
  row.className = "trackable-row" + (t.done ? " done" : "");

  const emoji = document.createElement("span");
  emoji.className = "row-emoji";
  emoji.textContent = categoryEmoji(t);

  const title = document.createElement("button");
  title.className = "row-title";
  title.style.color = titleColor(t);
  title.textContent = t.name;
  title.addEventListener("click", () => openTrackableView(t));

  const { text, overdue, soon } = dateLabel(t);
  const date = document.createElement("span");
  date.className = "row-date" + (overdue ? " overdue" : soon ? " due-soon" : "");
  date.textContent = text;

  const dunzo = document.createElement("button");
  dunzo.className = "row-dunzo" + (t.done ? " undo" : "");
  dunzo.textContent = t.done ? "Un-Dunzo" : "Dunzo!";
  dunzo.addEventListener("click", () => setDone(t, !t.done));

  row.append(emoji, title, date, dunzo);
  return row;
}

async function setDone(t, done) {
  await updateDoc(trackableRef(t.id), { done, doneAt: done ? serverTimestamp() : null });
}

// ============================================================
// Calendar view
// ============================================================
$("view-list-btn").addEventListener("click", () => setView("list"));
$("view-cal-btn").addEventListener("click", () => setView("calendar"));
$("cal-prev").addEventListener("click", () => shiftMonth(-1));
$("cal-next").addEventListener("click", () => shiftMonth(1));
$("cal-today").addEventListener("click", () => { calMonth = null; render(); });

function setView(mode) {
  viewMode = mode;
  $("view-list-btn").classList.toggle("active", mode === "list");
  $("view-cal-btn").classList.toggle("active", mode === "calendar");
  render();
}

function shiftMonth(delta) {
  const base = calMonth || new Date(today().getFullYear(), today().getMonth(), 1);
  calMonth = new Date(base.getFullYear(), base.getMonth() + delta, 1);
  render();
}

function renderCalendar() {
  const base = calMonth || new Date(today().getFullYear(), today().getMonth(), 1);
  $("cal-month-label").textContent = `${MONTHS[base.getMonth()]} ${base.getFullYear()}`;

  const grid = $("cal-grid");
  grid.innerHTML = "";
  for (const dow of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
    const el = document.createElement("div");
    el.className = "cal-dow";
    el.textContent = dow;
    grid.appendChild(el);
  }

  // Bucket visible (non-done, search/filter-matching) trackables by due date
  const byDay = new Map();
  for (const t of visibleTrackables()) {
    if (t.done) continue;
    const due = effectiveDueDate(t);
    if (!due) continue;
    const key = `${due.getFullYear()}-${due.getMonth()}-${due.getDate()}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(t);
  }

  const firstDow = base.getDay();
  const start = new Date(base.getFullYear(), base.getMonth(), 1 - firstDow);
  const now = today();

  for (let i = 0; i < 42; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const cell = document.createElement("div");
    cell.className = "cal-cell";
    if (day.getMonth() !== base.getMonth()) cell.classList.add("other-month");
    if (day.getTime() === now.getTime()) cell.classList.add("today");

    const num = document.createElement("div");
    num.className = "cal-day-num";
    num.textContent = day.getDate();
    cell.appendChild(num);

    const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
    for (const t of byDay.get(key) || []) {
      const item = document.createElement("button");
      item.className = "cal-item";
      item.style.background = titleColor(t);
      item.textContent = `${categoryEmoji(t)} ${t.name}`.trim();
      item.title = t.name;
      item.addEventListener("click", () => openTrackableView(t));
      cell.appendChild(item);
    }
    grid.appendChild(cell);
  }
}

// ============================================================
// Search
// ============================================================
$("search-toggle-btn").addEventListener("click", () => {
  searchOpen = !searchOpen;
  $("search-bar").classList.toggle("hidden", !searchOpen);
  if (searchOpen) $("search-input").focus();
  render();
});
$("search-input").addEventListener("input", render);
$("search-scope").addEventListener("change", render);
$("search-clear-btn").addEventListener("click", () => {
  $("search-input").value = "";
  searchOpen = false;
  $("search-bar").classList.add("hidden");
  render();
});

// ============================================================
// Emoji picker (searchable) — used for category creation
// ============================================================
let pickedEmoji = "⭐";

function renderEmojiGrid(filter) {
  const grid = $("emoji-grid");
  grid.innerHTML = "";
  const q = (filter || "").trim().toLowerCase();
  const matches = q
    ? EMOJI_DATA.filter(([, kw]) => kw.includes(q))
    : EMOJI_DATA;
  for (const [emoji] of matches.slice(0, 200)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = emoji;
    b.addEventListener("click", () => {
      pickedEmoji = emoji;
      $("cat-emoji-btn").textContent = emoji;
      $("cat-emoji-picker").classList.add("hidden");
    });
    grid.appendChild(b);
  }
  if (!matches.length) {
    const p = document.createElement("span");
    p.className = "hint";
    p.textContent = "No matches";
    grid.appendChild(p);
  }
}

$("cat-emoji-btn").addEventListener("click", () => {
  const picker = $("cat-emoji-picker");
  picker.classList.toggle("hidden");
  if (!picker.classList.contains("hidden")) {
    $("emoji-search").value = "";
    renderEmojiGrid("");
    $("emoji-search").focus();
  }
});
$("emoji-search").addEventListener("input", (e) => renderEmojiGrid(e.target.value));

// ============================================================
// Add / Edit Trackable modal
// ============================================================
let modalState = { dateType: "none", goalKind: "day", selectedTags: new Set() };
let pickedColor = CATEGORY_COLORS[0];

// Build the color palette once
{
  const pal = $("cat-color-palette");
  for (const color of CATEGORY_COLORS) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "color-swatch" + (color === pickedColor ? " selected" : "");
    sw.style.background = color;
    sw.title = color;
    sw.addEventListener("click", () => {
      pickedColor = color;
      for (const s of pal.children) s.classList.remove("selected");
      sw.classList.add("selected");
    });
    pal.appendChild(sw);
  }
}

$("add-btn").addEventListener("click", () => openTrackableModal(null));
$("trackable-cancel").addEventListener("click", () => $("trackable-modal").classList.add("hidden"));

function openTrackableModal(t) {
  editingTrackableId = t ? t.id : null;
  modalState = {
    dateType: t?.dateType || "none",
    goalKind: t?.goalKind || "day",
    selectedTags: new Set(t?.tagNames || []),
  };

  $("trackable-modal-title").textContent = t ? "Edit Trackable" : "New Trackable";
  $("trackable-name").value = t?.name || "";
  $("exact-date").value = t?.dateType === "exact" ? t.exactDate || "" : "";
  $("goal-day").value = t?.goalKind === "day" ? t.goalValue || "" : "";
  $("goal-week").value = t?.goalKind === "week" ? t.goalValue || "" : "";
  $("goal-month").value = t?.goalKind === "month" ? t.goalValue || "" : "";
  $("countdown-days").value = t?.dateType === "countdown" ? t.countdownDays || "" : "";
  $("new-tag-name").value = "";
  $("trackable-error").classList.add("hidden");
  $("cat-emoji-picker").classList.add("hidden");

  syncDateTypeUI();
  renderModalTags();
  $("trackable-modal").classList.remove("hidden");
  $("trackable-name").focus();
}

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
  if (!categories.length) {
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "No categories yet — create one below.";
    wrap.appendChild(hint);
    return;
  }
  for (const cat of categories) {
    wrap.appendChild(makeTagChip(cat, modalState.selectedTags.has(cat.name), function () {
      if (modalState.selectedTags.has(cat.name)) modalState.selectedTags.delete(cat.name);
      else modalState.selectedTags.add(cat.name);
      renderModalTags();
    }));
  }
}

$("create-tag-btn").addEventListener("click", async () => {
  const name = $("new-tag-name").value.trim();
  if (!name) return;
  if (categories.some((c) => c.name === name)) {
    showTrackableError("A category with that name already exists.");
    return;
  }
  categories.push({ name, color: pickedColor, emoji: pickedEmoji });
  modalState.selectedTags.add(name);
  $("new-tag-name").value = "";
  renderModalTags();
  await saveCategories();
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

  if (editingTrackableId) {
    await updateDoc(trackableRef(editingTrackableId), data);
    if (viewingTrackable?.id === editingTrackableId) {
      viewingTrackable = { ...viewingTrackable, ...data };
      renderTviewHeader();
    }
  } else {
    await addDoc(collection(db, "users", currentUser.uid, "trackables"), {
      ...data,
      done: false,
      doneAt: null,
      relatedIds: [],
      contentText: "",
      createdAt: serverTimestamp(),
    });
  }
  $("trackable-modal").classList.add("hidden");
});

// ============================================================
// Trackable view (whiteboard)
// ============================================================
$("tview-close-btn").addEventListener("click", closeTrackableView);
$("tview-edit-btn").addEventListener("click", () => openTrackableModal(viewingTrackable));
$("tview-dunzo-btn").addEventListener("click", async () => {
  await setDone(viewingTrackable, !viewingTrackable.done);
  closeTrackableView();
});
$("tview-delete-btn").addEventListener("click", async () => {
  const t = viewingTrackable;
  if (!confirm(`Delete "${t.name}" forever? Its whiteboard will be gone too.`)) return;
  const boardSnap = await getDocs(collection(trackableRef(t.id), "board"));
  const batch = writeBatch(db);
  boardSnap.forEach((d) => batch.delete(d.ref));
  batch.delete(trackableRef(t.id));
  await batch.commit();
  // Remove dangling links pointing at the deleted trackable
  for (const other of trackables) {
    if (other.id !== t.id && (other.relatedIds || []).includes(t.id)) {
      updateDoc(trackableRef(other.id), { relatedIds: arrayRemove(t.id) });
    }
  }
  closeTrackableView();
});

async function openTrackableView(t) {
  viewingTrackable = t;
  renderTviewHeader();
  $("board-error").classList.add("hidden");
  $("tview-overlay").classList.remove("hidden");

  const snap = await getDocs(query(collection(trackableRef(t.id), "board"), orderBy("createdAt", "asc")));
  boardItems = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  boardZTop = Math.max(1, ...boardItems.map((i) => i.z || 1));
  renderBoard();
}

function closeTrackableView() {
  $("tview-overlay").classList.add("hidden");
  viewingTrackable = null;
  boardItems = [];
  $("board").innerHTML = "";
}

function renderTviewHeader() {
  const t = viewingTrackable;
  if (!t) return;
  $("tview-emoji").textContent = categoryEmoji(t);
  $("tview-title").textContent = t.name;
  $("tview-title").style.color = titleColor(t);
  const { text, overdue, soon } = dateLabel(t);
  const dateEl = $("tview-date");
  dateEl.textContent = text;
  dateEl.className = "tview-date" + (overdue ? " overdue" : soon ? " due-soon" : "");
  $("tview-dunzo-btn").title = t.done ? "Un-Dunzo" : "Mark Dunzo";

  // Related chips
  const rel = $("tview-related");
  rel.innerHTML = "";
  for (const rid of t.relatedIds || []) {
    const other = trackables.find((x) => x.id === rid);
    if (!other) continue;
    const chip = document.createElement("button");
    chip.className = "related-chip";
    chip.style.background = titleColor(other);
    chip.textContent = `🔗 ${categoryEmoji(other)} ${other.name}`.replace("  ", " ");
    chip.addEventListener("click", () => openTrackableView(other));
    rel.appendChild(chip);
  }
}

// ---------- Board rendering + interaction ----------
function boardItemRef(itemId) {
  return doc(db, "users", currentUser.uid, "trackables", viewingTrackable.id, "board", itemId);
}

function renderBoard() {
  const board = $("board");
  board.innerHTML = "";
  for (const item of boardItems) board.appendChild(renderBoardItem(item));
}

function renderBoardItem(item) {
  const el = document.createElement("div");
  el.className = `board-item ${item.type}-item`;
  el.style.left = (item.x || 20) + "px";
  el.style.top = (item.y || 20) + "px";
  el.style.width = (item.w || 240) + "px";
  el.style.height = (item.h || 140) + "px";
  el.style.zIndex = item.z || 1;
  el.dataset.id = item.id;

  // Controls: drag handle + delete
  const controls = document.createElement("div");
  controls.className = "item-controls";
  const dragBar = document.createElement("div");
  dragBar.className = "item-drag";
  dragBar.textContent = "⋮⋮⋮";
  const del = document.createElement("button");
  del.className = "item-del";
  del.textContent = "✕";
  del.title = "Delete";
  del.addEventListener("click", async () => {
    await deleteDoc(boardItemRef(item.id));
    boardItems = boardItems.filter((i) => i.id !== item.id);
    el.remove();
    if (item.type === "text") syncContentText();
  });
  controls.append(dragBar, del);
  el.appendChild(controls);

  // Body
  if (item.type === "text") {
    const body = document.createElement("div");
    body.className = "item-body";
    body.contentEditable = "true";
    body.textContent = item.text || "";
    let saveTimer = null;
    body.addEventListener("input", () => {
      item.text = body.innerText;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        updateDoc(boardItemRef(item.id), { text: item.text });
        syncContentText();
      }, 700);
    });
    el.appendChild(body);
  } else {
    const img = document.createElement("img");
    img.src = item.src;
    img.draggable = false;
    el.appendChild(img);
  }

  // Resize handle
  const rez = document.createElement("div");
  rez.className = "resize-handle";
  el.appendChild(rez);

  // Bring to front on any interaction
  el.addEventListener("pointerdown", () => {
    boardZTop += 1;
    item.z = boardZTop;
    el.style.zIndex = boardZTop;
    updateDoc(boardItemRef(item.id), { z: boardZTop });
  });

  // Dragging: images drag from anywhere, text items from their handle bar
  const dragTargets = item.type === "image" ? [el] : [dragBar];
  for (const target of dragTargets) {
    target.addEventListener("pointerdown", (e) => {
      if (e.target === rez || e.target === del) return;
      e.preventDefault();
      startDrag(e, el, item, "move");
    });
  }
  rez.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startDrag(e, el, item, "resize");
  });

  return el;
}

function startDrag(e, el, item, mode) {
  el.classList.add("dragging");
  const startX = e.clientX;
  const startY = e.clientY;
  const orig = { x: item.x || 20, y: item.y || 20, w: item.w || 240, h: item.h || 140 };

  function onMove(ev) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (mode === "move") {
      item.x = Math.max(0, orig.x + dx);
      item.y = Math.max(24, orig.y + dy);
      el.style.left = item.x + "px";
      el.style.top = item.y + "px";
    } else {
      item.w = Math.max(80, orig.w + dx);
      item.h = Math.max(50, orig.h + dy);
      el.style.width = item.w + "px";
      el.style.height = item.h + "px";
    }
  }
  function onUp() {
    el.classList.remove("dragging");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    updateDoc(boardItemRef(item.id), { x: item.x, y: item.y, w: item.w, h: item.h });
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/** Keep a plain-text copy of all text items on the trackable doc for search. */
function syncContentText() {
  const text = boardItems
    .filter((i) => i.type === "text")
    .map((i) => i.text || "")
    .join("\n");
  updateDoc(trackableRef(viewingTrackable.id), { contentText: text });
  viewingTrackable.contentText = text;
}

// ---------- Adding board items ----------
async function addBoardItem(data) {
  boardZTop += 1;
  const item = { ...data, z: boardZTop, createdAt: serverTimestamp() };
  const ref = await addDoc(collection(trackableRef(viewingTrackable.id), "board"), item);
  const local = { ...item, id: ref.id };
  boardItems.push(local);
  $("board").appendChild(renderBoardItem(local));
  return local;
}

$("board-add-text").addEventListener("click", async () => {
  const wrap = $("board-wrap");
  const item = await addBoardItem({
    type: "text",
    text: "",
    x: wrap.scrollLeft + 60,
    y: wrap.scrollTop + 60,
    w: 260,
    h: 140,
  });
  // Focus the new text box
  const el = $("board").querySelector(`[data-id="${item.id}"] .item-body`);
  el?.focus();
  syncContentText();
});

// ---------- Images: compression + drop + file picker ----------
const MAX_IMAGE_BYTES = 350 * 1024;

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
      throw new Error(`"${file.name}" is too big — GIFs must be under ${Math.round(MAX_IMAGE_BYTES / 1024)} KB to keep their animation.`);
    }
    return rawUrl;
  }

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

function showBoardError(msg) {
  const el = $("board-error");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 6000);
}

async function addImageFiles(files, dropX, dropY) {
  let offset = 0;
  for (const file of files) {
    if (!/^image\/(jpeg|png|gif)$/.test(file.type)) {
      showBoardError(`"${file.name}" isn't a JPEG, PNG, or GIF.`);
      continue;
    }
    try {
      const src = await compressImage(file);
      // Natural size scaled down to a reasonable board footprint
      const probe = new Image();
      await new Promise((res) => { probe.onload = res; probe.src = src; });
      const scale = Math.min(1, 360 / Math.max(probe.width, probe.height));
      await addBoardItem({
        type: "image",
        src,
        x: dropX + offset,
        y: dropY + offset,
        w: Math.round(probe.width * scale),
        h: Math.round(probe.height * scale),
      });
      offset += 24;
    } catch (err) {
      showBoardError(err.message);
    }
  }
}

$("board-image-input").addEventListener("change", async (e) => {
  const wrap = $("board-wrap");
  await addImageFiles([...e.target.files], wrap.scrollLeft + 80, wrap.scrollTop + 80);
  e.target.value = "";
});

// Drag & drop onto the board
{
  const board = $("board");
  board.addEventListener("dragover", (e) => {
    e.preventDefault();
    board.classList.add("drag-over");
  });
  board.addEventListener("dragleave", () => board.classList.remove("drag-over"));
  board.addEventListener("drop", async (e) => {
    e.preventDefault();
    board.classList.remove("drag-over");
    const rect = board.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left);
    const y = Math.max(24, e.clientY - rect.top);
    await addImageFiles([...e.dataTransfer.files], x, y);
  });
}

// ============================================================
// Link picker
// ============================================================
$("tview-link-btn").addEventListener("click", () => {
  const t = viewingTrackable;
  const list = $("link-list");
  list.innerHTML = "";
  const others = trackables.filter((x) => x.id !== t.id);
  if (!others.length) {
    list.innerHTML = `<p class="hint">No other trackables to link yet.</p>`;
  }
  for (const other of others) {
    const label = document.createElement("label");
    label.className = "link-option";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = other.id;
    cb.checked = (t.relatedIds || []).includes(other.id);
    const name = document.createElement("span");
    name.className = "link-name";
    name.style.color = titleColor(other);
    name.textContent = `${categoryEmoji(other)} ${other.name}`.trim();
    label.append(cb, name);
    list.appendChild(label);
  }
  $("link-modal").classList.remove("hidden");
});

$("link-cancel").addEventListener("click", () => $("link-modal").classList.add("hidden"));

$("link-save").addEventListener("click", async () => {
  const t = viewingTrackable;
  const selected = new Set(
    [...$("link-list").querySelectorAll("input:checked")].map((cb) => cb.value)
  );
  const before = new Set(t.relatedIds || []);
  const batch = writeBatch(db);

  for (const id of selected) {
    if (!before.has(id)) {
      batch.update(trackableRef(t.id), { relatedIds: arrayUnion(id) });
      batch.update(trackableRef(id), { relatedIds: arrayUnion(t.id) });
    }
  }
  for (const id of before) {
    if (!selected.has(id)) {
      batch.update(trackableRef(t.id), { relatedIds: arrayRemove(id) });
      batch.update(trackableRef(id), { relatedIds: arrayRemove(t.id) });
    }
  }
  await batch.commit();
  t.relatedIds = [...selected];
  renderTviewHeader();
  $("link-modal").classList.add("hidden");
});

// ============================================================
// Developer menu
// ============================================================
$("dev-btn").addEventListener("click", () => $("dev-modal").classList.remove("hidden"));
$("dev-close").addEventListener("click", () => $("dev-modal").classList.add("hidden"));

$("dev-clear-btn").addEventListener("click", async () => {
  if (!confirm("Really delete ALL Dunzo data in Firebase for your account? This cannot be undone.")) return;
  if (!confirm("Last chance — every trackable, category, and whiteboard item will be permanently deleted. Continue?")) return;

  const status = $("dev-status");
  status.textContent = "Clearing…";
  try {
    const uid = currentUser.uid;
    const trackSnap = await getDocs(collection(db, "users", uid, "trackables"));
    for (const tDoc of trackSnap.docs) {
      // Delete subcollections ("board" whiteboards, plus legacy "notes")
      for (const sub of ["board", "notes"]) {
        const subSnap = await getDocs(collection(tDoc.ref, sub));
        if (!subSnap.empty) {
          const batch = writeBatch(db);
          subSnap.forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
      }
      await deleteDoc(tDoc.ref);
    }
    await deleteDoc(doc(db, "users", uid));
    activeTagFilter = null;
    status.textContent = "All data cleared ✓";
  } catch (err) {
    status.textContent = "Error: " + err.message;
  }
});
