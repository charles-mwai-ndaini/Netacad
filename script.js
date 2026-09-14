/* ═══════════════════════════════════════════════════════════════
   NETACAD TRAINER — PERFORMANCE MANAGEMENT SYSTEM
   script.js  (Firebase Cloud Firestore + Firebase Authentication)

   Data layer notes:
   - `cache` is a local in-memory mirror of Firestore, shaped exactly
     like the old localStorage object: {students, attendance,
     moduleScores, examScores, settings}. All render functions read
     from `cache`, unchanged from the original version.
   - `cache` is kept in sync automatically by Firestore "onSnapshot"
     real-time listeners (see attachRealtimeListeners). Any change —
     from this device or any other logged-in device — updates
     `cache` and re-renders the active page within ~1 second.
   - All writes (add/edit/delete) now go straight to Firestore using
     async/await. We no longer write to `cache` directly after a
     write; we let the snapshot listener do that, which is what
     keeps every open tab/device in sync.
═══════════════════════════════════════════════════════════════ */

const MODULES = Array.from({length:14}, (_,i) => `m${i+1}`);
const MODULE_LABELS = Array.from({length:14}, (_,i) => `Module ${i+1}`);
const EXAMS  = ["mt1","et1","mt2","et2","mt3","et3"];
const EXAM_LABELS = ["Mid-Term 1","End-Term 1","Mid-Term 2","End-Term 2","Mid-Term 3","End-Term 3"];

// Classes your students can be assigned to. Add, rename, or remove
// entries here any time — every dropdown in the app reads from this
// single list, so there's only one place to edit.
const CLASSES = ["Grade 6", "Grade 7", "Grade 8 Lochoredome 2026", "Grade 9"];

const charts = {};
let editingStudentId = null;
let profileStudentId = null;
let currentPage = "dashboard";

// In-memory mirror of Firestore — render functions read this, exactly
// like they used to read the parsed localStorage object.
let cache = emptyDB();

// Holds the unsubscribe() functions returned by onSnapshot, so we can
// detach all listeners cleanly on logout.
let unsubscribers = [];

function emptyDB() {
  return {
    students: [],
    attendance: {},
    moduleScores: {},
    examScores: {},
    settings: { darkMode: false }
  };
}

// loadData() is kept so every existing render function (which calls
// `const db = loadData();`) keeps working untouched — it now just
// returns the live cache instead of reading localStorage.
function loadData() {
  return cache;
}

// ─── LOADING / TOAST UI HELPERS ───
function showLoading(msg = "Syncing with Firebase…") {
  const el = document.getElementById("global-loader");
  if (!el) return;
  el.querySelector("span").textContent = msg;
  el.style.display = "flex";
}

function hideLoading() {
  const el = document.getElementById("global-loader");
  if (el) el.style.display = "none";
}

function showToast(msg, type = "success") {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.style.background = type === "danger" ? "#e53e3e" : type === "warning" ? "#d69e2e" : "#2b6cb0";
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2800);
}

function friendlyFirebaseError(err) {
  const code = err && err.code ? err.code : "";
  const map = {
    "auth/email-already-in-use": "That email is already registered.",
    "auth/invalid-email": "That email address looks invalid.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/too-many-requests": "Too many attempts. Please wait and try again.",
    "auth/network-request-failed": "Network error — check your internet connection.",
    "permission-denied": "You don't have permission to do that.",
    "unavailable": "Can't reach Firebase right now — check your internet connection."
  };
  return map[code] || (err && err.message) || "Something went wrong. Please try again.";
}

// ─── UTILITIES (unchanged from original) ───
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function calculateAverage(values) {
  const valid = values.filter(v => v !== null && v !== undefined && v !== "" && !isNaN(Number(v)));
  if (!valid.length) return null;
  return valid.reduce((s, v) => s + Number(v), 0) / valid.length;
}

function initials(name) {
  return name.trim().split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
}

function scoreBadge(score) {
  if (score === null || isNaN(score)) return "";
  if (score >= 70) return "badge-success";
  if (score >= 50) return "badge-warning";
  return "badge-danger";
}

function r1(n) {
  return n !== null && !isNaN(n) ? Math.round(n * 10) / 10 : "—";
}

// ─── LIGHTWEIGHT CSV HELPERS (no external library needed) ───
// Parses CSV text into { headers: [...], rows: [{header: value, ...}] }.
// Handles quoted fields containing commas/newlines/escaped quotes.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') pushField();
      else if (c === '\r') { /* ignore */ }
      else if (c === '\n') { pushField(); pushRow(); }
      else field += c;
    }
  }
  if (field.length || row.length) { pushField(); pushRow(); }

  const cleaned = rows.filter(r => r.some(v => v.trim() !== ""));
  if (!cleaned.length) return { headers: [], rows: [] };
  const headers = cleaned[0].map(h => h.trim());
  const dataRows = cleaned.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => obj[h] = (r[idx] !== undefined ? r[idx].trim() : ""));
    return obj;
  });
  return { headers, rows: dataRows };
}

function csvField(val) {
  const s = (val === null || val === undefined) ? "" : String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCSV(headers, rows) {
  const lines = [headers.map(csvField).join(",")];
  rows.forEach(r => lines.push(headers.map(h => csvField(r[h])).join(",")));
  return lines.join("\r\n");
}

function downloadCSV(filename, csvText) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// Case/whitespace-insensitive lookup of a student by name within a list.
function findStudentByName(students, name) {
  const norm = (name || "").trim().toLowerCase();
  if (!norm) return null;
  return students.find(s => s.name.trim().toLowerCase() === norm) || null;
}

function destroyChart(key) {
  if (charts[key]) {
    charts[key].destroy();
    delete charts[key];
  }
}

// Fills a "filter by class" <select> (which already has a static
// "All Classes" placeholder option in the HTML) with one option per
// entry in CLASSES. Only runs once per element — re-renders won't
// wipe out whatever the user currently has selected.
function populateClassFilter(selectEl) {
  if (!selectEl || selectEl.dataset.populated) return;
  CLASSES.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    selectEl.appendChild(opt);
  });
  selectEl.dataset.populated = "true";
}

// Fills the Add/Edit Student modal's class <select>, including an
// "Unassigned" option, and pre-selects the student's current class.
function populateModalClassSelect(selected) {
  const sel = document.getElementById('student-class-input');
  if (!sel) return;
  sel.innerHTML = `<option value="">— Unassigned —</option>` +
    CLASSES.map(c => `<option value="${c}">${c}</option>`).join("");
  sel.value = selected || "";
}

function allAttendanceDates(db) {
  return Object.keys(db.attendance || {}).sort();
}

// Returns the list of students belonging to a class ("" = every student).
function studentsInClass(db, className) {
  return className ? db.students.filter(s => s.class === className) : db.students;
}

// Aggregate average/attendance stats for a group of students — used to
// build per-class breakdown tables on Dashboard & Analytics.
function getGroupStats(db, students) {
  const overalls = [], atts = [], modAvgs = [], examAvgs = [];
  students.forEach(s => {
    const stats = getStudentStats(db, s);
    if (stats.overall !== null) overalls.push(stats.overall);
    if (stats.attendance.pct !== null) atts.push(stats.attendance.pct);
    if (stats.modAvg !== null) modAvgs.push(stats.modAvg);
    if (stats.examAvg !== null) examAvgs.push(stats.examAvg);
  });
  return {
    count: students.length,
    overall: calculateAverage(overalls),
    attendance: calculateAverage(atts),
    modAvg: calculateAverage(modAvgs),
    examAvg: calculateAverage(examAvgs)
  };
}

