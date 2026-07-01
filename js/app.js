/**
 * ============================================================
 *  MAIN APPLICATION — app.js
 *  Face Attendance System — Production Build
 * ============================================================
 */
'use strict';

/* ── State ───────────────────────────────────────────────────── */
let engine        = null;   // FaceEngine instance
let attStream     = null;   // MediaStream for attendance camera
let regStream     = null;   // MediaStream for registration camera
let activeSession = null;   // Currently open attendance session
let allActiveSessions = []; // Currently active attendance sessions
let allStudents   = [];     // Cached student list (from Firestore)
let allCourses    = [];     // Cached course list
let attRunning    = false;  // Is attendance auto-scan running?
let regRunning    = false;  // Is registration camera running?
let regFacing     = 'user'; // Facing mode for register camera
let attFacing     = 'user'; // Facing mode for attend camera
let regSamples    = [];     // Collected registration descriptors
let scanCooldown  = false;  // Prevent duplicate scans
let autoScanTimer = null;   // setInterval handle
let attendanceChart = null; // Chart.js instance
let unsubscribers = [];     // Firestore listener cleanup functions
let currentAdminTab = 'pending';
let attendanceUnsubscriber = null;

/* ── Initialization ──────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', init);

async function init() {
  // Check auth first
  Auth.onAuthStateChanged(async (firebaseUser, userDoc) => {
    if (!firebaseUser || !userDoc) {
      window.location.href = 'login.html';
      return;
    }
    if (!userDoc.approved) {
      await Auth.signOut();
      window.location.href = 'login.html';
      return;
    }

    // Populate user info
    populateUserInfo(firebaseUser, userDoc);

    // Show admin nav if superadmin, hide tabs if student
    if (userDoc.role === 'student') {
      ['attendance', 'students', 'courses', 'reports'].forEach(tab => {
        document.querySelector(`.nav-item[data-tab="${tab}"]`)?.setAttribute('hidden', '');
      });
      
      const regTab = document.querySelector('.nav-item[data-tab="register"] .nav-label');
      if (regTab) regTab.textContent = 'Face Registration';
      
      const emailField = document.getElementById('r-email');
      if (emailField) {
        emailField.value = firebaseUser.email;
      }
    } else if (userDoc.role === 'superadmin') {
      document.getElementById('nav-admin').removeAttribute('hidden');
      listenPendingCount();
    }

    // Load face models
    await loadModels();

    // Show app
    document.getElementById('loading-overlay').setAttribute('hidden', '');
    document.getElementById('app-container').removeAttribute('hidden');

    // Setup
    setupNavigation();
    setupEventListeners();
    UI.startClock('topbar-clock');
    
    if (userDoc.role === 'student') {
      loadStudentDashboard();
    } else {
      loadDashboard();
      loadStudentsRealtime();
      loadCoursesRealtime();
    }
  });
}

/* ── Model Loading ───────────────────────────────────────────── */
async function loadModels() {
  engine = new FaceEngine();
  const statusEl   = document.getElementById('loading-status');
  const progressEl = document.getElementById('load-progress-bar');

  await engine.load((pct, text) => {
    if (statusEl)   statusEl.textContent    = text;
    if (progressEl) progressEl.style.width  = pct + '%';
  });
}

/* ── User Info ───────────────────────────────────────────────── */
function populateUserInfo(firebaseUser, userDoc) {
  const avatarUrl = firebaseUser.photoURL || UI.getAvatarDataUrl(userDoc.displayName);

  document.getElementById('sidebar-user-name').textContent = userDoc.displayName;
  document.getElementById('sidebar-user-role').textContent = userDoc.role;
  document.getElementById('sidebar-institution').textContent = APP_CONFIG.institutionName;
  document.getElementById('topbar-institution').textContent  = APP_CONFIG.institutionName;

  ['sidebar-avatar', 'topbar-avatar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.src = avatarUrl;
  });
}

/* ── Sign Out ────────────────────────────────────────────────── */
async function handleSignOut() {
  stopAttCamera(); stopRegCamera();
  unsubscribers.forEach(u => u());
  UI.stopClock();
  await Auth.signOut();
}
window.handleSignOut = handleSignOut;

/* ══════════════════════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════════════════════ */
function setupNavigation() {
  document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', () => switchTab(item.dataset.tab));
  });

  // Hamburger (mobile)
  document.getElementById('hamburger').addEventListener('click', () => {
    window.toggleSidebar();
  });

  window.toggleSidebar = () => {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!sidebar || !backdrop) return;
    
    sidebar.classList.toggle('open');
    if (sidebar.classList.contains('open')) {
      backdrop.classList.add('show');
    } else {
      backdrop.classList.remove('show');
    }
  };

  // User dropdown
  document.getElementById('btn-user-menu').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('user-dropdown').classList.toggle('open');
  });
  document.addEventListener('click', () => document.getElementById('user-dropdown').classList.remove('open'));

  // Theme toggle
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
}

function switchTab(tab) {
  // Close sidebar on mobile
  if (window.innerWidth <= 768) {
    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.classList.contains('open')) window.toggleSidebar();
  }

  // Stop cameras when leaving their tabs
  if (tab !== 'attendance') stopAttCamera();
  if (tab !== 'register')   stopRegCamera();

  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(el => el.classList.remove('active'));

  document.querySelector(`.nav-item[data-tab="${tab}"]`)?.classList.add('active');
  document.getElementById(`tab-${tab}`)?.classList.add('active');

  // Load tab-specific data
  if (tab === 'reports')  loadReportCourses();
  if (tab === 'admin')    loadAdminTab();
}

