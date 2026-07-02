/**
 * ============================================================
 *  DATABASE MODULE (Supabase)
 *  db.js
 * ============================================================
 *  Handles all interaction with Supabase PostgreSQL tables.
 */
'use strict';

// ── Shared Helpers ────────────────────────────────────────────

function handlePgError(error, context) {
  if (error) {
    console.error(`[Supabase] ${context} error:`, error);
    throw new Error(error.message || 'Database error occurred');
  }
}

// Supabase generates UUIDs on insert if configured via SQL default gen_random_uuid()
// For local tracking if needed before insert:
const genId = () => crypto.randomUUID();

// Log an audit action
async function logAudit(action, details = {}) {
  const user = Auth.user;
  const doc = Auth.userDoc;
  if (!user) return;
  
  await supabase.from('audit_log').insert([{
    user_id: user.id,
    user_name: doc?.displayName || user.email,
    action: action,
    details: details
  }]);
}

// ── USERS ─────────────────────────────────────────────────────
const UsersDB = {
  async get(uid) {
    const { data, error } = await supabase.from('users').select('*').eq('uid', uid).single();
    if (error && error.code !== 'PGRST116') handlePgError(error, 'UsersDB.get');
    if (!data) return null;
    return {
      ...data,
      displayName: data.display_name,
      photoURL: data.photo_url
    };
  },

  async getAll() {
    const { data, error } = await supabase.from('users').select('*').order('created_at', { ascending: false });
    handlePgError(error, 'UsersDB.getAll');
    return data.map(u => ({
      ...u,
      displayName: u.display_name,
      photoURL: u.photo_url
    }));
  },

  async getPending() {
    const { data, error } = await supabase.from('users').select('*').eq('approved', false);
    handlePgError(error, 'UsersDB.getPending');
    return data.map(u => ({
      ...u,
      displayName: u.display_name,
      photoURL: u.photo_url
    }));
  },

  listenPending(callback) {
    // Initial fetch
    this.getPending().then(callback);

    // Setup realtime subscription
    const channel = supabase.channel(`public:users:pending:${Math.random()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'users', filter: 'approved=eq.false' }, () => {
        this.getPending().then(callback);
      })
      .subscribe();
      
    return () => supabase.removeChannel(channel);
  },

  async approve(uid) {
    const { error } = await supabase.from('users').update({ approved: true }).eq('uid', uid);
    handlePgError(error, 'UsersDB.approve');
    await logAudit('APPROVE_USER', { target_uid: uid });
  },

  async reject(uid) {
    const { error } = await supabase.rpc('delete_user_completely', { p_uid: uid });
    handlePgError(error, 'UsersDB.reject');
    await logAudit('REJECT_USER', { target_uid: uid });
  },

  async setRole(uid, role) {
    const { error } = await supabase.from('users').update({ role: role }).eq('uid', uid);
    handlePgError(error, 'UsersDB.setRole');
    await logAudit('CHANGE_ROLE', { target_uid: uid, role });
  }
};

// ── STUDENTS ──────────────────────────────────────────────────
const StudentsDB = {
  async add(data, photoBlob) {
    let photoURL = '';
    
    // Upload photo to Supabase Storage if provided
    if (photoBlob) {
      const ext = photoBlob.type.split('/')[1] || 'jpg';
      const filename = `student_${Date.now()}_${Math.random().toString(36).substr(2,5)}.${ext}`;
      
      const { data: uploadData, error: uploadErr } = await supabase.storage
        .from('avatars')
        .upload(filename, photoBlob);
        
      if (uploadErr) {
        console.error("Photo upload failed", uploadErr);
      } else if (uploadData) {
        const { data: publicUrlData } = supabase.storage.from('avatars').getPublicUrl(filename);
        photoURL = publicUrlData.publicUrl;
      }
    }

    const { error } = await supabase.from('students').insert([{
      name: data.name,
      roll: data.roll,
      email: data.email || null,
      dept: data.dept,
      sem: data.sem,
      cls: data.cls || null,
      sess: data.sess || null,
      photo_url: photoURL,
      descriptor: JSON.stringify(data.descriptor),
      descriptors: JSON.stringify(data.descriptors),
      embedding: '[' + Array.from(data.descriptor).join(',') + ']',
      created_by: Auth.user.id,
      active: true,
      approved: false
    }]);

    handlePgError(error, 'StudentsDB.add');
    await logAudit('REGISTER_STUDENT', { roll: data.roll, name: data.name });
  },

  async updateFace(id, data, photoBlob) {
    let photoURL = data.photoURL; // fallback
    if (photoBlob) {
      // Cleanup old orphaned avatar
      const { data: oldStudent } = await supabase.from('students').select('photo_url').eq('id', id).maybeSingle();
      if (oldStudent && oldStudent.photo_url) {
        const parts = oldStudent.photo_url.split('/avatars/');
        if (parts.length === 2) {
          const oldFilename = parts[1].split('?')[0];
          await supabase.storage.from('avatars').remove([oldFilename]);
        }
      }

      const ext = photoBlob.type.split('/')[1] || 'jpg';
      const filename = `student_${Date.now()}_${Math.random().toString(36).substr(2,5)}.${ext}`;
      const { data: uploadData, error: uploadErr } = await supabase.storage.from('avatars').upload(filename, photoBlob);
      if (!uploadErr && uploadData) {
        const { data: publicUrlData } = supabase.storage.from('avatars').getPublicUrl(filename);
        photoURL = publicUrlData.publicUrl;
      }
    }
    const { error } = await supabase.from('students').update({
      descriptor: JSON.stringify(data.descriptor),
      descriptors: JSON.stringify(data.descriptors),
      embedding: '[' + Array.from(data.descriptor).join(',') + ']',
      photo_url: photoURL,
      email: data.email || null,
      sem: data.sem,
      cls: data.cls || null,
      approved: false // Face updates require re-approval
    }).eq('id', id);
    handlePgError(error, 'StudentsDB.updateFace');
    await logAudit('UPDATE_FACE', { student_id: id });
  },

  async approveFace(id) {
    const { error } = await supabase.from('students').update({ approved: true }).eq('id', id);
    handlePgError(error, 'StudentsDB.approveFace');
    await logAudit('APPROVE_STUDENT', { student_id: id });
  },

  listenAll(callback) {
    const fetch = async () => {
      // EXCLUDE heavy descriptor/embedding columns from realtime fetch for massive scalability!
      const { data, error } = await supabase.from('students').select('id, roll, name, email, dept, sem, cls, sess, photo_url, active, created_by, created_at, approved').eq('active', true).order('name');
      if (!error && data) {
        const students = data.map(s => ({
          ...s,
          photoURL: s.photo_url
        }));
        callback(students);
      }
    };
    fetch();

    const channel = supabase.channel(`public:students:all:${Math.random()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, fetch)
      .subscribe();
      
    return () => supabase.removeChannel(channel);
  },

  async deactivate(id) {
    const { error } = await supabase.from('students').update({ active: false }).eq('id', id);
    handlePgError(error, 'StudentsDB.deactivate');
    await logAudit('DELETE_STUDENT', { student_id: id });
  },

  async rollExists(roll, excludeStudentId = null) {
    let query = supabase.from('students').select('id').eq('roll', roll).eq('active', true);
    if (excludeStudentId) {
      query = query.neq('id', excludeStudentId);
    }
    const { data, error } = await query;
    if (error) return false;
    return data && data.length > 0;
  },

  async hardDelete(id, uid, photoURL) {
    // 1. Delete image from storage
    if (photoURL) {
      const parts = photoURL.split('/avatars/');
      if (parts.length === 2) {
        const oldFilename = parts[1].split('?')[0];
        await supabase.storage.from('avatars').remove([oldFilename]);
      }
    }
    
    // 2. Delete student record (cascades to attendance)
    const { error: studentErr } = await supabase.from('students').delete().eq('id', id);
    if (studentErr) {
      handlePgError(studentErr, 'StudentsDB.hardDelete (student)');
      return;
    }

    // 3. Delete from public.users and auth.users
    if (uid) {
      await UsersDB.reject(uid); // This executes delete_user_completely RPC
    }

    await logAudit('HARD_DELETE_STUDENT', { student_id: id });
  }
};

// ── COURSES ───────────────────────────────────────────────────
const CoursesDB = {
  async add(data) {
    const { error } = await supabase.from('courses').insert([{
      code: data.code,
      name: data.name,
      dept: data.dept || null,
      sem: data.sem || null,
      created_by: Auth.user.id,
      created_by_name: Auth.userDoc?.displayName || 'Teacher'
    }]);
    handlePgError(error, 'CoursesDB.add');
    await logAudit('ADD_COURSE', { course: data.code });
  },

  listenAll(callback) {
    const fetch = async () => {
      const { data, error } = await supabase.from('courses').select('*').order('name');
      if (!error && data) {
        callback(data.map(c => ({...c, createdByName: c.created_by_name, totalClasses: c.total_classes})));
      }
    };
    fetch();

    const channel = supabase.channel(`public:courses:all:${Math.random()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'courses' }, fetch)
      .subscribe();
      
    return () => supabase.removeChannel(channel);
  },

  async delete(id) {
    const { error } = await supabase.from('courses').delete().eq('id', id);
    handlePgError(error, 'CoursesDB.delete');
    await logAudit('DELETE_COURSE', { course_id: id });
  }
};

// ── SESSIONS ──────────────────────────────────────────────────
const SessionsDB = {
  async open(data) {
    const { data: inserted, error } = await supabase.from('sessions').insert([{
      course_id: data.courseId,
      course_name: data.courseName,
      course_code: data.courseCode,
      date: data.date,
      start_time: data.startTime,
      end_time: data.endTime || null,
      room: data.room || null,
      dept: data.dept || null,
      sem: data.sem || null,
      cls: data.cls || null,
      status: 'open',
      teacher_id: Auth.user.id,
      teacher_name: Auth.userDoc?.displayName || 'Teacher',
      total_present: 0
    }]).select().single();

    handlePgError(error, 'SessionsDB.open');

    // Increment course total classes
    await supabase.rpc('increment_course_classes', { p_course_id: data.courseId });

    await logAudit('OPEN_SESSION', { session_id: inserted.id, course: data.courseName });
    
    return {
      ...inserted,
      courseId: inserted.course_id,
      courseName: inserted.course_name,
      startTime: inserted.start_time,
      teacherName: inserted.teacher_name,
      totalPresent: inserted.total_present
    };
  },

  async close(id) {
    const { error } = await supabase.from('sessions').update({ 
      status: 'closed',
      end_time: UI.nowTimeString()
    }).eq('id', id);
    handlePgError(error, 'SessionsDB.close');
    await logAudit('CLOSE_SESSION', { session_id: id });
  },

  listenOpen(callback) {
    const fetch = async () => {
      const { data, error } = await supabase.from('sessions').select('*').eq('status', 'open').order('created_at', { ascending: false });
      if (!error && data) {
        const now = new Date();
        const activeSessions = [];
        
        for (const s of data) {
          let shouldClose = false;
          
          // Check 1: 4-hour absolute fallback
          const createdAt = new Date(s.created_at);
          const hoursOpen = (now - createdAt) / (1000 * 60 * 60);
          if (hoursOpen > 4) shouldClose = true;
          
          // Check 2: End time passed
          if (!shouldClose && s.end_time && s.date) {
            const endDate = new Date(`${s.date}T${s.end_time}:00`);
            if (now > endDate) shouldClose = true;
          }
          
          if (shouldClose) {
            console.log(`[Zombie Cleanup] Auto-closing session ${s.id}`);
            SessionsDB.close(s.id); // Background close
          } else {
            activeSessions.push(s);
          }
        }

        callback(activeSessions.map(s => ({
          ...s, courseId: s.course_id, courseName: s.course_name, 
          teacherName: s.teacher_name, totalPresent: s.total_present
        })));
      }
    };
    fetch();

    const channel = supabase.channel(`public:sessions:open:${Math.random()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, fetch)
      .subscribe();
      
    return () => supabase.removeChannel(channel);
  },

  async getByCourse(courseId) {
    const { data, error } = await supabase.from('sessions').select('*').eq('course_id', courseId).order('date', { ascending: false }).order('start_time', { ascending: false });
    handlePgError(error, 'SessionsDB.getByCourse');
    return data.map(s => ({
      ...s, courseId: s.course_id, courseName: s.course_name, 
      startTime: s.start_time, totalPresent: s.total_present
    }));
  }
};

// ── ATTENDANCE ────────────────────────────────────────────────
const AttendanceDB = {
  async mark(session, student, confidence, method = 'face') {
    // Check if already marked
    const { data: existing, error: checkErr } = await supabase.from('attendance_records')
      .select('id')
      .eq('session_id', session.id)
      .eq('student_id', student.id)
      .maybeSingle();

    if (existing) return { alreadyMarked: true };

    const { error } = await supabase.from('attendance_records').insert([{
      session_id: session.id,
      student_id: student.id,
      student_name: student.name,
      roll: student.roll,
      course_id: session.courseId,
      course_name: session.courseName,
      date: session.date,
      time: UI.nowTimeString(),
      confidence: confidence,
      method: method,
      marked_by: Auth.user.id
    }]);

    if (error && error.code === '23505') {
      return { alreadyMarked: true };
    }
    handlePgError(error, 'AttendanceDB.mark');

    // Increment session total present
    await supabase.rpc('increment_session_present', { p_session_id: session.id });

    return { alreadyMarked: false };
  },

  listenBySession(sessionId, callback) {
    const fetch = async () => {
      const { data, error } = await supabase.from('attendance_records').select('*').eq('session_id', sessionId).order('created_at', { ascending: true });
      if (!error && data) {
        callback(data.map(r => ({
          ...r, studentId: r.student_id, studentName: r.student_name,
          courseId: r.course_id, courseName: r.course_name
        })));
      }
    };
    fetch();

    const channel = supabase.channel(`public:attendance_records:session=${sessionId}:${Math.random()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'attendance_records', filter: `session_id=eq.${sessionId}` }, fetch)
      .subscribe();
      
    return () => supabase.removeChannel(channel);
  },

  listenToday(date, callback) {
    const fetch = async () => {
      const { count, error } = await supabase.from('attendance_records').select('id', { count: 'exact' }).eq('date', date);
      if (!error) callback(count || 0);
    };
    fetch();

    const channel = supabase.channel(`public:attendance_records:today=${date}:${Math.random()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'attendance_records', filter: `date=eq.${date}` }, fetch)
      .subscribe();
      
    return () => supabase.removeChannel(channel);
  },

  async getByStudent(studentId) {
    const { data, error } = await supabase.from('attendance_records').select('*').eq('student_id', studentId).order('date', { ascending: false }).order('time', { ascending: false });
    handlePgError(error, 'AttendanceDB.getByStudent');
    return data.map(r => ({
      ...r, studentId: r.student_id, studentName: r.student_name,
      courseId: r.course_id, courseName: r.course_name
    }));
  },

  async getByCourse(courseId) {
    const { data, error } = await supabase.from('attendance_records').select('*').eq('course_id', courseId).order('date', { ascending: false }).order('time', { ascending: false });
    handlePgError(error, 'AttendanceDB.getByCourse');
    return data.map(r => ({
      ...r, studentId: r.student_id, studentName: r.student_name,
      courseId: r.course_id, courseName: r.course_name
    }));
  }
};

// ── AUDIT LOG ─────────────────────────────────────────────────
const AuditLogDB = {
  async getRecent(limit = 10) {
    const { data, error } = await supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(limit);
    handlePgError(error, 'AuditLogDB.getRecent');
    return data.map(l => ({
      ...l, userName: l.user_name, timestamp: l.created_at
    }));
  }
};

// ── SETTINGS ──────────────────────────────────────────────────
const SettingsDB = {
  async get() {
    const { data, error } = await supabase.from('settings').select('*').eq('id', 'global').single();
    if (error && error.code !== 'PGRST116') handlePgError(error, 'SettingsDB.get');
    if (!data) return {};
    return {
      institutionName: data.institution_name,
      threshold: data.threshold,
      allowedEmailDomain: data.allowed_email_domain
    };
  },

  async update(settings) {
    const { error } = await supabase.from('settings').upsert({
      id: 'global',
      institution_name: settings.institutionName,
      threshold: settings.threshold,
      allowed_email_domain: settings.allowedEmailDomain
    });
    handlePgError(error, 'SettingsDB.update');
    await logAudit('UPDATE_SETTINGS', settings);
  }
};

window.UsersDB      = UsersDB;
window.StudentsDB   = StudentsDB;
window.CoursesDB    = CoursesDB;
window.SessionsDB   = SessionsDB;
window.AttendanceDB = AttendanceDB;
window.AuditLogDB   = AuditLogDB;
window.SettingsDB   = SettingsDB;