// Renders a small "per class" summary table into the given element id.
function renderClassBreakdownTable(db, elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const classesPresent = CLASSES.filter(c => db.students.some(s => s.class === c));
  const unassigned = db.students.some(s => !s.class);
  const groups = classesPresent.map(c => ({ label: c, students: studentsInClass(db, c) }));
  if (unassigned) groups.push({ label: "Unassigned", students: db.students.filter(s => !s.class) });

  if (!groups.length) {
    el.innerHTML = `<p style="color:var(--text-muted)">No students yet.</p>`;
    return;
  }

  el.innerHTML = `<table class="data-table">
    <thead><tr><th>Class</th><th>Students</th><th>Module Avg</th><th>Exam Avg</th><th>Overall Avg</th><th>Attendance</th></tr></thead>
    <tbody>
      ${groups.map(g => {
        const gs = getGroupStats(db, g.students);
        return `<tr>
          <td><strong>${g.label}</strong></td>
          <td>${gs.count}</td>
          <td>${gs.modAvg !== null ? r1(gs.modAvg) + "%" : "—"}</td>
          <td>${gs.examAvg !== null ? r1(gs.examAvg) + "%" : "—"}</td>
          <td>${gs.overall !== null ? `<span class="badge ${scoreBadge(gs.overall)}">${r1(gs.overall)}%</span>` : "—"}</td>
          <td>${gs.attendance !== null ? r1(gs.attendance) + "%" : "—"}</td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>`;
}

function getModuleScores(db, studentOrId) {
  const id = (typeof studentOrId === "string") ? studentOrId : studentOrId.id;
  const s  = db.moduleScores[id] || {};
  return MODULES.map(k => (s[k] !== undefined && s[k] !== "") ? Number(s[k]) : null);
}

function getExamScores(db, studentOrId) {
  const id = (typeof studentOrId === "string") ? studentOrId : studentOrId.id;
  const s  = db.examScores[id] || {};
  return EXAMS.map(k => (s[k] !== undefined && s[k] !== "") ? Number(s[k]) : null);
}

function getAttendanceStats(db, studentId) {
  let present = 0, absent = 0;
  const dates = allAttendanceDates(db);
  for (const date of dates) {
    const rec = db.attendance[date][studentId];
    if (rec === "present") present++;
    else if (rec === "absent") absent++;
  }
  const total = present + absent;
  const pct = total > 0 ? (present / total) * 100 : null;
  return { present, absent, total, pct };
}

function getStudentStats(db, student) {
  const mScores = getModuleScores(db, student.id);
  const eScores = getExamScores(db, student.id);
  const att     = getAttendanceStats(db, student.id);
  const modAvg  = calculateAverage(mScores);
  const examAvg = calculateAverage(eScores);
  const allScores = [...mScores, ...eScores].filter(v => v !== null && !isNaN(v));
  const overall = calculateAverage([modAvg, examAvg].filter(v => v !== null));
  return { modAvg, examAvg, overall, highScore: allScores.length ? Math.max(...allScores) : null, lowScore: allScores.length ? Math.min(...allScores) : null, attendance: att, mScores, eScores };
}

// ─── AUTHENTICATION (Firebase Authentication) ───
function switchAuthCard(cardType) {
  document.querySelectorAll('.auth-card').forEach(c => c.classList.remove('active'));
  if (cardType === 'login') {
    document.getElementById('auth-login-card').classList.add('active');
  } else if (cardType === 'recover') {
    document.getElementById('auth-recover-card').classList.add('active');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  showLoading("Signing in…");
  try {
    await auth.signInWithEmailAndPassword(email, password);
    document.getElementById('login-form').reset();
    // onAuthStateChanged handles showing the dashboard.
  } catch (err) {
    showToast(friendlyFirebaseError(err), "danger");
  } finally {
    hideLoading();
  }
}

// Password recovery now uses Firebase's built-in "reset password by
// email" flow instead of a custom security question (Firebase does
// not support storing/verifying secret answers, and rolling that
// ourselves would be far less secure than Firebase's own flow).
async function handleFindUser(e) {
  e.preventDefault();
  const email = document.getElementById('recover-username').value.trim();
  showLoading("Sending reset email…");
  try {
    await auth.sendPasswordResetEmail(email);
    showToast("Password reset email sent! Check your inbox. ✓");
    document.getElementById('recover-step1').reset();
    switchAuthCard('login');
  } catch (err) {
    showToast(friendlyFirebaseError(err), "danger");
  } finally {
    hideLoading();
  }
}

async function handleLogout() {
  await auth.signOut();
  showToast("Logged out safely.");
}

// Fires whenever sign-in state changes: on first load, after login,
// after registration, and after logout. This is the single source of
// truth for whether the dashboard or the auth screen is shown.
auth.onAuthStateChanged((user) => {
  const authScreen = document.getElementById('auth-screen');
  if (user) {
    if (authScreen) authScreen.style.display = 'none';
    showLoading("Loading your data…");
    attachRealtimeListeners();
    showToast(`Welcome back, ${user.email}! 👋`);
    showPage('dashboard');
    hideLoading();
  } else {
    detachRealtimeListeners();
    cache = emptyDB();
    if (authScreen) authScreen.style.display = 'flex';
    switchAuthCard('login');
  }
});

// ─── REAL-TIME FIRESTORE SYNC ───
// Each listener keeps one slice of `cache` perfectly in sync with
// Firestore, for every logged-in user/device, automatically.
function attachRealtimeListeners() {
  detachRealtimeListeners(); // safety: never double-subscribe

  unsubscribers.push(
    db.collection('students').orderBy('name').onSnapshot(snap => {
      cache.students = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      onDataChange();
    }, err => showToast(friendlyFirebaseError(err), "danger"))
  );

  unsubscribers.push(
    db.collection('moduleScores').onSnapshot(snap => {
      const next = {};
      snap.forEach(d => next[d.id] = d.data());
      cache.moduleScores = next;
      onDataChange();
    }, err => showToast(friendlyFirebaseError(err), "danger"))
  );

  unsubscribers.push(
    db.collection('examScores').onSnapshot(snap => {
      const next = {};
      snap.forEach(d => next[d.id] = d.data());
      cache.examScores = next;
      onDataChange();
    }, err => showToast(friendlyFirebaseError(err), "danger"))
  );

  unsubscribers.push(
    db.collection('attendance').onSnapshot(snap => {
      const next = {};
      snap.forEach(d => next[d.id] = d.data());
      cache.attendance = next;
      onDataChange();
    }, err => showToast(friendlyFirebaseError(err), "danger"))
  );

  unsubscribers.push(
    db.collection('settings').doc('app').onSnapshot(doc => {
      cache.settings = doc.exists ? doc.data() : { darkMode: false };
      applyTheme(cache);
      onDataChange();
    }, err => showToast(friendlyFirebaseError(err), "danger"))
  );
}

function detachRealtimeListeners() {
  unsubscribers.forEach(unsub => unsub());
  unsubscribers = [];
}

// Called every time any Firestore listener fires. Re-renders whatever
// page is currently on screen so it always reflects the latest data —
// this is what makes edits from other devices appear automatically.
function onDataChange() {
  if (currentPage === "dashboard")    renderDashboard();
  if (currentPage === "students")     renderStudentList();
  if (currentPage === "profile" && profileStudentId) renderProfile(profileStudentId);
  if (currentPage === "attendance")   loadAttendanceForDate();
  if (currentPage === "modules")      renderModuleTable();
  if (currentPage === "schoolexams")  renderExamTable();
  if (currentPage === "analytics")    renderAnalytics();
  if (currentPage === "datamanage")   renderDataManage();
}

// ─── PAGES NAVIGATION ───
function showPage(pageId) {
  currentPage = pageId;
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));

  const target = document.getElementById(`page-${pageId}`);
  if (target) target.classList.add("active");

  const navItem = document.querySelector(`[data-page="${pageId}"]`);
  if (navItem) navItem.classList.add("active");

  const titles = { dashboard:"Dashboard", students:"Students", profile:"Student Profile", attendance:"Attendance", modules:"Module Exams", schoolexams:"School Exams", analytics:"Analytics", datamanage:"Data Management" };
  document.getElementById("page-title").textContent = titles[pageId] || pageId;

  if (pageId === "dashboard")  renderDashboard();
  if (pageId === "students")   renderStudentList();
  if (pageId === "attendance") renderAttendancePage();
  if (pageId === "modules")    renderModuleTable();
  if (pageId === "schoolexams") renderExamTable();
  if (pageId === "analytics")  renderAnalytics();
  if (pageId === "datamanage") renderDataManage();

  if (window.innerWidth < 768) document.getElementById("sidebar").classList.remove("open");
}

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("open");
}

function closeModal(e, id) {
  if (e.target.classList.contains("modal-overlay"))
    document.getElementById(id).classList.remove("open");
}

async function toggleDarkMode() {
  const isDark = document.body.classList.toggle("dark-mode");
  document.body.classList.toggle("light-mode", !isDark);
  document.getElementById("theme-icon").textContent  = isDark ? "☀" : "🌙";
  document.getElementById("theme-label").textContent = isDark ? "Light Mode" : "Dark Mode";
  try {
    await db.collection('settings').doc('app').set({ darkMode: isDark }, { merge: true });
  } catch (err) {
    showToast(friendlyFirebaseError(err), "danger");
  }
}

function applyTheme(db) {
  const isDark = !!(db.settings && db.settings.darkMode);
  document.body.classList.toggle("dark-mode", isDark);
  document.body.classList.toggle("light-mode", !isDark);
  const icon = document.getElementById("theme-icon");
  const label = document.getElementById("theme-label");
  if (icon)  icon.textContent  = isDark ? "☀" : "🌙";
  if (label) label.textContent = isDark ? "Light Mode" : "Dark Mode";
}

// ─── STUDENT ACTIONS ───
function openAddStudentModal() {
  editingStudentId = null;
  document.getElementById("modal-title").textContent = "Add Student";
  document.getElementById("student-name-input").value = "";
  populateModalClassSelect("");
  document.getElementById("modal-save-btn").textContent = "Add Student";
  document.getElementById("student-modal").classList.add("open");
  setTimeout(() => document.getElementById("student-name-input").focus(), 100);
}

function openEditStudentModal(id) {
  const db = loadData();
  const student = db.students.find(s => s.id === id);
  if (!student) return;
  editingStudentId = id;
  document.getElementById("modal-title").textContent = "Edit Student";
  document.getElementById("student-name-input").value = student.name;
  populateModalClassSelect(student.class || "");
  document.getElementById("modal-save-btn").textContent = "Save Changes";
  document.getElementById("student-modal").classList.add("open");
  setTimeout(() => document.getElementById("student-name-input").focus(), 100);
}

async function saveStudentModal() {
  const name = document.getElementById("student-name-input").value.trim();
  const studentClass = document.getElementById("student-class-input").value;
  if (!name) { showToast("Please enter a student name.", "danger"); return; }

  const dbSnapshot = loadData();
  // Prevent duplicate student records (case-insensitive name match),
  // ignoring the record currently being edited.
  const duplicate = dbSnapshot.students.find(
    s => s.name.toLowerCase() === name.toLowerCase() && s.id !== editingStudentId
  );
  if (duplicate) {
    showToast("⚠ A student with this name already exists.", "danger");
    return;
  }

  showLoading(editingStudentId ? "Saving changes…" : "Adding student…");
  try {
    if (editingStudentId) {
      await db.collection('students').doc(editingStudentId).update({ name, class: studentClass });
    } else {
      const id = generateId();
      await db.collection('students').doc(id).set({
        name,
        class: studentClass,
        comments: "",
        dateAdded: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    document.getElementById("student-modal").classList.remove("open");
    showToast(editingStudentId ? "Student updated ✓" : "Student added ✓");
    editingStudentId = null;
  } catch (err) {
    showToast(friendlyFirebaseError(err), "danger");
  } finally {
    hideLoading();
  }
}

function deleteStudent(id) {
  const db = loadData();
  const student = db.students.find(s => s.id === id);
  if (!student) return;

  document.getElementById("confirm-msg").textContent = `Are you sure you want to delete "${student.name}"? This cannot be undone.`;
  document.getElementById("confirm-action-btn").onclick = async () => {
    showLoading("Deleting student…");
    try {
      // Firestore batched write: delete the student and all of their
      // related records (scores) atomically — either all succeed or
      // none do, so we never end up with orphaned score documents.
      const batch = db.batch();
      batch.delete(db.collection('students').doc(id));
      batch.delete(db.collection('moduleScores').doc(id));
      batch.delete(db.collection('examScores').doc(id));
      await batch.commit();

      // Remove this student from every attendance date document too.
      const attSnap = await db.collection('attendance').get();
      const attBatch = db.batch();
      attSnap.forEach(docSnap => {
        if (docSnap.data()[id] !== undefined) {
          attBatch.update(docSnap.ref, { [id]: firebase.firestore.FieldValue.delete() });
        }
      });
      await attBatch.commit();

      document.getElementById("confirm-modal").classList.remove("open");
      showToast("Student deleted.");
    } catch (err) {
      showToast(friendlyFirebaseError(err), "danger");
    } finally {
      hideLoading();
    }
  };
  document.getElementById("confirm-modal").classList.add("open");
}

function renderStudentList() {
  const db = loadData();
  const query = (document.getElementById("student-search")?.value || "").toLowerCase();
  const classFilterEl = document.getElementById("class-filter");
  populateClassFilter(classFilterEl);
  const classFilter = classFilterEl?.value || "";

  const bulkClassEl = document.getElementById("bulk-student-class");
  if (bulkClassEl && !bulkClassEl.dataset.populated) {
    CLASSES.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c; opt.textContent = c;
      bulkClassEl.appendChild(opt);
    });
    bulkClassEl.dataset.populated = "true";
  }

  const list = document.getElementById("student-list");
  if (!list) return;

  const filtered = db.students.filter(s =>
    s.name.toLowerCase().includes(query) &&
    (!classFilter || s.class === classFilter)
  );
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>No students found</h3></div>`;
    return;
  }

  list.innerHTML = filtered.map(student => {
    const stats = getStudentStats(db, student);
    return `
      <div class="student-card" onclick="openProfile('${student.id}')">
        <div class="student-actions" onclick="event.stopPropagation()">
          <button class="btn btn-ghost btn-sm" onclick="openEditStudentModal('${student.id}')">✎</button>
          <button class="btn btn-danger btn-sm" onclick="deleteStudent('${student.id}')">✕</button>
        </div>
        <div class="student-avatar">${initials(student.name)}</div>
        <div class="student-name">${student.name}</div>
        ${student.class ? `<span class="badge badge-warning" style="margin-bottom:6px;display:inline-block;">${student.class}</span>` : ""}
        <div class="student-stats">
          📊 Overall: <strong>${stats.overall !== null ? r1(stats.overall) + "%" : "—"}</strong><br>
          📋 Attendance: <strong>${stats.attendance.pct !== null ? r1(stats.attendance.pct) + "%" : "—"}</strong>
        </div>
      </div>`;
  }).join("");
}