/* ── Theme ────────────────────────────────────────────────────── */
function toggleTheme() {
  const html  = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', isDark ? 'light' : 'dark');
  document.getElementById('btn-theme').textContent = isDark ? '☀️' : '🌙';
  localStorage.setItem('theme', isDark ? 'light' : 'dark');
}
// Apply saved theme
const savedTheme = localStorage.getItem('theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

/* ══════════════════════════════════════════════════════════════
   EVENT LISTENERS
══════════════════════════════════════════════════════════════ */
function setupEventListeners() {
  // Session modal
  document.getElementById('btn-open-session').addEventListener('click', openAttendanceSession);
  document.getElementById('btn-close-session').addEventListener('click', closeSession);

  // Modal date defaults
  document.getElementById('modal-date').value       = UI.todayDateString();
  document.getElementById('modal-start-time').value = UI.nowTimeString();
}

/* ══════════════════════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════════════════════ */
async function loadStudentDashboard() {
  const email = Auth.user.email;
  const { data: std } = await supabase.from('students').select('*').eq('email', email).maybeSingle();
  
  // Set up "Update Profile" tab if student exists
  if (std) {
    document.querySelector('.nav-item[data-tab="register"]').innerHTML = '<span>🔄</span> Update Profile & Face';
    document.querySelector('#tab-register .section-title').textContent = 'Update Profile & Face';
    
    document.getElementById('r-name').value = std.name;
    document.getElementById('r-name').disabled = true;
    document.getElementById('r-roll').value = std.roll;
    document.getElementById('r-roll').disabled = true;
    document.getElementById('r-dept').value = std.dept || '';
    document.getElementById('r-dept').disabled = true;
    document.getElementById('r-session').value = std.sess || '';
    document.getElementById('r-session').disabled = true;
    
    document.getElementById('r-sem').value = std.sem || '';
    document.getElementById('r-class').value = std.cls || '';
    document.getElementById('r-email').value = std.email;
    document.getElementById('btn-reg-cam').textContent = '📷 Update Face & Profile';
    document.getElementById('tab-register').dataset.studentId = std.id;
  }
  
  if (!std) {
     // Hide all tabs except register for new students
     document.querySelectorAll('.nav-item').forEach(el => {
       if (el.dataset.tab !== 'register') el.style.display = 'none';
     });
     document.getElementById('tab-dashboard').innerHTML = `
       <div class="card" style="text-align:center;padding:40px">
         <div style="font-size:40px;margin-bottom:10px">📸</div>
         <h2>Face Registration Required</h2>
         <p style="color:var(--c-text2)">Welcome! To start marking attendance, you must complete your profile and register your face.</p>
         <button class="btn btn-primary mt-16" onclick="switchTab('register')">Complete Profile Now</button>
       </div>
     `;
     return;
  }

  // Get their attendance records
  const records = await AttendanceDB.getByStudent(std.id);
  const presentCount = records.length;
  
  // Group by course for analytics
  const courseCounts = {};
  records.forEach(r => {
    courseCounts[r.course_name] = (courseCounts[r.course_name] || 0) + 1;
  });

  const courseBreakdownHtml = Object.keys(courseCounts).length ? 
    Object.entries(courseCounts).map(([name, count]) => 
      `<div class="activity-item" style="justify-content:space-between">
         <div class="activity-text"><strong>${name}</strong></div>
         <div class="badge badge-success">${count} classes</div>
       </div>`
    ).join('') : '<div style="color:var(--c-text2);font-size:13px;padding:10px;">No course data yet</div>';

  const riskStatus = presentCount < 5 ? '<span class="badge badge-warning">Needs More Classes</span>' : '<span class="badge badge-success">Good Standing</span>';

  document.getElementById('tab-dashboard').innerHTML = `
    <div class="section-header">
      <div>
        <div class="section-title">My Dashboard</div>
        <div class="section-sub">Welcome, ${std.name} ${std.approved ? '' : '<span style="color:var(--c-warning);font-size:12px;margin-left:8px">⚠️ Pending Teacher Approval</span>'}</div>
      </div>
      <button class="btn btn-secondary" onclick="document.querySelector('.nav-item[data-tab=\\'register\\']').click()">🔄 Update Profile & Face</button>
    </div>
    
    <div class="grid-layout-1-2" style="margin-bottom:16px">
      <!-- Profile Details -->
      <div class="card">
        <div class="card-title">👤 My Profile</div>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
          <img src="${std.photo_url || UI.getAvatarDataUrl(std.name)}" style="width:60px;height:60px;border-radius:50%;object-fit:cover;border:2px solid var(--c-border)">
          <div>
            <div style="font-weight:700;font-size:16px">${std.name}</div>
            <div style="color:var(--c-text2);font-size:13px">${std.roll}</div>
          </div>
        </div>
        <div class="grid-layout-half" style="gap:10px;font-size:13px">
          <div><div class="text-muted">Email</div><div>${std.email || 'N/A'}</div></div>
          <div><div class="text-muted">Dept</div><div>${std.dept || 'N/A'}</div></div>
          <div><div class="text-muted">Semester</div><div>${std.sem || 'N/A'}</div></div>
          <div><div class="text-muted">Section</div><div>${std.cls || 'N/A'}</div></div>
          <div><div class="text-muted">Session</div><div>${std.sess || 'N/A'}</div></div>
          <div><div class="text-muted">Status</div><div>${riskStatus}</div></div>
        </div>
      </div>

      <!-- Quick Stats -->
      <div class="stats-row grid-layout-half" style="margin-bottom:0">
        <div class="stat-card" style="--stat-color:var(--c-success)">
          <div class="stat-num">${presentCount}</div>
          <div class="stat-label">Total Classes Attended</div>
          <span class="stat-icon">✅</span>
        </div>
        <div class="stat-card" style="--stat-color:var(--c-primary)">
          <div class="stat-num">${Object.keys(courseCounts).length}</div>
          <div class="stat-label">Courses Participated</div>
          <span class="stat-icon">📚</span>
        </div>
      </div>
    </div>
    
    <div class="grid-layout-half" style="margin-top:16px">
      <div class="card">
        <div class="card-title">📚 Course Breakdown</div>
        <div style="margin-top:12px">${courseBreakdownHtml}</div>
      </div>
      <div class="card">
        <div class="card-title">🕐 My Recent Attendance</div>
        <div style="margin-top:12px;max-height:300px;overflow-y:auto">
          ${records.map(r => `<div class="activity-item"><div class="activity-text"><strong>${r.course_name}</strong></div><div class="activity-time">${UI.formatDate(r.date)} at ${r.time}</div></div>`).join('')}
          ${records.length === 0 ? '<div style="color:var(--c-text2);font-size:13px;padding:20px;text-align:center">No attendance marked yet</div>' : ''}
        </div>
      </div>
    </div>
  `;
}

function loadDashboard() {
  if (Auth.userDoc && Auth.userDoc.role !== 'student' && !Auth.userDoc.department && Auth.userDoc.approved) {
    setTimeout(() => {
      if (document.getElementById('dept-modal')) return;
      const modalHtml = `
        <div id="dept-modal" class="modal show" style="display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);z-index:9999;position:fixed;inset:0">
          <div class="card" style="max-width:400px;width:100%;text-align:center;padding:24px">
            <h3>Welcome! Complete Your Profile</h3>
            <p style="color:var(--c-text2);margin-bottom:16px">Please select your department to continue.</p>
            <select id="teacher-dept-select" class="form-control" style="margin-bottom:16px">
              <option value="">— Select Department —</option>
              <optgroup label="Computer Related">
                <option value="Computer Science">Computer Science</option>
                <option value="Software Engineering">Software Engineering</option>
                <option value="Information Technology">Information Technology</option>
                <option value="Artificial Intelligence">Artificial Intelligence</option>
                <option value="Data Science">Data Science</option>
                <option value="Cyber Security">Cyber Security</option>
              </optgroup>
              <optgroup label="Medical & Health">
                <option value="Medicine (MBBS)">Medicine (MBBS)</option>
                <option value="Dentistry (BDS)">Dentistry (BDS)</option>
                <option value="Pharmacy (Pharm.D)">Pharmacy (Pharm.D)</option>
                <option value="Nursing">Nursing</option>
                <option value="Physical Therapy">Physical Therapy</option>
              </optgroup>
              <optgroup label="Social Sciences">
                <option value="Psychology">Psychology</option>
                <option value="Sociology">Sociology</option>
                <option value="Political Science">Political Science</option>
                <option value="Economics">Economics</option>
                <option value="Mass Communication">Mass Communication</option>
                <option value="International Relations">International Relations</option>
              </optgroup>
              <optgroup label="Others">
                <option value="Mathematics">Mathematics</option>
                <option value="Physics">Physics</option>
                <option value="Chemistry">Chemistry</option>
                <option value="Business Administration">Business Administration</option>
                <option value="Electrical Engineering">Electrical Engineering</option>
              </optgroup>
            </select>
            <button class="btn btn-primary w-full" id="btn-save-dept">Save Department</button>
          </div>
        </div>
      `;
      document.body.insertAdjacentHTML('beforeend', modalHtml);
      
      document.getElementById('btn-save-dept').addEventListener('click', () => {
        const dept = document.getElementById('teacher-dept-select').value;
        if (!dept) {
          UI.toast('Please select a department', 'warning');
          return;
        }
        document.getElementById('btn-save-dept').disabled = true;
        document.getElementById('btn-save-dept').textContent = 'Saving...';
        
        supabase.from('users').update({ department: dept }).eq('uid', Auth.user.id).then(({error}) => {
          if (!error) {
            Auth.userDoc.department = dept;
            UI.toast('Profile updated!', 'success');
            document.getElementById('dept-modal').remove();
          } else {
            UI.toast('Failed to update: ' + error.message, 'error');
            document.getElementById('btn-save-dept').disabled = false;
            document.getElementById('btn-save-dept').textContent = 'Save Department';
          }
        });
      });
    }, 1000);
  }

  // Total students
  const u1 = StudentsDB.listenAll(students => {
    allStudents = students;
    UI.setText('stat-total-students', students.length);
    UI.setText('students-stat-total', students.length);
    const absent = Math.max(0, students.length - (+document.getElementById('stat-present-today').textContent || 0));
    UI.setText('students-stat-absent', absent);
    // Also re-render the student grid so dashboard and students tab stay in sync
    renderStudentGrid(students);
  });
  unsubscribers.push(u1);

  // Active sessions
  const u2 = SessionsDB.listenOpen(sessions => {
    allActiveSessions = sessions;
    UI.setText('stat-active-sessions', sessions.length);
    renderActiveSessions(sessions);
  });
  unsubscribers.push(u2);

  // Today's attendance
  const today = UI.todayDateString();
  const u3 = AttendanceDB.listenToday(today, cnt => {
    UI.setText('stat-present-today', cnt);
    UI.setText('students-stat-present', cnt);
    const total  = allStudents.length;
    const absent = Math.max(0, total - cnt);
    UI.setText('students-stat-absent', absent);
  });
  unsubscribers.push(u3);

  // Courses count
  const u4 = CoursesDB.listenAll(courses => {
    allCourses = courses;
    UI.setText('stat-courses', courses.length);
  });
  unsubscribers.push(u4);

  // Recent activity
  loadRecentActivity();
}

function renderActiveSessions(sessions) {
  const elDash = document.getElementById('active-sessions-list');
  const elAtt = document.getElementById('attendance-active-sessions-list');
  
  if (!sessions.length) {
    const emptyHtml = UI.emptyState('📷', 'No active sessions', 'Click "New Session" to start');
    if(elDash) elDash.innerHTML = emptyHtml;
    if(elAtt) elAtt.innerHTML = emptyHtml;
    return;
  }
  
  const renderList = (showDropBtn) => sessions.map(s => `
    <div class="activity-item" style="display:flex; justify-content:space-between; align-items:center; flex-wrap: wrap; gap: 12px;">
      <div style="display:flex; align-items:center; gap:12px; flex: 1; min-width: 200px;">
        <div class="session-live-dot"></div>
        <div class="activity-text">
          <strong>${UI.escapeHTML(s.courseName)}</strong><br>
          <span class="text-muted text-sm">${UI.escapeHTML(s.teacherName)} • ${UI.escapeHTML(s.room || 'No room')}</span>
        </div>
      </div>
      <div style="display:flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
        <div class="badge badge-success">${s.totalPresent || 0} present</div>
        ${showDropBtn ? `
          <button class="btn btn-primary btn-sm" onclick="resumeSession('${s.id}')" title="Resume taking attendance for this session">▶ Resume</button>
          <button class="btn btn-danger btn-sm" onclick="dropSession('${s.id}')" title="Instantly close this session and free the room">⏹ Drop</button>
        ` : ''}
      </div>
    </div>`).join('');

  if(elDash) elDash.innerHTML = renderList(false);
  if(elAtt) elAtt.innerHTML = renderList(true);
}

window.resumeSession = (sessionId) => {
  const session = allActiveSessions.find(s => s.id === sessionId);
  if (!session) {
    UI.toast('Session not found', 'error');
    return;
  }
  
  // Set the global active session and transition UI
  activeSession = session;
  
  // Switch to the attendance tab explicitly just in case they clicked it from elsewhere (though right now it's only in the attendance tab)
  switchTab('attendance');
  
  showAttendanceSession();
  startAttCamera();
  UI.toast(`Resumed session: ${session.courseName}`, 'success');
};

window.dropSession = async (sessionId) => {
  if (!confirm('Are you sure you want to completely drop and close this session? This will immediately free up the room.')) return;
  
  try {
    const { error } = await supabase
      .from('sessions')
      .update({ status: 'closed', end_time: new Date().toISOString() })
      .eq('id', sessionId);
      
    if (error) throw error;
    
    UI.toast('Session successfully dropped. Room availability synchronized.', 'success');
    
    // If the dropped session was currently actively selected in the attendance view, clear it
    if (activeSession && activeSession.id === sessionId) {
      activeSession = null;
      document.getElementById('att-session-info').hidden = true;
      document.getElementById('att-no-session').hidden = false;
      stopAttCamera();
    }
  } catch (err) {
    console.error('Error dropping session:', err);
    UI.toast('Failed to drop session.', 'error');
  }
};

async function loadRecentActivity() {
  const logs = await AuditLogDB.getRecent(8);
  const el   = document.getElementById('recent-activity');
  if (!logs.length) { el.innerHTML = UI.emptyState('📋', 'No activity yet'); return; }
  el.innerHTML = logs.map(l => `
    <div class="activity-item">
      <div class="activity-text">
        <strong>${UI.escapeHTML(l.action.replace(/_/g,' '))}</strong>
        <span class="text-muted"> by ${UI.escapeHTML(l.userName)}</span>
      </div>
      <div class="activity-time">${UI.timeAgo(l.timestamp)}</div>
    </div>`).join('');
}

/* ══════════════════════════════════════════════════════════════
   REAL-TIME DATA LOADERS
══════════════════════════════════════════════════════════════ */
function loadStudentsRealtime() {
  // Students listener is already established in loadDashboard() to avoid duplicates.
}

function loadCoursesRealtime() {
  const u = CoursesDB.listenAll(courses => {
    allCourses = courses;
    renderCourseGrid(courses);
  });
  unsubscribers.push(u);
}

/* ══════════════════════════════════════════════════════════════
   SESSION MANAGEMENT
══════════════════════════════════════════════════════════════ */
function openSessionModal() {
  // Populate course dropdown
  const sel = document.getElementById('modal-course-select');
  sel.innerHTML = '<option value="">— Select Course —</option>' +
    allCourses.map(c => `<option value="${c.id}" data-obj='${JSON.stringify({id:c.id,code:c.code,name:c.name})}'>${UI.escapeHTML(c.code)} — ${UI.escapeHTML(c.name)}</option>`).join('');
  document.getElementById('modal-date').value       = UI.todayDateString();
  document.getElementById('modal-start-time').value = UI.nowTimeString();
  UI.showModal('session-modal');
}
window.openSessionModal = openSessionModal;

async function openAttendanceSession() {
  const courseId   = document.getElementById('modal-course-select').value;
  const courseSel  = document.getElementById('modal-course-select');
  const courseOpt  = courseSel.selectedOptions[0];
  const date       = document.getElementById('modal-date').value;
  const startTime  = document.getElementById('modal-start-time').value;
  const endTime    = document.getElementById('modal-end-time').value;
  const room       = document.getElementById('modal-room').value;

  if (!courseId) { UI.toast('Please select a course', 'warning'); return; }
  if (!date)     { UI.toast('Please select a date', 'warning'); return; }
  if (!startTime){ UI.toast('Please select start time', 'warning'); return; }
  
  if (endTime && endTime <= startTime) { 
    UI.toast('End time must be after start time', 'error'); 
    return; 
  }

  if (room && allActiveSessions.some(s => s.room === room)) {
    UI.toast(`Room ${room} is currently busy with another session`, 'error');
    return;
  }

  const course = allCourses.find(c => c.id === courseId);
  if (!course)  { UI.toast('Course not found', 'error'); return; }

  try {
    document.getElementById('btn-open-session').disabled = true;
    activeSession = await SessionsDB.open({
      courseId, courseName: course.name, courseCode: course.code || '',
      date, startTime, endTime, room,
      dept: course.dept || '', sem: course.sem || '', cls: course.cls || ''
    });

    UI.hideModal('session-modal');
    UI.toast(`Session opened: ${course.name}`, 'success');
    showAttendanceSession();
    startAttCamera();
  } catch (err) {
    console.error('[Session] Open error:', err);
    UI.toast('Failed to open session: ' + err.message, 'error');
  } finally {
    document.getElementById('btn-open-session').disabled = false;
  }
}

function showAttendanceSession() {
  if (!activeSession) return;
  UI.hide('att-no-session');
  UI.show('att-session-info');
  UI.show('att-camera-area');
  document.getElementById('session-course-name').textContent = activeSession.courseName;
  document.getElementById('session-date-time').textContent   =
    `${UI.formatDate(activeSession.date)} • ${UI.formatTime(activeSession.startTime)} — ${activeSession.room || 'No room'}`;
  document.getElementById('att-session-subtitle').textContent = activeSession.courseName;

  // Real-time present counter
  if (attendanceUnsubscriber) attendanceUnsubscriber();
  attendanceUnsubscriber = AttendanceDB.listenBySession(activeSession.id, records => {
    document.getElementById('session-present-count').textContent = records.length;
    renderPresentList(records);
  });
}

async function closeSession() {
  const ok = await UI.confirm('Close Session', 'Are you sure you want to close this attendance session? No more entries will be accepted.', 'Close Session', true);
  if (!ok) return;
  try {
    await SessionsDB.close(activeSession.id);
    activeSession = null;
    if (attendanceUnsubscriber) { attendanceUnsubscriber(); attendanceUnsubscriber = null; }
    stopAttCamera();
    UI.show('att-no-session');
    UI.hide('att-session-info');
    UI.hide('att-camera-area');
    document.getElementById('att-session-subtitle').textContent = 'No active session';
    UI.toast('Session closed successfully', 'success');
  } catch (err) {
    UI.toast('Failed to close session: ' + err.message, 'error');
  }
}
window.closeSession = closeSession;

function renderPresentList(records) {
  const el = document.getElementById('att-present-list');
  if (!records.length) {
    el.innerHTML = '<div style="color:var(--c-text2);font-size:13px;text-align:center;padding:20px">Waiting for first scan…</div>';
    return;
  }
  // Show latest at top
  el.innerHTML = [...records].reverse().slice(0, 20).map(r => {
    const student = allStudents.find(s => s.id === r.studentId);
    const avatar  = student?.photoURL || UI.getAvatarDataUrl(r.studentName);
    const conf    = r.confidence || 0;
    return `<div class="present-item">
      <img class="present-avatar" src="${avatar}" alt="">
      <div><div class="present-name">${UI.escapeHTML(r.studentName)} ${student?.approved === false ? '<span title="Face not yet approved by teacher" style="cursor:help">⚠️</span>' : ''}</div><div class="present-meta">${UI.escapeHTML(r.roll)} • ${r.time}</div></div>
      <div class="present-conf" style="color:${UI.confidenceColor(conf)}">${conf}%</div>
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   ATTENDANCE CAMERA & AUTO-SCAN
══════════════════════════════════════════════════════════════ */
async function startAttCamera() {
  if (attRunning || !activeSession) return;
  try {
    const video  = document.getElementById('att-video');
    const canvas = document.getElementById('att-canvas');

    attStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: attFacing, width: { ideal: 640 }, height: { ideal: 480 } }
    });
    video.srcObject = attStream;
    await video.play();

    attRunning = true;
    document.getElementById('att-vid-pill').textContent = '● Scanning…';

    // Start the dual-loop engine (60fps display + 120ms inference)
    engine.startLoop(video, canvas, onAttFrame);

    // Auto-scan every APP_CONFIG.autoScanInterval ms
    autoScanTimer = setInterval(doAutoScan, APP_CONFIG.autoScanInterval);

  } catch (err) {
    UI.toast('Camera error: ' + err.message, 'error');
  }
}

function onAttFrame(detection) {
  // Update quality indicator
  const video  = document.getElementById('att-video');
  const quality = engine.analyzeQuality(video);
  document.getElementById('att-quality-text').textContent = quality.feedback;
  document.getElementById('att-quality-fill').style.width      = quality.score + '%';
  document.getElementById('att-quality-fill').style.background =
    quality.score >= 75 ? 'var(--c-success)' : quality.score >= 40 ? 'var(--c-warning)' : 'var(--c-danger)';

  // Update overlay with detection color
  if (detection && !scanCooldown) {
    engine._overlayOptions = { color: '#4f8ef7', showLandmarks: false };
  }
}

async function doAutoScan() {
  if (scanCooldown || !attRunning || !activeSession || !allStudents.length) return;

  const lastDet = engine.lastDetection;
  if (!lastDet) return; // No face in frame

  const video = document.getElementById('att-video');
  const pos   = engine.checkPosition(lastDet, video);
  if (!pos.ok) {
    document.getElementById('att-vid-pill').textContent = pos.guidance;
    return;
  }

  // Prevent concurrent scans
  scanCooldown = true;

  // Get stable descriptor (3 frames, 50ms apart = ~150ms total)
  const desc = await engine.getStableDescriptor(video, 3);
  if (!desc) {
    scanCooldown = false;
    return;
  }

  // Match against all registered students who have valid descriptors
  const validStudents = allStudents.filter(s =>
    Array.isArray(s.descriptor) && s.descriptor.length === 128
  );
  if (!validStudents.length) {
    scanCooldown = false;
    return;
  }
  const result = engine.findBestMatch(desc, validStudents, APP_CONFIG.defaultFaceThreshold);

  if (result.isMatch) {
    // Mark attendance (scanCooldown remains true until cooldown timeout)

    // Update visual overlay to green
    const canvas = document.getElementById('att-canvas');
    const ctx    = canvas.getContext('2d');
    const box    = engine.lastDetection?.detection.box;
    if (box) {
      engine.drawOverlay(ctx, canvas, box, {
        color: '#10b981', confidence: result.confidence,
        label: result.match.name, showLandmarks: false
      });
    }

    document.getElementById('att-vid-pill').className = 'vid-status-pill success';
    document.getElementById('att-vid-pill').textContent = `✓ ${result.match.name}`;

    try {
      const markResult = await AttendanceDB.mark(activeSession, result.match, result.confidence, 'face');
      if (markResult.alreadyMarked) {
        UI.toast(`${result.match.name} already marked`, 'info', 2000);
      } else {
        UI.toast(`✅ ${result.match.name} — ${result.confidence}% match`, 'success', 3000);
        // Send email (non-blocking)
        sendAttendanceEmail(result.match.email, result.match.name, activeSession.courseName, activeSession.date, new Date().toLocaleTimeString());
      }
    } catch (err) {
      console.error('[Attendance] Mark error:', err);
    }

    // Cooldown
    setTimeout(() => {
      scanCooldown = false;
      document.getElementById('att-vid-pill').className = 'vid-status-pill scanning';
      document.getElementById('att-vid-pill').textContent = '● Scanning…';
    }, APP_CONFIG.markCooldownMs);

  } else {
    // Unknown face
    const box = engine.lastDetection?.detection.box;
    if (box) {
      const canvas = document.getElementById('att-canvas');
      const ctx    = canvas.getContext('2d');
      engine.drawOverlay(ctx, canvas, box, { color: '#ef4444', confidence: result.confidence, label: `Unknown (${result.confidence}%)` });
    }
    document.getElementById('att-vid-pill').className = 'vid-status-pill error';
    document.getElementById('att-vid-pill').textContent = `✗ Unknown (${result.confidence}%)`;
    setTimeout(() => {
      scanCooldown = false;
      document.getElementById('att-vid-pill').className = 'vid-status-pill scanning';
      document.getElementById('att-vid-pill').textContent = '● Scanning…';
    }, 1500);
  }
}

async function manualScan() {
  if (!attRunning) { UI.toast('Please start the camera first', 'warning'); return; }
  await doAutoScan();
}
window.manualScan = manualScan;

function stopAttCamera() {
  if (autoScanTimer) { clearInterval(autoScanTimer); autoScanTimer = null; }
  engine?.stopLoop();
  if (attStream) { attStream.getTracks().forEach(t => t.stop()); attStream = null; }
  attRunning = false;
}

async function flipAttCamera() {
  attFacing = attFacing === 'user' ? 'environment' : 'user';
  stopAttCamera();
  if (activeSession) await startAttCamera();
}
window.flipAttCamera = flipAttCamera;

/* ══════════════════════════════════════════════════════════════
   REGISTRATION CAMERA & FACE CAPTURE
══════════════════════════════════════════════════════════════ */
async function startRegCamera() {
  // Validate form
  const name = document.getElementById('r-name').value.trim();
  const roll = document.getElementById('r-roll').value.trim();
  const dept = document.getElementById('r-dept').value;
  const sem  = document.getElementById('r-sem').value;
  if (!name || !roll || !dept || !sem) {
    UI.toast('Please fill in Name, Roll, Department and Semester first', 'warning');
    return;
  }

  // Check duplicate roll (ignoring current student if updating)
  const updateStudentId = document.getElementById('tab-register').dataset.studentId;
  const exists = await StudentsDB.rollExists(roll, updateStudentId);
  if (exists) { UI.toast(`Roll number "${roll}" already registered to another student`, 'error'); return; }

  try {
    const video  = document.getElementById('reg-video');
    const canvas = document.getElementById('reg-canvas');

    regStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: regFacing, width: { ideal: 640 }, height: { ideal: 480 } }
    });
    video.srcObject = regStream;
    await video.play();

    regRunning = true;
    regSamples = [];
    document.getElementById('reg-vid-pill').removeAttribute('hidden');
    document.getElementById('sample-dots').removeAttribute('hidden');
    document.getElementById('reg-controls').removeAttribute('hidden');
    document.getElementById('btn-reg-cam').setAttribute('hidden', '');

    // Reset dots
    [0, 1, 2].forEach(i => {
      const d = document.getElementById(`dot-${i}`);
      d.className = 'sample-dot';
    });

    setRegStatus('info', '🔍 Position your face in the frame…');

    // Start display loop (detection only, no descriptor)
    engine.startLoop(video, canvas, onRegFrame);

    // Wait until a face is detected, then auto-capture
    waitForFaceAndCapture(video, canvas);

  } catch (err) {
    UI.toast('Camera error: ' + err.message, 'error');
  }
}
window.startRegCamera = startRegCamera;

function onRegFrame(detection) {
  if (detection) {
    const video = document.getElementById('reg-video');
    const pos   = engine.checkPosition(detection, video);
    document.getElementById('reg-vid-pill').textContent = pos.ok ? '✅ Hold still…' : pos.guidance;
    document.getElementById('reg-vid-pill').className   = `vid-status-pill ${pos.ok ? 'success' : 'scanning'}`;
  } else {
    document.getElementById('reg-vid-pill').textContent = '🔍 Looking for face…';
    document.getElementById('reg-vid-pill').className   = 'vid-status-pill scanning';
  }
}

async function waitForFaceAndCapture(video, canvas) {
  if (!regRunning) return;

  // Wait until face is detected and well-positioned
  let attempts = 0;
  while (regRunning) {
    const det = engine.lastDetection;
    if (det) {
      const pos = engine.checkPosition(det, video);
      if (pos.ok) break; // Face is good — start capturing
    }
    await new Promise(r => setTimeout(r, 200));
    attempts++;
    if (attempts > 50) { // 10 seconds timeout
      setRegStatus('danger', '⚠️ No face detected. Please ensure good lighting and face the camera.');
      return;
    }
  }

  if (!regRunning) return;

  // Instant Capture
  setRegStatus('info', '📸 Capturing face samples… please hold still');
  const samples = await engine.captureRegistrationSamples(video, 3, (idx, total) => {
    // Mark dot as captured
    document.getElementById(`dot-${idx - 1}`).className = 'sample-dot captured';
    setRegStatus('info', `📸 Sample ${idx}/${total} captured`);
  });

  if (!samples || samples.length < 2) {
    setRegStatus('danger', '❌ Failed to capture face. Please try again in better lighting.');
    return;
  }

  // Take photo
  const photoBlob = await capturePhotoBlob(video);

  // Stop camera
  engine.stopLoop();

  // Show captured preview
  if (photoBlob) {
    const url = URL.createObjectURL(photoBlob);
    const preview = document.getElementById('captured-preview');
    preview.src   = url;
    preview.style.display = 'block';
  }

  setRegStatus('info', '💾 Saving to database…');

  // Save student
  const averaged = engine.averageDescriptors(samples);
  const studentData = {
    name:        document.getElementById('r-name').value.trim(),
    roll:        document.getElementById('r-roll').value.trim(),
    email:       document.getElementById('r-email').value.trim(),
    dept:        document.getElementById('r-dept').value,
    sem:         document.getElementById('r-sem').value,
    cls:         document.getElementById('r-class').value.trim(),
    sess:        document.getElementById('r-session').value.trim(),
    descriptor:  Array.from(averaged),
    descriptors: samples.map(s => Array.from(s)),
    approved:    Auth.userDoc?.role === 'student' ? false : true
  };

  try {
    // Check if student exists
    let existingId = document.getElementById('tab-register').dataset.studentId || null;
    
    if (!existingId) {
      if (Auth.userDoc?.role === 'student') {
        const { data } = await supabase.from('students').select('id').eq('email', Auth.user.email).maybeSingle();
        if (data) existingId = data.id;
      } else {
        const { data } = await supabase.from('students').select('id').eq('roll', studentData.roll).maybeSingle();
        if (data) existingId = data.id;
      }
    }

    if (existingId) {
      await StudentsDB.updateFace(existingId, studentData, photoBlob);
      setRegStatus('success', `✅ Face updated for ${studentData.name}!`);
      UI.toast(`Face updated for ${studentData.name}!`, 'success');
      setTimeout(() => clearRegForm(), 3000);
    } else {
      await StudentsDB.add(studentData, photoBlob);
      setRegStatus('success', `✅ ${studentData.name} registered successfully!`);
      UI.toast(`${studentData.name} registered! Reloading dashboard...`, 'success');
      setTimeout(() => window.location.reload(), 2000);
    }
  } catch (err) {
    console.error('[Register] Error:', err);
    setRegStatus('danger', '❌ Registration failed: ' + err.message);
    UI.toast('Registration failed: ' + err.message, 'error');
  }
}

function capturePhotoBlob(video) {
  return new Promise(resolve => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width  = video.videoWidth  || 320;
      canvas.height = video.videoHeight || 240;
      canvas.getContext('2d').drawImage(video, 0, 0);
      canvas.toBlob(resolve, 'image/jpeg', 0.85);
    } catch { resolve(null); }
  });
}

function setRegStatus(type, text) {
  const el = document.getElementById('reg-status');
  el.className  = `alert alert-${type}`;
  el.textContent = text;
  el.removeAttribute('hidden');
}

function clearRegForm() {
  ['r-name','r-roll','r-email','r-class','r-session','r-dept','r-sem'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  
  delete document.getElementById('tab-register').dataset.studentId;

  // If student, restore profile values by reloading dashboard logic
  if (Auth.userDoc?.role === 'student') {
    loadStudentDashboard();
  }
  
  document.getElementById('reg-status').setAttribute('hidden', '');
  document.getElementById('sample-dots').setAttribute('hidden', '');
  document.getElementById('reg-controls').setAttribute('hidden', '');
  document.getElementById('btn-reg-cam').removeAttribute('hidden');
  document.getElementById('captured-preview').style.display = 'none';
  document.getElementById('reg-vid-pill').setAttribute('hidden', '');
  [0,1,2].forEach(i => document.getElementById(`dot-${i}`).className = 'sample-dot');
  stopRegCamera();
}

function stopRegCamera() {
  engine?.stopLoop();
  if (regStream) { regStream.getTracks().forEach(t => t.stop()); regStream = null; }
  regRunning = false;
}
window.stopRegCamera = stopRegCamera;

async function flipRegCamera() {
  regFacing = regFacing === 'user' ? 'environment' : 'user';
  stopRegCamera();
  await startRegCamera();
}
window.flipRegCamera = flipRegCamera;

/* ══════════════════════════════════════════════════════════════
   STUDENTS TAB
══════════════════════════════════════════════════════════════ */
function renderStudentGrid(students) {
  const el   = document.getElementById('students-list');
  const query = document.getElementById('student-search')?.value.toLowerCase() || '';
  const filtered = query
    ? students.filter(s =>
        s.name?.toLowerCase().includes(query) ||
        s.roll?.toLowerCase().includes(query) ||
        s.dept?.toLowerCase().includes(query) ||
        s.email?.toLowerCase().includes(query))
    : students;

  UI.setText('students-stat-total', students.length);

  if (!filtered.length) {
    el.innerHTML = UI.emptyState('👥', query ? 'No results found' : 'No students yet', 'Use the Register tab to add students');
    return;
  }

  el.innerHTML = filtered.map(s => `
  <div class="student-card">
    <img src="${s.photo_url || UI.getAvatarDataUrl(s.name)}" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid var(--c-border)">
    <div>
      <div style="font-weight:600">${UI.escapeHTML(s.name)} ${s.approved === false ? '<span title="Unapproved Face" style="cursor:help">⚠️</span>' : ''}</div>
      <div class="text-muted text-sm">${UI.escapeHTML(s.roll)}</div>
    </div>
    <div style="font-size:13px;color:var(--c-text2)">
      <div>${UI.escapeHTML(s.dept || '—')}</div>
      <div>${UI.escapeHTML(s.sem || '—')}</div>
    </div>
    <div style="display:flex;gap:4px;margin-top:8px;flex-wrap:wrap;">
      <button class="btn btn-secondary btn-sm" onclick="viewStudentHistory('${s.id}')">History</button>
      ${(s.approved === false && (Auth.userDoc.role === 'superadmin' || Auth.userDoc.role === 'teacher')) ? `<button class="btn btn-success btn-sm" onclick="approveStudentFace('${s.id}')">✔️ Approve Face</button>` : `<button class="btn btn-ghost btn-sm" onclick="deleteStudent('${s.id}','${s.name}')">🗑️</button>`}
      ${Auth.userDoc?.role === 'superadmin' ? `<button class="btn btn-danger btn-sm" onclick="hardResetStudent('${s.id}', '${s.email || ''}', '${s.photo_url || ''}')" title="Factory Reset Student">⚠️ Reset</button>` : ''}
    </div>
  </div>`).join('');
}

window.hardResetStudent = async (studentId, email, photoURL) => {
  const dlgText = 'Are you sure? This will delete their biometric face, all their attendance records, and completely wipe their Google authentication identity. They will be forced to register again as a brand new user.';
  if (!window.confirm(`⚠️ Hard Reset Student\n\n${dlgText}`)) return;
  
  try {
    UI.toast('Initiating hard reset...', 'info');
    let uid = null;
    if (email) {
      const { data } = await supabase.from('users').select('uid').eq('email', email).maybeSingle();
      if (data) uid = data.uid;
    }
    await StudentsDB.hardDelete(studentId, uid, photoURL);
    UI.toast('Student permanently erased and reset.', 'success');
  } catch (err) {
    console.error(err);
    UI.toast('Failed: ' + err.message, 'error');
  }
};

function filterStudents() {
  renderStudentGrid(allStudents);
}
window.filterStudents = filterStudents;

async function approveStudentFace(id) {
  try {
    await StudentsDB.approveFace(id);
    UI.toast('Face approved successfully!', 'success');
  } catch (err) {
    UI.toast('Error approving face: ' + err.message, 'error');
    console.error(err);
  }
}
window.approveStudentFace = approveStudentFace;

async function viewStudentHistory(studentId) {
  const student = allStudents.find(s => s.id === studentId);
  if (!student) return;

  document.getElementById('history-student-name').textContent = student.name;
  document.getElementById('history-student-roll').textContent = student.roll;
  document.getElementById('history-student-photo').src = student.photoURL || UI.getAvatarDataUrl(student.name);

  UI.showModal('student-history-modal');
  document.getElementById('history-summary').innerHTML = UI.skeletonList(2);
  document.getElementById('history-timeline').innerHTML = UI.skeletonList(3);

  const records = await AttendanceDB.getByStudent(studentId);
  const bySource = {};
  records.forEach(r => {
    if (!bySource[r.courseId]) bySource[r.courseId] = { name: r.courseName, count: 0 };
    bySource[r.courseId].count++;
  });

  document.getElementById('history-summary').innerHTML = Object.values(bySource).map(c =>
    `<div class="activity-item"><div class="activity-text"><strong>${UI.escapeHTML(c.name)}</strong></div><div class="badge badge-success">${c.count} sessions</div></div>`
  ).join('') || '<div class="text-muted text-sm">No attendance records yet</div>';

  document.getElementById('history-timeline').innerHTML = records.slice(0, 20).map(r =>
    `<div class="timeline-item"><div class="timeline-dot"></div><div class="timeline-content">
      <div class="timeline-action">${UI.escapeHTML(r.courseName)}</div>
      <div class="timeline-meta">${UI.formatDate(r.date)} at ${r.time} • ${r.confidence || 0}% confidence</div>
    </div></div>`
  ).join('') || '<div class="text-muted text-sm text-center" style="padding:20px">No records</div>';
}
window.viewStudentHistory = viewStudentHistory;

async function deleteStudent(id, name) {
  const ok = await UI.confirm('Delete Student', `Remove "${name}" from the system? Their attendance records will be preserved.`, 'Delete', true);
  if (ok) {
    await StudentsDB.deactivate(id);
    UI.toast(`${name} removed`, 'success');
  }
}
window.deleteStudent = deleteStudent;

function exportStudentsCSV() {
  const headers = ['Name', 'Roll', 'Email', 'Department', 'Semester', 'Class', 'Session'];
  const rows    = allStudents.map(s => [s.name, s.roll, s.email, s.dept, s.sem, s.cls, s.sess]);
  UI.downloadCSV(`students_${UI.todayDateString()}.csv`, headers, rows);
}
window.exportStudentsCSV = exportStudentsCSV;

async function importStudentsCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const text  = await file.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) { UI.toast('CSV must have a header row and at least one student', 'warning'); return; }
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g,''));
  let imported  = 0;
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(v => v.trim().replace(/"/g,''));
    const obj  = {};
    headers.forEach((h, idx) => { obj[h.toLowerCase()] = vals[idx] || ''; });
    if (!obj.name || !obj.roll) continue;
    try {
      await StudentsDB.add({ name: obj.name, roll: obj.roll, email: obj.email || '', dept: obj.department || obj.dept || '', sem: obj.semester || obj.sem || '', cls: obj.class || obj.cls || '', sess: obj.session || obj.sess || '', descriptor: [], descriptors: [] }, null);
      imported++;
    } catch { /* skip duplicates */ }
  }
  UI.toast(`Imported ${imported} students`, 'success');
  input.value = '';
}
window.importStudentsCSV = importStudentsCSV;

/* ══════════════════════════════════════════════════════════════
   COURSES TAB
══════════════════════════════════════════════════════════════ */
function renderCourseGrid(courses) {
  const el = document.getElementById('courses-list');
  if (!courses.length) {
    el.innerHTML = UI.emptyState('📚', 'No courses yet', 'Add your first course above');
    return;
  }
  el.innerHTML = courses.map(c => `
    <div class="course-card">
      <div class="course-code">${UI.escapeHTML(c.code || '—')}</div>
      <div class="course-name">${UI.escapeHTML(c.name)}</div>
      <div class="course-meta">${UI.escapeHTML(c.dept || '')} ${c.sem ? '• ' + UI.escapeHTML(c.sem) : ''}</div>
      <div class="course-meta text-muted" style="margin-top:4px">By: ${UI.escapeHTML(c.createdByName || 'Unknown')}</div>
      <div class="course-stats">
        <div class="course-stat"><span>${c.totalClasses || 0}</span>Classes</div>
      </div>
      <div style="display:flex;gap:6px;margin-top:10px">
        <button class="btn btn-danger btn-sm" onclick="deleteCourse('${c.id}','${c.name}')">🗑️ Delete</button>
      </div>
    </div>`).join('');
}

function toggleAddCourse() {
  const form = document.getElementById('add-course-form');
  form.hasAttribute('hidden') ? form.removeAttribute('hidden') : form.setAttribute('hidden', '');
}
window.toggleAddCourse = toggleAddCourse;

async function addCourse() {
  const code = document.getElementById('c-code').value.trim();
  const name = document.getElementById('c-name').value.trim();
  const dept = document.getElementById('c-dept').value.trim();
  const sem  = document.getElementById('c-sem').value.trim();
  if (!code || !name) { UI.toast('Course code and name are required', 'warning'); return; }
  try {
    await CoursesDB.add({ code, name, dept, sem });
    UI.toast(`Course "${name}" added`, 'success');
    ['c-code','c-name','c-dept','c-sem'].forEach(id => document.getElementById(id).value = '');
    toggleAddCourse();
  } catch (err) {
    UI.toast('Failed to add course: ' + err.message, 'error');
  }
}
window.addCourse = addCourse;

async function deleteCourse(id, name) {
  const ok = await UI.confirm('Delete Course', `Delete "${name}"?`, 'Delete', true);
  if (ok) { await CoursesDB.delete(id); UI.toast(`${name} deleted`, 'success'); }
}
window.deleteCourse = deleteCourse;

/* ══════════════════════════════════════════════════════════════
   REPORTS TAB
══════════════════════════════════════════════════════════════ */
function loadReportCourses() {
  const sel = document.getElementById('reports-course-select');
  sel.innerHTML = '<option value="">— Select Course to View Report —</option>' +
    allCourses.map(c => `<option value="${c.id}">${c.code} — ${c.name}</option>`).join('');
}

async function loadReport() {
  const courseId = document.getElementById('reports-course-select').value;
  if (!courseId)  { document.getElementById('report-content').innerHTML = '<div class="card flex-center" style="padding:60px">' + UI.emptyState('📊','Select a course above') + '</div>'; return; }

  const course   = allCourses.find(c => c.id === courseId);
  document.getElementById('report-content').innerHTML = UI.skeletonList(3);

  const [sessions, records] = await Promise.all([
    SessionsDB.getByCourse(courseId),
    AttendanceDB.getByCourse(courseId)
  ]);

  // Student attendance %
  const studentMap = {};
  records.forEach(r => {
    if (!studentMap[r.studentId]) studentMap[r.studentId] = { name: r.studentName, roll: r.roll, count: 0 };
    studentMap[r.studentId].count++;
  });
  const closedSessions = sessions.filter(s => s.status === 'closed').length;

  // Render
  const reportHtml = `
    <div class="chart-wrap" style="margin-bottom:16px">
      <div style="font-size:14px;font-weight:700;margin-bottom:12px">📊 Attendance Overview — ${course.name}</div>
      <canvas id="attendance-chart" height="80"></canvas>
    </div>
    <div class="card mb-16">
      <div class="card-title">📅 Sessions (${sessions.length} total)</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Time</th><th>Room</th><th>Present</th><th>Status</th></tr></thead>
        <tbody>${sessions.map(s => `<tr>
          <td>${UI.formatDate(s.date)}</td>
          <td>${UI.formatTime(s.startTime)}</td>
          <td>${s.room || '—'}</td>
          <td>${s.totalPresent || 0}</td>
          <td>${UI.statusBadge(s.status, s.status)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="card">
      <div class="card-title">👥 Student Attendance (${sessions.length} total sessions)</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Student</th><th>Roll</th><th>Attended</th><th>Total</th><th>%</th></tr></thead>
        <tbody>${Object.values(studentMap).map(s => {
          const totalSessions = sessions.length;
          const pct = totalSessions > 0 ? Math.round((s.count / totalSessions) * 100) : 0;
          return `<tr class="${pct < 75 && totalSessions > 0 ? 'row-danger' : ''}">
            <td>${s.name}</td><td>${s.roll}</td><td>${s.count}</td><td>${totalSessions}</td>
            <td><span style="font-weight:700;color:${UI.confidenceColor(pct)}">${pct}%</span></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>`;
  document.getElementById('report-content').innerHTML = reportHtml;

  // Render chart
  if (attendanceChart) { attendanceChart.destroy(); attendanceChart = null; }
  const ctx = document.getElementById('attendance-chart');
  if (ctx && sessions.length) {
    attendanceChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: sessions.map((s, i) => `${s.date} #${i+1}`),
        datasets: [{
          label: 'Present',
          data:  sessions.map(s => s.totalPresent || 0),
          backgroundColor: 'rgba(79,142,247,0.7)',
          borderColor:     '#4f8ef7',
          borderWidth:     1,
          borderRadius:    4
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
      }
    });
  }
}
window.loadReport = loadReport;

function exportReportCSV() {
  const courseId = document.getElementById('reports-course-select').value;
  if (!courseId) { UI.toast('Please select a course first', 'warning'); return; }
  UI.toast('Preparing export…', 'info');

  Promise.all([
    supabase.from('sessions').select('*').eq('course_id', courseId).order('date'),
    AttendanceDB.getByCourse(courseId)
  ]).then(([ { data: sessions }, records ]) => {
    if (!sessions || !sessions.length) {
      UI.toast('No sessions found for this course.', 'warning');
      return;
    }

    // 1. Setup headers (Static + Dynamic Session Dates + Totals)
    const headers = ['Student Name', 'Roll Number'];
    sessions.forEach((s, idx) => headers.push(`${s.date} (S${idx+1})`));
    headers.push('Total Present', 'Total Absent', 'Attendance %');

    // 2. Aggregate students from records
    const studentsMap = {};
    records.forEach(r => {
      if (!studentsMap[r.studentId]) {
        studentsMap[r.studentId] = { name: r.studentName, roll: r.roll, attendance: {} };
      }
      studentsMap[r.studentId].attendance[r.sessionId] = true;
    });

    // 3. Build rows
    const rows = [];
    const totalSessions = sessions.length;

    Object.values(studentsMap).sort((a,b) => a.roll.localeCompare(b.roll)).forEach(st => {
      const row = [st.name, st.roll];
      let presentCount = 0;
      
      sessions.forEach(s => {
        if (st.attendance[s.id]) {
          row.push('P');
          presentCount++;
        } else {
          row.push('A');
        }
      });
      
      const absentCount = totalSessions - presentCount;
      const percentage = Math.round((presentCount / totalSessions) * 100);
      
      row.push(presentCount.toString(), absentCount.toString(), `${percentage}%`);
      rows.push(row);
    });

    UI.downloadCSV(`Semester_Report_${UI.todayDateString()}.csv`, headers, rows);
  }).catch(err => {
    console.error(err);
    UI.toast('Failed to generate export', 'error');
  });
}
window.exportReportCSV = exportReportCSV;

function printReport() {
  const el = document.getElementById('report-content');
  if (el) UI.printSection(el.innerHTML, 'Attendance Report');
}
window.printReport = printReport;

/* ══════════════════════════════════════════════════════════════
   ADMIN TAB
══════════════════════════════════════════════════════════════ */
function switchAdminTab(tab, el) {
  currentAdminTab = tab;
  document.querySelectorAll('.inner-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  ['pending','users','settings','audit'].forEach(t => {
    const panel = document.getElementById(`admin-tab-${t}`);
    if (panel) t === tab ? panel.removeAttribute('hidden') : panel.setAttribute('hidden','');
  });
  if (tab === 'users')    loadAllUsers();
  if (tab === 'audit')    loadAuditLog();
  if (tab === 'settings') loadSettings();
}
window.switchAdminTab = switchAdminTab;

function loadAdminTab() {
  loadPendingUsers();
}

async function loadPendingUsers() {
  const el    = document.getElementById('pending-users-list');
  el.innerHTML = UI.skeletonList(2);
  
  const [users, { data: students }] = await Promise.all([
    UsersDB.getPending(),
    supabase.from('students').select('*').eq('approved', false)
  ]);
  
  let html = '';
  
  if (users.length > 0) {
    html += '<h4 style="margin:16px 0 8px">Pending Staff Accounts</h4>';
    html += users.map(u => {
      const actionHtml = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn btn-success btn-sm" onclick="approveUser('${u.uid}','${u.displayName}')">✔️ Approve</button>
        ${u.email !== '2024f-mulug-1293@mul.edu.pk' ? `<button class="btn btn-danger btn-sm"  onclick="rejectUser('${u.uid}','${u.displayName}')">❌ Reject</button>` : ''}
      </div>`;
      return `<div class="activity-item">
        <img class="activity-avatar" src="${u.photoURL || UI.getAvatarDataUrl(u.displayName)}" alt="">
        <div class="activity-text"><strong>${u.displayName}</strong><br><span class="text-muted">${u.email}</span></div>
        ${actionHtml}
      </div>`}).join('');
  }
  
  if (students && students.length > 0) {
    html += '<h4 style="margin:16px 0 8px">Pending Student Faces</h4>';
    html += students.map(s => {
      const actionHtml = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn btn-success btn-sm" onclick="approveStudentFace('${s.id}').then(() => loadPendingUsers())">✔️ Approve Face</button>
      </div>`;
      return `<div class="activity-item">
        <img class="activity-avatar" src="${s.photo_url || UI.getAvatarDataUrl(s.name)}" alt="">
        <div class="activity-text"><strong>${UI.escapeHTML(s.name)}</strong><br><span class="text-muted">${UI.escapeHTML(s.roll)} • ${UI.escapeHTML(s.email) || ''}</span></div>
        ${actionHtml}
      </div>`}).join('');
  }
  
  if (!html) {
    el.innerHTML = UI.emptyState('✅','No pending approvals');
  } else {
    el.innerHTML = html;
  }
}

async function loadAllUsers() {
  const el    = document.getElementById('all-users-list');
  el.innerHTML = '<tr><td colspan="5">' + UI.skeletonList(3) + '</td></tr>';
  const users  = await UsersDB.getAll();
  el.innerHTML = users.map(u => `<tr>
    <td><div style="display:flex;align-items:center;gap:8px"><img src="${u.photoURL || UI.getAvatarDataUrl(u.displayName)}" style="width:28px;height:28px;border-radius:50%"> ${UI.escapeHTML(u.displayName)}</div></td>
    <td>${UI.escapeHTML(u.email)}</td>
    <td>${UI.statusBadge(u.role, u.role)}</td>
    <td>${u.approved ? UI.statusBadge('Approved','success') : UI.statusBadge('Pending','warning')}</td>
    <td>${(Auth.userDoc?.role === 'superadmin' && u.email !== '2024f-mulug-1293@mul.edu.pk') ? `<select onchange="changeRole('${u.uid}',this.value)" style="font-size:12px;padding:3px 6px;border:1px solid var(--c-border);border-radius:4px;background:var(--c-surface2);color:var(--c-text)">
      ${['superadmin','teacher','student'].map(r => `<option value="${r}" ${u.role===r?'selected':''}>${r}</option>`).join('')}
    </select>` : (u.email === '2024f-mulug-1293@mul.edu.pk' ? `<span class="badge badge-info">Owner</span>` : u.role)}</td>
  </tr>`).join('');
}

async function approveUser(uid, name) {
  await UsersDB.approve(uid);
  UI.toast(`${name} approved`, 'success');
  loadPendingUsers();
}
window.approveUser = approveUser;

async function rejectUser(uid, name) {
  const ok = await UI.confirm('Reject User', `Reject and remove "${name}"?`, 'Reject', true);
  if (ok) { await UsersDB.reject(uid); UI.toast(`${name} rejected`, 'info'); loadPendingUsers(); }
}
window.rejectUser = rejectUser;

async function changeRole(uid, role) {
  await UsersDB.setRole(uid, role);
  UI.toast('Role updated', 'success');
}
window.changeRole = changeRole;

async function loadSettings() {
  const settings = await SettingsDB.get();
  if (settings.institutionName) document.getElementById('s-inst-name').value = settings.institutionName;
  if (settings.threshold)       { document.getElementById('s-threshold').value = settings.threshold; document.getElementById('threshold-val').textContent = settings.threshold; }
  if (settings.allowedEmailDomain) document.getElementById('s-email-domain').value = settings.allowedEmailDomain;
}

async function saveSettings() {
  const data = {
    institutionName:    document.getElementById('s-inst-name').value.trim(),
    threshold:          +document.getElementById('s-threshold').value,
    allowedEmailDomain: document.getElementById('s-email-domain').value.trim()
  };
  await SettingsDB.update(data);
  // Update live threshold
  APP_CONFIG.defaultFaceThreshold = data.threshold;
  UI.toast('Settings saved', 'success');
}
window.saveSettings = saveSettings;

async function loadAuditLog() {
  const el   = document.getElementById('audit-log-list');
  el.innerHTML = UI.skeletonList(5);
  const logs  = await AuditLogDB.getRecent(50);
  if (!logs.length) { el.innerHTML = UI.emptyState('📋','No audit log entries'); return; }
  el.innerHTML = `<div class="timeline">` + logs.map(l => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div class="timeline-content">
        <div class="timeline-action">${l.action.replace(/_/g,' ')}</div>
        <div class="timeline-meta">${l.userName} • ${UI.timeAgo(l.timestamp)} • ${JSON.stringify(l.details).slice(0,60)}</div>
      </div>
    </div>`).join('') + '</div>';
}

function listenPendingCount() {
  const u = UsersDB.listenPending(users => {
    const badge = document.getElementById('pending-badge');
    if (users.length > 0) {
      badge.textContent = users.length;
      badge.removeAttribute('hidden');
    } else {
      badge.setAttribute('hidden','');
    }
  });
  unsubscribers.push(u);
}

/* ══════════════════════════════════════════════════════════════
   EMAIL NOTIFICATION (EmailJS)
══════════════════════════════════════════════════════════════ */
try { emailjs.init('O9Wt_zNuwaJvI8YQF'); } catch(e) {}

function sendAttendanceEmail(email, name, course, date, time) {
  if (!email) return;
  try {
    emailjs.send('service_bmi0vol', 'template_qald9yb', { to_email: email, student_name: name, course_name: course, attendance_date: date, attendance_time: time }).catch(() => {});
  } catch(e) {}
}