// ─── PROFILE RENDERING ───
function openProfile(studentId) {
  profileStudentId = studentId;
  renderProfile(studentId);
  showPage("profile");
}

function renderProfile(studentId) {
  const db = loadData();
  const student = db.students.find(s => s.id === studentId);
  if (!student) return;

  const stats = getStudentStats(db, student);
  const rec = generateRecommendations(stats);

  let html = `
    <div class="profile-header">
      <div class="profile-avatar">${initials(student.name)}</div>
      <div>
        <div class="profile-name">${student.name}</div>
        ${student.class ? `<div class="profile-meta">${student.class}</div>` : ""}
      </div>
      <div style="margin-left:auto;">
        <button class="btn btn-primary" onclick="openPrintReport('${studentId}')">🖨 Print Report</button>
      </div>
    </div>
    <div class="profile-stats">
      ${statCard("Overall Avg", stats.overall !== null ? r1(stats.overall) + "%" : "—")}
      ${statCard("Attendance", stats.attendance.pct !== null ? r1(stats.attendance.pct) + "%" : "—")}
    </div>
    <div class="recommendation-card">
      <h3>Recommendations</h3>
      ${rec.map(r => `<div class="recommendation-item">${r.icon} ${r.text}</div>`).join("")}
    </div>
    <div class="profile-charts">
      <div class="chart-card"><h3>Modules</h3><canvas id="profile-module-chart"></canvas></div>
      <div class="chart-card"><h3>Exams</h3><canvas id="profile-exam-chart"></canvas></div>
    </div>
    <div class="comments-section">
      <h3>Teacher Comments</h3>
      <textarea class="comments-textarea" id="comments-input" onchange="saveComments('${studentId}')">${student.comments || ""}</textarea>
    </div>
  `;
  document.getElementById("profile-content").innerHTML = html;
  setTimeout(() => {
    renderProfileModuleChart(stats.mScores);
    renderProfileExamChart(stats.eScores);
  }, 50);
}

function statCard(label, value) {
  return `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`;
}

let commentsSaveTimer = null;
function saveComments(id) {
  const txt = document.getElementById("comments-input").value;
  // Debounce so we don't write to Firestore on every keystroke.
  clearTimeout(commentsSaveTimer);
  commentsSaveTimer = setTimeout(async () => {
    try {
      await db.collection('students').doc(id).update({ comments: txt });
    } catch (err) {
      showToast(friendlyFirebaseError(err), "danger");
    }
  }, 500);
}

function generateRecommendations(stats) {
  const rec = [];
  if (stats.overall !== null && stats.overall < 50) rec.push({ icon: "⚠️", text: "Requires urgent academic support." });
  if (stats.attendance.pct !== null && stats.attendance.pct < 75) rec.push({ icon: "📋", text: "Low attendance is causing lag." });
  if (!rec.length) rec.push({ icon: "✅", text: "Performance is on track." });
  return rec;
}

function renderProfileModuleChart(scores) {
  destroyChart("profileModule");
  const ctx = document.getElementById("profile-module-chart");
  if (!ctx) return;
  charts["profileModule"] = new Chart(ctx, {
    type: "line",
    data: { labels: MODULE_LABELS, datasets: [{ label: "Modules", data: scores, borderColor: "#2b6cb0", fill: false }] },
    options: chartOptions("Score %", 100)
  });
}

function renderProfileExamChart(scores) {
  destroyChart("profileExam");
  const ctx = document.getElementById("profile-exam-chart");
  if (!ctx) return;
  charts["profileExam"] = new Chart(ctx, {
    type: "bar",
    data: { labels: EXAM_LABELS, datasets: [{ label: "Exams", data: scores, backgroundColor: "rgba(43,108,176,0.7)" }] },
    options: chartOptions("Score %", 100)
  });
}

// ─── DASHBOARD RENDERING ───
function renderDashboard() {
  const db = loadData();

  const classFilterEl = document.getElementById("dashboard-class-filter");
  populateClassFilter(classFilterEl);
  const classFilter = classFilterEl?.value || "";

  const bulkPrintFilterEl = document.getElementById("bulk-print-class-filter");
  populateClassFilter(bulkPrintFilterEl);

  const students = studentsInClass(db, classFilter);
  const gs = getGroupStats(db, students);

  document.getElementById("dashboard-stats").innerHTML = `
    ${statCard(classFilter ? `${classFilter} Students` : "Total Students", gs.count)}
    ${statCard(classFilter ? `${classFilter} Average` : "Class Average", gs.overall !== null ? r1(gs.overall) + "%" : "—")}
    ${statCard("Attendance Rate", gs.attendance !== null ? r1(gs.attendance) + "%" : "—")}
  `;

  renderDashModuleChart(db, students);
  renderDashAttendanceChart(db, students);
  renderTopAndSupportLists(db, students);
  renderClassBreakdownTable(db, "dashboard-class-breakdown");
}

function renderTopAndSupportLists(db, students) {
  const topEl = document.getElementById("top-performers");
  const lowEl = document.getElementById("need-support");
  if (!topEl || !lowEl) return;

  const ranked = (students || db.students)
    .map(s => ({ s, overall: getStudentStats(db, s).overall }))
    .filter(r => r.overall !== null)
    .sort((a, b) => b.overall - a.overall);

  topEl.innerHTML = ranked.slice(0, 5).map(r =>
    `<div class="recommendation-item">${r.s.name}${r.s.class ? ` <span class="badge badge-warning" style="font-size:10px;">${r.s.class}</span>` : ""} — <strong>${r1(r.overall)}%</strong></div>`
  ).join("") || `<p>No scored students yet.</p>`;

  lowEl.innerHTML = ranked.slice(-5).reverse().map(r =>
    `<div class="recommendation-item">${r.s.name}${r.s.class ? ` <span class="badge badge-warning" style="font-size:10px;">${r.s.class}</span>` : ""} — <strong>${r1(r.overall)}%</strong></div>`
  ).join("") || `<p>No scored students yet.</p>`;
}

function renderDashModuleChart(db, students) {
  destroyChart("dashModule");
  const ctx = document.getElementById("dash-module-chart");
  if (!ctx) return;
  const pool = students || db.students;
  const avgs = MODULES.map(m => {
    const vals = pool.map(s => db.moduleScores[s.id]?.[m]).filter(v => v !== undefined && v !== "");
    return calculateAverage(vals.map(Number));
  });
  charts["dashModule"] = new Chart(ctx, {
    type: "bar",
    data: { labels: MODULE_LABELS, datasets: [{ label: "Module Avg", data: avgs, backgroundColor: "#2b6cb0" }] },
    options: chartOptions("Score %", 100)
  });
}

function renderDashAttendanceChart(db, students) {
  destroyChart("dashAttendance");
  const ctx = document.getElementById("dash-attendance-chart");
  if (!ctx) return;
  const pool = students || db.students;
  let present = 0, absent = 0;
  pool.forEach(s => {
    const stats = getAttendanceStats(db, s.id);
    present += stats.present;
    absent += stats.absent;
  });
  charts["dashAttendance"] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Present", "Absent"],
      datasets: [{ data: [present, absent], backgroundColor: ["#38a169", "#e53e3e"] }]
    },
    options: { responsive: true, plugins: { legend: { position: "bottom" } } }
  });
}
const KENYAN_FIXED_HOLIDAYS = ["01-01", "05-01", "06-01", "10-10", "10-20", "12-12", "12-25", "12-26"];

function isKenyanHoliday(dateObj) {
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  if (KENYAN_FIXED_HOLIDAYS.includes(`${m}-${d}`)) return true;
  return isEasterHoliday(dateObj.getFullYear(), dateObj);
}

function isEasterHoliday(year, dateObj) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const h = (19 * a + b - Math.floor(b/4) - Math.floor((b - Math.floor((b+8)/25) + 1)/3) + 15) % 30;
  const l = (32 + 2 * (b%4) + 2 * Math.floor(c/4) - h - (c%4)) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const monthIdx = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const dayNum = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = new Date(year, monthIdx, dayNum);

  const gf = new Date(easter); gf.setDate(easter.getDate() - 2);
  const em = new Date(easter); em.setDate(easter.getDate() + 1);
  const t = dateObj.setHours(0,0,0,0);
  return t === gf.setHours(0,0,0,0) || t === em.setHours(0,0,0,0);
}

function renderAttendancePage() {
  const dateInput = document.getElementById("attendance-date");
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().split("T")[0];
  }
  loadAttendanceForDate();
}

function loadAttendanceForDate() {
  const db = loadData();
  const dateStr = document.getElementById("attendance-date").value;
  if (!dateStr) return;

  const targetDate = new Date(dateStr);
  const isWeekend = targetDate.getDay() === 0 || targetDate.getDay() === 6;
  const isHoliday = isKenyanHoliday(targetDate);

  const rec = db.attendance[dateStr] || {};
  const tbody = document.getElementById("attendance-tbody");
  if (!tbody) return;

  const classFilterEl = document.getElementById("attendance-class-filter");
  populateClassFilter(classFilterEl);
  const classFilter = classFilterEl?.value || "";
  const students = db.students.filter(s => !classFilter || s.class === classFilter);

  if (!students.length) {
    tbody.innerHTML = `<tr><td colspan="6">No student logs found.</td></tr>`;
    return;
  }

  tbody.innerHTML = students.map(s => {
    let status = rec[s.id] || "present";
    if (isHoliday) status = "holiday";
    const stats = getAttendanceStats(db, s.id);
    const disabled = (isWeekend || isHoliday) ? "disabled" : "";

    return `
      <tr>
        <td><strong>${s.name}</strong></td>
        <td><button class="present-btn ${status === 'present' ? 'selected' : ''}" ${disabled} onclick="setAttendance('${s.id}','present')">✓ Present</button></td>
        <td><button class="absent-btn ${status === 'absent' ? 'selected' : ''}" ${disabled} onclick="setAttendance('${s.id}','absent')">✗ Absent</button></td>
        <td>${isHoliday ? '<span class="badge badge-warning">🇰🇪 Holiday</span>' : status.toUpperCase()}</td>
        <td>${stats.present}</td>
        <td>${stats.absent}</td>
      </tr>`;
  }).join("");

  renderAttendanceSummaryChart(db, students);
}

function renderAttendanceSummaryChart(db, students) {
  destroyChart("attendanceSummary");
  const ctx = document.getElementById("attendance-summary-chart");
  if (!ctx) return;
  charts["attendanceSummary"] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: students.map(s => s.name),
      datasets: [
        { label: "Present", data: students.map(s => getAttendanceStats(db, s.id).present), backgroundColor: "#38a169" },
        { label: "Absent", data: students.map(s => getAttendanceStats(db, s.id).absent), backgroundColor: "#e53e3e" }
      ]
    },
    options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } }
  });
}

async function setAttendance(studentId, status) {
  const dateStr = document.getElementById("attendance-date").value;
  try {
    await db.collection('attendance').doc(dateStr).set({ [studentId]: status }, { merge: true });
  } catch (err) {
    showToast(friendlyFirebaseError(err), "danger");
  }
}

function saveAttendance() {
  showToast("Attendance registers evaluated and updated! ✓");
}

async function markAllPresent() {
  const dateStr = document.getElementById("attendance-date").value;
  const dbSnapshot = loadData();
  const classFilter = document.getElementById("attendance-class-filter")?.value || "";
  const updates = {};
  dbSnapshot.students.filter(s => !classFilter || s.class === classFilter).forEach(s => updates[s.id] = "present");
  try {
    await db.collection('attendance').doc(dateStr).set(updates, { merge: true });
  } catch (err) {
    showToast(friendlyFirebaseError(err), "danger");
  }
}

async function markAllAbsent() {
  const dateStr = document.getElementById("attendance-date").value;
  const dbSnapshot = loadData();
  const classFilter = document.getElementById("attendance-class-filter")?.value || "";
  const updates = {};
  dbSnapshot.students.filter(s => !classFilter || s.class === classFilter).forEach(s => updates[s.id] = "absent");
  try {
    await db.collection('attendance').doc(dateStr).set(updates, { merge: true });
  } catch (err) {
    showToast(friendlyFirebaseError(err), "danger");
  }
}

function downloadCustomRegister() {
  const db = loadData();
  const start = document.getElementById("register-start-date").value;
  const end = document.getElementById("register-end-date").value;
  if (!start || !end) { showToast("Select dates first.", "warning"); return; }

  const classFilter = document.getElementById("attendance-class-filter")?.value || "";
  const students = studentsInClass(db, classFilter)
    .slice()
    .sort((a, b) => (a.class || "").localeCompare(b.class || "") || a.name.localeCompare(b.name));

  const headers = ["Class", "Student Name", "Total Present", "Total Absent", "Attendance %"];
  const rows = students.map(s => {
    const stats = getAttendanceStats(db, s.id);
    return {
      "Class": s.class || "Unassigned",
      "Student Name": s.name,
      "Total Present": stats.present,
      "Total Absent": stats.absent,
      "Attendance %": stats.pct !== null ? r1(stats.pct) : ""
    };
  });

  const csv = buildCSV(headers, rows);
  const label = classFilter ? classFilter.replace(/\s+/g, "_") : "All_Classes";
  downloadCSV(`Register_${label}_${start}_to_${end}.csv`, csv);
}

// ─── EXAMS RENDERING ───
function renderModuleTable() {
  const db = loadData();
  const query = (document.getElementById("module-search")?.value || "").toLowerCase();
  const classFilterEl = document.getElementById("module-class-filter");
  populateClassFilter(classFilterEl);
  const classFilter = classFilterEl?.value || "";
  document.getElementById("module-thead").innerHTML = `<tr><th>Student</th>${MODULE_LABELS.map(l => `<th>${l}</th>`).join("")}</tr>`;
  const filtered = db.students.filter(s => s.name.toLowerCase().includes(query) && (!classFilter || s.class === classFilter));
  document.getElementById("module-tbody").innerHTML = filtered.map(s => {
    return `<tr><td>${s.name}</td>${MODULES.map(m => `<td><input type="number" min="0" max="100" class="score-input" value="${db.moduleScores[s.id]?.[m] ?? ''}" onchange="saveModScore('${s.id}','${m}',this.value)" /></td>`).join("")}</tr>`;
  }).join("");
}

async function saveModScore(sid, m, val) {
  if (val !== "" && (isNaN(val) || Number(val) < 0 || Number(val) > 100)) {
    showToast("⚠ Score must be a number between 0 and 100.", "danger");
    renderModuleTable();
    return;
  }
  try {
    await db.collection('moduleScores').doc(sid).set({ [m]: val }, { merge: true });
  } catch (err) {
    showToast(friendlyFirebaseError(err), "danger");
  }
}

function saveAllModuleScores() { showToast("Module scores finalized! ✓"); }

function renderExamTable() {
  const db = loadData();
  const query = (document.getElementById("exam-search")?.value || "").toLowerCase();
  const classFilterEl = document.getElementById("exam-class-filter");
  populateClassFilter(classFilterEl);
  const classFilter = classFilterEl?.value || "";
  document.getElementById("exam-thead").innerHTML = `<tr><th>Student</th>${EXAM_LABELS.map(l => `<th>${l}</th>`).join("")}</tr>`;
  const filtered = db.students.filter(s => s.name.toLowerCase().includes(query) && (!classFilter || s.class === classFilter));
  document.getElementById("exam-tbody").innerHTML = filtered.map(s => {
    return `<tr><td>${s.name}</td>${EXAMS.map(e => `<td><input type="number" min="0" max="100" class="score-input" value="${db.examScores[s.id]?.[e] ?? ''}" onchange="saveExamScore('${s.id}','${e}',this.value)" /></td>`).join("")}</tr>`;
  }).join("");
}

async function saveExamScore(sid, e, val) {
  if (val !== "" && (isNaN(val) || Number(val) < 0 || Number(val) > 100)) {
    showToast("⚠ Score must be a number between 0 and 100.", "danger");
    renderExamTable();
    return;
  }
  try {
    await db.collection('examScores').doc(sid).set({ [e]: val }, { merge: true });
  } catch (err) {
    showToast(friendlyFirebaseError(err), "danger");
  }
}

function saveAllExamScores() { showToast("School exam scores saved! ✓"); }

// ─── ANALYTICS & DATA MANAGEMENT ───
function renderAnalytics() {
  const db = loadData();

  const classFilterEl = document.getElementById("analytics-class-filter");
  populateClassFilter(classFilterEl);
  const classFilter = classFilterEl?.value || "";

  const printFilterEl = document.getElementById("analytics-print-class-filter");
  populateClassFilter(printFilterEl);

  const students = studentsInClass(db, classFilter);
  const overalls = students.map(s => getStudentStats(db, s).overall).filter(v => v !== null);
  const classAvg = calculateAverage(overalls);
  const highest = overalls.length ? Math.max(...overalls) : null;
  const lowest = overalls.length ? Math.min(...overalls) : null;

  document.getElementById("analytics-stats").innerHTML = `
    ${statCard(classFilter ? `${classFilter} Students` : "Total Students", students.length)}
    ${statCard(classFilter ? `${classFilter} Average` : "School Average", classAvg !== null ? r1(classAvg) + "%" : "—")}
    ${statCard("Highest Score", highest !== null ? r1(highest) + "%" : "—")}
    ${statCard("Lowest Score", lowest !== null ? r1(lowest) + "%" : "—")}
  `;
  renderClassBreakdownTable(db, "analytics-class-breakdown");
  renderAnalyticsCharts(db, students);
}

function renderAnalyticsCharts(db, students) {
  const pool = students || db.students;
  destroyChart("analyticsModule");
  const modCtx = document.getElementById("analytics-module-chart");
  if (modCtx) {
    const avgs = MODULES.map(m => {
      const vals = pool.map(s => db.moduleScores[s.id]?.[m]).filter(v => v !== undefined && v !== "");
      return calculateAverage(vals.map(Number));
    });
    charts["analyticsModule"] = new Chart(modCtx, {
      type: "bar",
      data: { labels: MODULE_LABELS, datasets: [{ label: "Module Avg", data: avgs, backgroundColor: "#2b6cb0" }] },
      options: chartOptions("Score %", 100)
    });
  }

  destroyChart("analyticsExam");
  const examCtx = document.getElementById("analytics-exam-chart");
  if (examCtx) {
    const avgs = EXAMS.map(ex => {
      const vals = pool.map(s => db.examScores[s.id]?.[ex]).filter(v => v !== undefined && v !== "");
      return calculateAverage(vals.map(Number));
    });
    charts["analyticsExam"] = new Chart(examCtx, {
      type: "bar",
      data: { labels: EXAM_LABELS, datasets: [{ label: "Exam Avg", data: avgs, backgroundColor: "#38a169" }] },
      options: chartOptions("Score %", 100)
    });
  }

  destroyChart("analyticsTop");
  const topCtx = document.getElementById("analytics-top-chart");
  if (topCtx) {
    const ranked = pool
      .map(s => ({ name: s.name + (s.class ? ` (${s.class})` : ""), overall: getStudentStats(db, s).overall }))
      .filter(r => r.overall !== null)
      .sort((a, b) => b.overall - a.overall)
      .slice(0, 10);
    charts["analyticsTop"] = new Chart(topCtx, {
      type: "bar",
      data: { labels: ranked.map(r => r.name), datasets: [{ label: "Overall Avg", data: ranked.map(r => r.overall), backgroundColor: "#d69e2e" }] },
      options: chartOptions("Score %", 100)
    });
  }

  const moduleTable = document.getElementById("module-analysis-table");
  if (moduleTable) {
    moduleTable.innerHTML = `<table class="data-table"><thead><tr><th>Module</th><th>Average</th></tr></thead><tbody>${
      MODULES.map((m, i) => {
        const vals = pool.map(s => db.moduleScores[s.id]?.[m]).filter(v => v !== undefined && v !== "");
        const avg = calculateAverage(vals.map(Number));
        return `<tr><td>${MODULE_LABELS[i]}</td><td>${avg !== null ? r1(avg) + "%" : "—"}</td></tr>`;
      }).join("")
    }</tbody></table>`;
  }
}

function renderDataManage() {
  const db = loadData();
  document.getElementById("storage-usage").innerHTML = `
    <p>${db.students.length} students stored permanently in Cloud Firestore.</p>
    <p>Data is synchronized live across every signed-in device.</p>
  `;
}

function exportData() {
  const blob = new Blob([JSON.stringify(loadData(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "backup.json";
  a.click();
}

// Importing now merges the JSON backup INTO Firestore (rather than
// overwriting localStorage), preserving everyone else's live data.
async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (evt) => {
    showLoading("Importing backup into Firestore…");
    try {
      const incoming = JSON.parse(evt.target.result);
      const batch = db.batch();

      (incoming.students || []).forEach(s => {
        const id = s.id || generateId();
        batch.set(db.collection('students').doc(id), { name: s.name, comments: s.comments || "" }, { merge: true });
      });
      Object.entries(incoming.moduleScores || {}).forEach(([sid, scores]) => {
        batch.set(db.collection('moduleScores').doc(sid), scores, { merge: true });
      });
      Object.entries(incoming.examScores || {}).forEach(([sid, scores]) => {
        batch.set(db.collection('examScores').doc(sid), scores, { merge: true });
      });
      Object.entries(incoming.attendance || {}).forEach(([date, rec]) => {
        batch.set(db.collection('attendance').doc(date), rec, { merge: true });
      });

      await batch.commit();
      showToast("Backup imported and merged into Firestore! ✓");
    } catch (err) {
      showToast(friendlyFirebaseError(err) || "Invalid backup file.", "danger");
    } finally {
      hideLoading();
      document.getElementById('import-file').value = "";
    }
  };
  reader.readAsText(file);
}

function clearAllData() {
  document.getElementById("confirm-msg").textContent =
    "This will permanently delete ALL students, scores, and attendance records for EVERY user. This cannot be undone. Continue?";
  document.getElementById("confirm-action-btn").onclick = async () => {
    showLoading("Deleting all data…");
    try {
      const collections = ['students', 'moduleScores', 'examScores', 'attendance'];
      for (const col of collections) {
        const snap = await db.collection(col).get();
        const batch = db.batch();
        snap.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      document.getElementById("confirm-modal").classList.remove("open");
      showToast("All data permanently cleared.", "warning");
    } catch (err) {
      showToast(friendlyFirebaseError(err), "danger");
    } finally {
      hideLoading();
    }
  };
  document.getElementById("confirm-modal").classList.add("open");
}

async function handleBulkStudentUpload() {
  const fileInput = document.getElementById('bulk-student-file');
  if (!fileInput || fileInput.files.length === 0) { showToast("Select file first.", "danger"); return; }
  const studentClass = document.getElementById('bulk-student-class')?.value || "";

  const reader = new FileReader();
  reader.onload = async function(e) {
    const lines = e.target.result.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) { showToast("File is empty.", "danger"); return; }

    showLoading(`Importing ${lines.length} students…`);
    try {
      const dbSnapshot = loadData();
      const existingNames = new Set(dbSnapshot.students.map(s => s.name.toLowerCase()));
      const batch = db.batch();
      let added = 0, skipped = 0;

      lines.forEach(name => {
        if (existingNames.has(name.toLowerCase())) { skipped++; return; }
        existingNames.add(name.toLowerCase());
        const id = generateId();
        batch.set(db.collection('students').doc(id), {
          name,
          class: studentClass,
          comments: "",
          dateAdded: firebase.firestore.FieldValue.serverTimestamp()
        });
        added++;
      });

      await batch.commit();
      showToast(`Roster updated: ${added} added${skipped ? `, ${skipped} duplicates skipped` : ""}. ✓`);
    } catch (err) {
      showToast(friendlyFirebaseError(err), "danger");
    } finally {
      hideLoading();
      fileInput.value = "";
    }
  };
  reader.readAsText(fileInput.files[0]);
}

// ─── BULK SCORE UPLOAD (Modules & Exams) ───
// Generates a CSV template pre-filled with current (filtered) students
// and their existing scores, so trainers can edit offline in Excel/Sheets
// and re-upload without retyping names.
function downloadModuleScoreTemplate() {
  const db = loadData();
  const classFilter = document.getElementById("module-class-filter")?.value || "";
  const students = studentsInClass(db, classFilter)
    .slice().sort((a, b) => a.name.localeCompare(b.name));
  const headers = ["Name", "Class", ...MODULE_LABELS];
  const rows = students.map(s => {
    const row = { "Name": s.name, "Class": s.class || "" };
    MODULES.forEach((m, i) => row[MODULE_LABELS[i]] = db.moduleScores[s.id]?.[m] ?? "");
    return row;
  });
  downloadCSV(`Module_Scores_Template_${classFilter ? classFilter.replace(/\s+/g,'_') : 'All_Classes'}.csv`, buildCSV(headers, rows));
}

async function handleBulkModuleUpload() {
  const fileInput = document.getElementById('bulk-module-file');
  if (!fileInput || fileInput.files.length === 0) { showToast("Select a CSV file first.", "danger"); return; }

  const reader = new FileReader();
  reader.onload = async function (e) {
    const { headers, rows } = parseCSV(e.target.result);
    if (!rows.length) { showToast("CSV file is empty or unreadable.", "danger"); return; }

    // Map each recognized column header back to its module key (m1..m14),
    // matching case-insensitively against MODULE_LABELS ("Module 1" etc.)
    const colToModule = {};
    headers.forEach(h => {
      const idx = MODULE_LABELS.findIndex(l => l.toLowerCase() === h.trim().toLowerCase());
      if (idx !== -1) colToModule[h] = MODULES[idx];
    });
    if (!Object.keys(colToModule).length) {
      showToast("⚠ No recognizable module columns found in CSV.", "danger");
      return;
    }

    showLoading("Uploading module scores…");
    try {
      const db2 = loadData();
      const batch = db.batch();
      let updatedStudents = 0, scoreWrites = 0, unmatched = [], invalid = [];

      rows.forEach(row => {
        const student = findStudentByName(db2.students, row["Name"]);
        if (!student) { if (row["Name"]) unmatched.push(row["Name"]); return; }

        const updates = {};
        let hasUpdate = false;
        Object.entries(colToModule).forEach(([col, key]) => {
          const raw = (row[col] || "").trim();
          if (raw === "") return;
          if (isNaN(raw) || Number(raw) < 0 || Number(raw) > 100) {
            invalid.push(`${student.name} — ${col}: "${raw}"`);
            return;
          }
          updates[key] = raw;
          hasUpdate = true;
          scoreWrites++;
        });
        if (hasUpdate) {
          batch.set(db.collection('moduleScores').doc(student.id), updates, { merge: true });
          updatedStudents++;
        }
      });

      if (scoreWrites) await batch.commit();

      let msg = `${scoreWrites} score(s) updated for ${updatedStudents} student(s). ✓`;
      if (unmatched.length) msg += ` ${unmatched.length} name(s) not matched.`;
      showToast(msg, invalid.length || unmatched.length ? "warning" : "success");
      if (invalid.length) console.warn("Skipped invalid module scores:", invalid);
      if (unmatched.length) console.warn("Unmatched student names:", unmatched);
    } catch (err) {
      showToast(friendlyFirebaseError(err), "danger");
    } finally {
      hideLoading();
      fileInput.value = "";
    }
  };
  reader.readAsText(fileInput.files[0]);
}

function downloadExamScoreTemplate() {
  const db = loadData();
  const classFilter = document.getElementById("exam-class-filter")?.value || "";
  const students = studentsInClass(db, classFilter)
    .slice().sort((a, b) => a.name.localeCompare(b.name));
  const headers = ["Name", "Class", ...EXAM_LABELS];
  const rows = students.map(s => {
    const row = { "Name": s.name, "Class": s.class || "" };
    EXAMS.forEach((ex, i) => row[EXAM_LABELS[i]] = db.examScores[s.id]?.[ex] ?? "");
    return row;
  });
  downloadCSV(`Exam_Scores_Template_${classFilter ? classFilter.replace(/\s+/g,'_') : 'All_Classes'}.csv`, buildCSV(headers, rows));
}

async function handleBulkExamUpload() {
  const fileInput = document.getElementById('bulk-exam-file');
  if (!fileInput || fileInput.files.length === 0) { showToast("Select a CSV file first.", "danger"); return; }

  const reader = new FileReader();
  reader.onload = async function (e) {
    const { headers, rows } = parseCSV(e.target.result);
    if (!rows.length) { showToast("CSV file is empty or unreadable.", "danger"); return; }

    const colToExam = {};
    headers.forEach(h => {
      const idx = EXAM_LABELS.findIndex(l => l.toLowerCase() === h.trim().toLowerCase());
      if (idx !== -1) colToExam[h] = EXAMS[idx];
    });
    if (!Object.keys(colToExam).length) {
      showToast("⚠ No recognizable exam columns found in CSV.", "danger");
      return;
    }

    showLoading("Uploading exam scores…");
    try {
      const db2 = loadData();
      const batch = db.batch();
      let updatedStudents = 0, scoreWrites = 0, unmatched = [], invalid = [];

      rows.forEach(row => {
        const student = findStudentByName(db2.students, row["Name"]);
        if (!student) { if (row["Name"]) unmatched.push(row["Name"]); return; }

        const updates = {};
        let hasUpdate = false;
        Object.entries(colToExam).forEach(([col, key]) => {
          const raw = (row[col] || "").trim();
          if (raw === "") return;
          if (isNaN(raw) || Number(raw) < 0 || Number(raw) > 100) {
            invalid.push(`${student.name} — ${col}: "${raw}"`);
            return;
          }
          updates[key] = raw;
          hasUpdate = true;
          scoreWrites++;
        });
        if (hasUpdate) {
          batch.set(db.collection('examScores').doc(student.id), updates, { merge: true });
          updatedStudents++;
        }
      });

      if (scoreWrites) await batch.commit();

      let msg = `${scoreWrites} score(s) updated for ${updatedStudents} student(s). ✓`;
      if (unmatched.length) msg += ` ${unmatched.length} name(s) not matched.`;
      showToast(msg, invalid.length || unmatched.length ? "warning" : "success");
      if (invalid.length) console.warn("Skipped invalid exam scores:", invalid);
      if (unmatched.length) console.warn("Unmatched student names:", unmatched);
    } catch (err) {
      showToast(friendlyFirebaseError(err), "danger");
    } finally {
      hideLoading();
      fileInput.value = "";
    }
  };
  reader.readAsText(fileInput.files[0]);
}

// ─── PRINTABLE REPORTS ───
// Builds the full, presentable HTML for a single student's report.
// Reuses the .report-* classes already defined in style.css.
function buildStudentReportHTML(db, student) {
  const stats = getStudentStats(db, student);
  const rec = generateRecommendations(stats);
  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });

  const moduleRows = MODULES.map((m, i) => {
    const val = db.moduleScores[student.id]?.[m];
    const num = (val !== undefined && val !== "") ? Number(val) : null;
    return `<tr>
      <td>${MODULE_LABELS[i]}</td>
      <td>${num !== null ? r1(num) + "%" : "—"}</td>
      <td>${num !== null ? `<span class="badge ${scoreBadge(num)}">${num >= 70 ? "Proficient" : num >= 50 ? "Developing" : "Needs Support"}</span>` : "—"}</td>
    </tr>`;
  }).join("");

  const examRows = EXAMS.map((ex, i) => {
    const val = db.examScores[student.id]?.[ex];
    const num = (val !== undefined && val !== "") ? Number(val) : null;
    return `<tr>
      <td>${EXAM_LABELS[i]}</td>
      <td>${num !== null ? r1(num) + "%" : "—"}</td>
      <td>${num !== null ? `<span class="badge ${scoreBadge(num)}">${num >= 70 ? "Proficient" : num >= 50 ? "Developing" : "Needs Support"}</span>` : "—"}</td>
    </tr>`;
  }).join("");

  return `
    <div class="report-page">
      <div class="report-letterhead">
        <div class="report-letterhead-icon">🎓</div>
        <div>
          <div class="report-org-name">NetAcad Trainer — Performance Management System</div>
          <div class="report-subtitle">Official Student Performance Report · Generated ${today}</div>
        </div>
      </div>

      <div class="report-section">
        <div class="report-title">${student.name}</div>
        <div class="report-subtitle">${student.class ? `Class: ${student.class}` : "Class: Unassigned"} &nbsp;·&nbsp; Student ID: ${student.id}</div>
      </div>

      <div class="report-grid">
        ${reportStat("Overall Average", stats.overall !== null ? r1(stats.overall) + "%" : "—")}
        ${reportStat("Attendance Rate", stats.attendance.pct !== null ? r1(stats.attendance.pct) + "%" : "—")}
        ${reportStat("Highest Score", stats.highScore !== null ? r1(stats.highScore) + "%" : "—")}
        ${reportStat("Lowest Score", stats.lowScore !== null ? r1(stats.lowScore) + "%" : "—")}
      </div>

      <div class="report-section">
        <h3 style="margin-bottom:8px;">Module Exam Results</h3>
        <table class="report-table">
          <thead><tr><th>Module</th><th>Score</th><th>Status</th></tr></thead>
          <tbody>${moduleRows}</tbody>
        </table>
      </div>

      <div class="report-section">
        <h3 style="margin-bottom:8px;">School Exam Results</h3>
        <table class="report-table">
          <thead><tr><th>Exam</th><th>Score</th><th>Status</th></tr></thead>
          <tbody>${examRows}</tbody>
        </table>
      </div>

      <div class="report-section">
        <h3 style="margin-bottom:8px;">Attendance Summary</h3>
        <table class="report-table">
          <thead><tr><th>Present</th><th>Absent</th><th>Attendance Rate</th></tr></thead>
          <tbody><tr>
            <td>${stats.attendance.present}</td>
            <td>${stats.attendance.absent}</td>
            <td>${stats.attendance.pct !== null ? r1(stats.attendance.pct) + "%" : "—"}</td>
          </tr></tbody>
        </table>
      </div>

      <div class="report-section">
        <h3 style="margin-bottom:8px;">Trainer Recommendations</h3>
        ${rec.map(r => `<div class="recommendation-item">${r.icon} ${r.text}</div>`).join("")}
      </div>

      <div class="report-section">
        <h3 style="margin-bottom:8px;">Teacher Comments</h3>
        <p style="white-space:pre-wrap;">${student.comments ? student.comments : "No comments recorded."}</p>
      </div>

      <div class="report-signoff">
        <div class="report-signoff-line"><span>Trainer Signature</span></div>
        <div class="report-signoff-line"><span>Date</span></div>
      </div>
    </div>`;
}

function reportStat(label, value) {
  return `<div class="report-stat"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}

function openPrintReport(sid) {
  const db = loadData();
  const s = db.students.find(st => st.id === sid);
  if (!s) return;
  document.getElementById("report-modal-title").textContent = `Report — ${s.name}`;
  document.getElementById("report-content").innerHTML = buildStudentReportHTML(db, s);
  document.getElementById("report-modal").classList.add("open");
}

// Builds a full multi-student printable document, grouped by class with
// a divider heading per class, then opens it in the report modal ready
// for printing/saving as PDF. Optionally scoped to one class via the
// filter <select> whose id is passed in (defaults to "all classes").
function printAllReports(filterElId) {
  const db = loadData();
  const classFilter = filterElId ? (document.getElementById(filterElId)?.value || "") : "";
  const students = studentsInClass(db, classFilter);

  if (!students.length) {
    showToast("No students to print for this selection.", "warning");
    return;
  }

  // Group by class (Unassigned last), each group sorted alphabetically.
  const classesPresent = CLASSES.filter(c => students.some(s => s.class === c));
  const groups = classesPresent.map(c => ({ label: c, list: students.filter(s => s.class === c) }));
  const unassignedList = students.filter(s => !s.class);
  if (unassignedList.length) groups.push({ label: "Unassigned", list: unassignedList });
  groups.forEach(g => g.list.sort((a, b) => a.name.localeCompare(b.name)));

  let html = "";
  groups.forEach(g => {
    html += `<div class="report-class-divider"><h2>Class: ${g.label}</h2><p>${g.list.length} student(s)</p></div>`;
    g.list.forEach(s => { html += buildStudentReportHTML(db, s); });
  });

  document.getElementById("report-modal-title").textContent =
    `Bulk Report — ${classFilter || "All Classes"} (${students.length} students)`;
  document.getElementById("report-content").innerHTML = html;
  document.getElementById("report-modal").classList.add("open");
}

function chartOptions(yLabel, maxY) {
  return { responsive: true, scales: { y: { min: 0, max: maxY } } };
}

// No init() / DOMContentLoaded entrypoint is needed anymore — the
// app is now driven entirely by auth.onAuthStateChanged() above,
// which fires once automatically as soon as firebase-config.js has
// finished loading and Firebase reports the current sign-in state.
