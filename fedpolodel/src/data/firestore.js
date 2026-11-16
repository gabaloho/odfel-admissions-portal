const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { programmeId } = require("../config/institution");
const { gradeScore } = require("../config/grading");

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const key = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const normalizeGatewayStatus = (s) => String(s || "").trim().toLowerCase() || "unknown";
const isSuccessGatewayStatus = (s) => ["success", "successful", "completed", "paid"].includes(normalizeGatewayStatus(s));
const isAdminPasswordExpired = (admin) => Boolean(admin?.passwordExpiresAt && new Date(admin.passwordExpiresAt).getTime() < Date.now());
const expiry = () => new Date(Date.now() + 90 * 86400000).toISOString();

function passwordError(password) {
  const value = String(password || "");
  if (value.length < 10) return "Password must be at least 10 characters.";
  if (!/[a-z]/.test(value)) return "Password must include at least one lowercase letter.";
  if (!/[A-Z]/.test(value)) return "Password must include at least one uppercase letter.";
  if (!/[0-9]/.test(value)) return "Password must include at least one number.";
  if (!/[^A-Za-z0-9]/.test(value)) return "Password must include at least one special character.";
  return null;
}

function configuredPrograms() {
  let programs;
  try {
    programs = process.env.PROGRAMS_JSON ? JSON.parse(process.env.PROGRAMS_JSON) : [{ id: "sample-program", name: "Sample Program (configure before launch)" }];
  } catch {
    throw new Error("PROGRAMS_JSON must be a valid JSON array of program objects.");
  }
  if (!Array.isArray(programs) || !programs.length || programs.some((p) => !p || typeof p.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(p.id) || typeof p.name !== "string" || !p.name.trim()) || new Set(programs.map((p) => p.id)).size !== programs.length) {
    throw new Error("PROGRAMS_JSON must contain unique program IDs and non-empty program names.");
  }
  return programs.map((p) => ({ id: p.id.trim(), name: p.name.trim() }));
}

function createFirestoreStore(db) {
  const col = (name) => db.collection(name);
  const ref = (name, docId) => col(name).doc(String(docId));
  const get = async (name, docId) => {
    if (typeof docId !== "string" || !docId || docId.includes("/") || docId === "." || docId === ".." || Buffer.byteLength(docId) > 1500) return null;
    const snapshot = await ref(name, docId).get();
    return snapshot.exists ? snapshot.data() : null;
  };
  const all = async (query) => (await query.get()).docs.map((d) => d.data());
  const sorted = (rows, field) => rows.sort((a, b) => String(b[field]).localeCompare(String(a[field])));
  const audit = ({ invoiceNumber = null, actorType, actorId = null, actorLabel = null, action, beforeStatus = null, afterStatus = null, note = null, metadata = null }) => ({
    id: id(), invoiceNumber, actorType, actorId, actorLabel: actorLabel || (actorId ? `${actorType}: ${actorId}` : actorType || "system"),
    action, beforeStatus, afterStatus, note, metadataJson: metadata ? JSON.stringify(metadata) : null, createdAt: now(),
  });

  async function ensureSeed({ defaultAdminUsername, defaultAdminPassword }) {
    const programs = configuredPrograms();
    const username = String(defaultAdminUsername || "admin").trim();
    const error = passwordError(defaultAdminPassword);
    if (error) throw new Error(`Default admin password is invalid: ${error}`);
    const hash = await bcrypt.hash(String(defaultAdminPassword), 10);
    const seedRef = ref("settings", "initial-seed");
    await db.runTransaction(async (tx) => {
      if ((await tx.get(seedRef)).exists) return;
      const timestamp = now();
      const admin = { id: id(), username, passwordHash: hash, role: "super_admin", isActive: true, mustChangePassword: false, passwordChangedAt: timestamp, passwordExpiresAt: expiry(), createdAt: timestamp, updatedAt: timestamp };
      for (const program of programs) tx.create(ref("programs", program.id), program);
      tx.create(ref("admins", admin.id), admin);
      tx.create(ref("admin_names", key(username)), { id: admin.id });
      tx.create(seedRef, { createdAt: timestamp });
    });
  }
  const getInstitutionSettings = () => get("settings", "institution");
  async function saveInstitutionSettings(settings, auditEntry) {
    const existing = await listPrograms();
    const programmes = settings.programmeNames.map((name) => {
      const current = existing.find((program) => program.name.toLowerCase() === name.toLowerCase());
      return current || { id: programmeId(name), name };
    });
    return db.runTransaction(async (tx) => {
      const snapshots = await Promise.all(programmes.map((program) => tx.get(ref("programs", program.id))));
      for (let i = 0; i < programmes.length; i++) {
        if (snapshots[i].exists && snapshots[i].data().name.toLowerCase() !== programmes[i].name.toLowerCase()) {
          throw new Error("Programme ID collision; institution settings were not saved.");
        }
        if (!snapshots[i].exists) tx.create(ref("programs", programmes[i].id), programmes[i]);
      }
      const saved = { ...settings, programmeIds: programmes.map((program) => program.id) };
      const log = audit(auditEntry);
      tx.set(ref("settings", "institution"), saved);
      tx.create(ref("payment_audit_logs", log.id), log);
      return saved;
    });
  }
  const getAdminById = (adminId) => get("admins", adminId);
  async function getAnyAdminByUsername(username) {
    const index = await get("admin_names", key(String(username || "").trim()));
    return index ? getAdminById(index.id) : null;
  }
  async function getAdminByUsername(username) {
    const admin = await getAnyAdminByUsername(username);
    return admin?.isActive ? admin : null;
  }
  async function listAdminUsers() { return sorted(await all(col("admins")), "createdAt"); }
  async function createAdminUser({ username, password, role }) {
    username = String(username || "").trim(); role = String(role || "").trim();
    if (!username) return { error: "Username is required." };
    const error = passwordError(password);
    if (error) return { error };
    if (!role) return { error: "Role is required." };
    const timestamp = now();
    const admin = { id: id(), username, passwordHash: await bcrypt.hash(String(password), 10), role, isActive: true, mustChangePassword: true, passwordChangedAt: null, passwordExpiresAt: null, createdAt: timestamp, updatedAt: timestamp };
    return db.runTransaction(async (tx) => {
      const index = ref("admin_names", key(username));
      if ((await tx.get(index)).exists) return { error: "Username already exists." };
      tx.create(index, { id: admin.id });
      tx.create(ref("admins", admin.id), admin);
      return { admin };
    });
  }
  async function changeAdmin(adminId, changes) {
    if (typeof adminId !== "string" || !adminId || adminId.includes("/") || adminId === "." || adminId === ".." || Buffer.byteLength(adminId) > 1500) return null;
    const target = ref("admins", adminId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(target);
      if (!snap.exists) return null;
      const updated = { ...snap.data(), ...changes, updatedAt: now() };
      tx.set(target, updated);
      return updated;
    });
  }
  const setAdminActive = (adminId, active) => changeAdmin(adminId, { isActive: Boolean(active) });
  const updateAdminRole = (adminId, role) => changeAdmin(adminId, { role: String(role || "").trim() });
  async function resetAdminPassword(adminId, password) {
    const error = passwordError(password);
    if (error) return { error };
    const admin = await changeAdmin(adminId, { passwordHash: await bcrypt.hash(String(password), 10), mustChangePassword: true, passwordChangedAt: null, passwordExpiresAt: null });
    return admin ? { admin } : { error: "Admin account not found." };
  }
  async function changeOwnAdminPassword({ adminId, currentPassword, newPassword }) {
    const target = ref("admins", adminId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(target);
      const admin = snap.exists ? snap.data() : null;
      if (!admin?.isActive) return { error: "Admin account not found." };
      if (!(await bcrypt.compare(String(currentPassword || ""), admin.passwordHash))) return { error: "Current password is incorrect." };
      const error = passwordError(newPassword);
      if (error) return { error };
      if (await bcrypt.compare(String(newPassword), admin.passwordHash)) return { error: "New password must be different from current password." };
      const timestamp = now();
      const updated = { ...admin, passwordHash: await bcrypt.hash(String(newPassword), 10), mustChangePassword: false, passwordChangedAt: timestamp, passwordExpiresAt: expiry(), updatedAt: timestamp };
      tx.set(target, updated);
      return { admin: updated };
    });
  }
  async function createUser({ surname, otherNames, email, phone, passwordHash }) {
    email = String(email || "").trim().toLowerCase();
    const user = { id: id(), surname: String(surname).trim(), otherNames: String(otherNames).trim(), email, phone: String(phone).trim(), passwordHash, createdAt: now() };
    await db.runTransaction(async (tx) => {
      const index = ref("user_emails", key(email));
      if ((await tx.get(index)).exists) {
        const error = new Error("Email already exists.");
        error.code = "DUPLICATE_EMAIL";
        throw error;
      }
      tx.create(index, { id: user.id });
      tx.create(ref("users", user.id), user);
    });
    return user;
  }
  async function getUserByEmail(email) {
    const index = await get("user_emails", key(String(email || "").trim().toLowerCase()));
    return index ? get("users", index.id) : null;
  }
  const getUserById = (userId) => get("users", userId);
  const getProgramById = (programId) => get("programs", programId);
  async function listPrograms() { return (await all(col("programs"))).sort((a, b) => a.name.localeCompare(b.name)); }
  async function createOrUpdateApplication({ userId, programId, modeOfStudy, previousInstitution, notes }) {
    const target = ref("applications", userId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(target);
      const timestamp = now();
      const existing = snap.exists ? snap.data() : { id: id(), userId, status: "Pending Screening", submittedAt: timestamp };
      if (existing.status !== "Pending Screening") return { error: "Decided applications cannot be changed." };
      const application = { ...existing, programId, modeOfStudy, previousInstitution, notes: notes || "", updatedAt: timestamp };
      tx.set(target, application);
      return application;
    });
  }
  const getApplicationByUserId = (userId) => get("applications", userId);
  const sisLog = (tx, actor, action, note, metadata) => {
    const log = audit({ actorType: "admin", actorId: actor.id, actorLabel: actor.label, action, note, metadata });
    tx.create(ref("payment_audit_logs", log.id), log);
  };
  async function listAcademicStructure() {
    const [schools, departments, assignments, programs] = await Promise.all([all(col("schools")), all(col("departments")), all(col("programme_departments")), listPrograms()]);
    return { schools: schools.sort((a, b) => a.name.localeCompare(b.name)), departments: departments.sort((a, b) => a.name.localeCompare(b.name)), assignments, programs };
  }
  async function createSchool(name, actor) {
    const school = { id: id(), name };
    return db.runTransaction(async (tx) => {
      const index = ref("school_names", key(name.toLowerCase()));
      if ((await tx.get(index)).exists) return { error: "School already exists." };
      tx.create(ref("schools", school.id), school);
      tx.create(index, { id: school.id });
      sisLog(tx, actor, "school_created", null, { schoolId: school.id });
      return { school };
    });
  }
  async function createDepartment(schoolId, name, actor) {
    const department = { id: id(), schoolId, name };
    return db.runTransaction(async (tx) => {
      const school = await tx.get(ref("schools", schoolId));
      const index = ref("department_names", key(`${schoolId}:${name.toLowerCase()}`));
      const existing = await tx.get(index);
      if (!school.exists) return { error: "School not found." };
      if (existing.exists) return { error: "Department already exists in this school." };
      tx.create(ref("departments", department.id), department);
      tx.create(index, { id: department.id });
      sisLog(tx, actor, "department_created", null, { departmentId: department.id, schoolId });
      return { department };
    });
  }
  async function assignProgrammeDepartment(programId, departmentId, actor) {
    return db.runTransaction(async (tx) => {
      const [program, department] = await Promise.all([tx.get(ref("programs", programId)), tx.get(ref("departments", departmentId))]);
      if (!program.exists || !department.exists) return { error: "Programme or department not found." };
      tx.set(ref("programme_departments", programId), { programId, departmentId });
      sisLog(tx, actor, "programme_department_assigned", null, { programId, departmentId });
      return { success: true };
    });
  }
  async function listAdmissions() {
    const applications = await all(col("applications"));
    const rows = await Promise.all(applications.map(async (application) => {
      const [user, program, invoice] = await Promise.all([getUserById(application.userId), getProgramById(application.programId), getLatestInvoiceByUserId(application.userId)]);
      if (!user || !program) throw new Error(`Application ${application.id} references a missing user or programme.`);
      return { userId: user.id, surname: user.surname, otherNames: user.otherNames, email: user.email, programId: program.id, programName: program.name, status: application.status, modeOfStudy: application.modeOfStudy, previousInstitution: application.previousInstitution, notes: application.notes, submittedAt: application.submittedAt, paymentStatus: invoice?.paymentStatus || null };
    }));
    return sorted(rows, "submittedAt");
  }
  async function decideAdmission(userId, decision, note, actor) {
    return db.runTransaction(async (tx) => {
      const target = ref("applications", userId);
      const snap = await tx.get(target);
      if (!snap.exists) return { error: "Application not found." };
      const application = snap.data();
      if (application.status === "Matriculated") return { error: "A matriculated application cannot be changed." };
      if (!["Pending Screening", "Admitted", "Rejected"].includes(application.status)) return { error: "Application is not eligible for a decision." };
      if (application.status === decision) return { error: "Application already has this decision." };
      tx.set(target, { ...application, status: decision, updatedAt: now() });
      sisLog(tx, actor, "admission_decision", note, { userId, applicationId: application.id, beforeStatus: application.status, afterStatus: decision });
      return { status: decision };
    });
  }
  async function matriculateStudent(userId, matriculationNumber, actor) {
    return db.runTransaction(async (tx) => {
      const applicationRef = ref("applications", userId);
      const snap = await tx.get(applicationRef);
      if (!snap.exists) return { error: "Application not found." };
      const application = snap.data();
      if (application.status !== "Admitted") return { error: "Only an admitted applicant can be matriculated." };
      const numberRef = ref("matriculation_numbers", key(matriculationNumber.toLowerCase()));
      const [number, existing, assignment] = await Promise.all([tx.get(numberRef), tx.get(ref("students", userId)), tx.get(ref("programme_departments", application.programId))]);
      if (number.exists || existing.exists) return { error: "Matriculation number is already in use or the student already exists." };
      if (!assignment.exists) return { error: "Assign the applicant's programme to a department before matriculation." };
      const department = await tx.get(ref("departments", assignment.data().departmentId));
      if (!department.exists) throw new Error("Assigned department does not exist.");
      const student = { userId, applicationId: application.id, matriculationNumber, programId: application.programId, departmentId: department.data().id, schoolId: department.data().schoolId, createdAt: now() };
      tx.create(ref("students", userId), student);
      tx.create(numberRef, { userId });
      tx.set(applicationRef, { ...application, status: "Matriculated", updatedAt: student.createdAt });
      sisLog(tx, actor, "student_matriculated", null, { userId, applicationId: application.id, matriculationNumber });
      return { student };
    });
  }
  const getStudentByUserId = (userId) => get("students", userId);
  async function listStudents() {
    const students = await all(col("students"));
    const rows = await Promise.all(students.map(async (student) => {
      const [user, program, department, school] = await Promise.all([getUserById(student.userId), getProgramById(student.programId), get("departments", student.departmentId), get("schools", student.schoolId)]);
      if (!user || !program || !department || !school) throw new Error(`Student ${student.userId} references a missing record.`);
      return { userId: user.id, surname: user.surname, otherNames: user.otherNames, email: user.email, matriculationNumber: student.matriculationNumber, programName: program.name, departmentName: department.name, schoolName: school.name, createdAt: student.createdAt };
    }));
    return sorted(rows, "createdAt");
  }
  async function listCourseCatalog() {
    const [terms, courses, offerings, programs] = await Promise.all([all(col("academic_terms")), all(col("courses")), all(col("course_offerings")), listPrograms()]);
    return { terms: sorted(terms, "createdAt"), courses: courses.sort((a, b) => a.code.localeCompare(b.code)), offerings, programs };
  }
  async function createAcademicTerm(sessionName, termName, actor) {
    const term = { id: id(), sessionName, termName, registrationOpen: false, createdAt: now() };
    return db.runTransaction(async (tx) => {
      const index = ref("academic_term_names", key(JSON.stringify([sessionName.toLowerCase(), termName.toLowerCase()])));
      if ((await tx.get(index)).exists) return { error: "This term already exists in the academic session." };
      tx.create(ref("academic_terms", term.id), term);
      tx.create(index, { id: term.id });
      sisLog(tx, actor, "academic_term_created", null, { termId: term.id });
      return { term };
    });
  }
  async function setRegistrationOpen(termId, open, actor) {
    return db.runTransaction(async (tx) => {
      const target = ref("academic_terms", termId);
      const snap = await tx.get(target);
      if (!snap.exists) return { error: "Academic term not found." };
      if (snap.data().registrationOpen === open) return { error: "Registration is already in that state." };
      tx.set(target, { ...snap.data(), registrationOpen: open });
      sisLog(tx, actor, "registration_window_changed", null, { termId, registrationOpen: open });
      return { success: true };
    });
  }
  async function createCourse(input, actor) {
    const course = { id: id(), ...input };
    return db.runTransaction(async (tx) => {
      const index = ref("course_codes", key(JSON.stringify([input.programId, input.code.toLowerCase()])));
      const [program, existing] = await Promise.all([tx.get(ref("programs", input.programId)), tx.get(index)]);
      if (!program.exists) return { error: "Programme not found." };
      if (existing.exists) return { error: "Course code already exists in this programme." };
      tx.create(ref("courses", course.id), course);
      tx.create(index, { id: course.id });
      sisLog(tx, actor, "course_created", null, { courseId: course.id, programId: course.programId });
      return { course };
    });
  }
  async function createCourseOffering(termId, courseId, actor) {
    const offering = { id: id(), termId, courseId };
    return db.runTransaction(async (tx) => {
      const index = ref("offering_keys", key(JSON.stringify([termId, courseId])));
      const [term, course, existing] = await Promise.all([tx.get(ref("academic_terms", termId)), tx.get(ref("courses", courseId)), tx.get(index)]);
      if (!term.exists || !course.exists) return { error: "Term or course not found." };
      if (existing.exists) return { error: "Course is already offered in this term." };
      tx.create(ref("course_offerings", offering.id), offering);
      tx.create(index, { id: offering.id });
      sisLog(tx, actor, "course_offered", null, { termId, courseId, offeringId: offering.id });
      return { offering };
    });
  }
  async function getStudentCourses(userId) {
    const student = await getStudentByUserId(userId);
    if (!student) return null;
    const courses = await all(col("courses").where("programId", "==", student.programId));
    const courseRows = await Promise.all(courses.map(async (course) => {
      const offerings = await all(col("course_offerings").where("courseId", "==", course.id));
      return Promise.all(offerings.map(async (offering) => {
        const [term, registration] = await Promise.all([get("academic_terms", offering.termId), get("course_registrations", key(JSON.stringify([userId, offering.id])))]);
        if (!term) throw new Error(`Course offering ${offering.id} references a missing term.`);
        if (!term.registrationOpen && !registration) return null;
        return { offeringId: offering.id, termId: term.id, sessionName: term.sessionName, termName: term.termName, registrationOpen: term.registrationOpen, courseId: course.id, code: course.code, title: course.title, creditUnits: course.creditUnits, registrationStatus: registration?.status || null, updatedAt: registration?.updatedAt || null, termCreatedAt: term.createdAt };
      }));
    }));
    return courseRows.flat().filter(Boolean).sort((a, b) => b.termCreatedAt.localeCompare(a.termCreatedAt) || a.code.localeCompare(b.code)).map(({ termCreatedAt, ...row }) => row);
  }
  async function changeCourseRegistration(userId, offeringId, status, actor) {
    return db.runTransaction(async (tx) => {
      const [student, offering] = await Promise.all([tx.get(ref("students", userId)), tx.get(ref("course_offerings", offeringId))]);
      if (!student.exists) return { error: "Only matriculated students can register for courses." };
      if (!offering.exists) return { error: "Course offering is not available for your programme." };
      const record = ref("course_registrations", key(JSON.stringify([userId, offeringId])));
      const [term, course, existing, result] = await Promise.all([tx.get(ref("academic_terms", offering.data().termId)), tx.get(ref("courses", offering.data().courseId)), tx.get(record), tx.get(ref("academic_results", key(JSON.stringify([userId, offeringId]))))]);
      if (!course.exists || course.data().programId !== student.data().programId) return { error: "Course offering is not available for your programme." };
      if (!term.exists) throw new Error(`Course offering ${offeringId} references a missing term.`);
      if (!term.data().registrationOpen) return { error: "Course registration is closed for this term." };
      if (status === "dropped" && result.exists) return { error: "A course with a recorded result cannot be dropped." };
      if ((!existing.exists && status === "dropped") || (existing.exists && existing.data().status === status)) return { error: status === "registered" ? "Course is already registered." : "Course is not registered." };
      const updatedAt = now();
      tx.set(record, { userId, offeringId, status, updatedAt });
      const log = audit({ actorType: "student", actorId: userId, actorLabel: actor.label, action: "course_registration_changed", metadata: { offeringId, status } });
      tx.create(ref("payment_audit_logs", log.id), log);
      return { status, updatedAt };
    });
  }
  async function createAttendanceMeeting(offeringId, meetingDate, label, actor) {
    const meeting = { id: id(), offeringId, meetingDate, label, createdAt: now() };
    return db.runTransaction(async (tx) => {
      const index = ref("attendance_meeting_keys", key(JSON.stringify([offeringId, meetingDate, label.toLowerCase()])));
      const [offering, existing] = await Promise.all([tx.get(ref("course_offerings", offeringId)), tx.get(index)]);
      if (!offering.exists) return { error: "Course offering not found." };
      if (existing.exists) return { error: "This meeting already exists for the course and date." };
      tx.create(ref("attendance_meetings", meeting.id), meeting);
      tx.create(index, { id: meeting.id });
      sisLog(tx, actor, "attendance_meeting_created", null, { meetingId: meeting.id, offeringId, meetingDate, label });
      return { meeting };
    });
  }
  async function listAttendanceMeetings() {
    const meetings = await all(col("attendance_meetings"));
    const rows = await Promise.all(meetings.map(async (meeting) => {
      const offering = await get("course_offerings", meeting.offeringId);
      if (!offering) throw new Error("Meeting references a missing course offering.");
      const [course, term] = await Promise.all([get("courses", offering.courseId), get("academic_terms", offering.termId)]);
      if (!course || !term) throw new Error("Course offering references a missing record.");
      return { ...meeting, code: course.code, title: course.title, sessionName: term.sessionName, termName: term.termName };
    }));
    return rows.sort((a, b) => b.meetingDate.localeCompare(a.meetingDate) || a.code.localeCompare(b.code) || a.label.localeCompare(b.label));
  }
  async function getAttendanceRoster(meetingId) {
    const meeting = await get("attendance_meetings", meetingId);
    if (!meeting) return null;
    const [registrations, attendance] = await Promise.all([all(col("course_registrations").where("offeringId", "==", meeting.offeringId)), all(col("attendance_records").where("meetingId", "==", meetingId))]);
    const rows = await Promise.all(registrations.map(async (registration) => {
      const record = attendance.find((entry) => entry.userId === registration.userId);
      if (registration.status !== "registered" && !record) return null;
      const [student, user] = await Promise.all([getStudentByUserId(registration.userId), getUserById(registration.userId)]);
      if (!student || !user) throw new Error("Course registration references a missing student.");
      return { userId: student.userId, matriculationNumber: student.matriculationNumber, surname: user.surname, otherNames: user.otherNames, registrationStatus: registration.status, status: record?.status || null, revision: record?.revision || null, updatedAt: record?.updatedAt || null };
    }));
    return { meeting, roster: rows.filter(Boolean).sort((a, b) => a.surname.localeCompare(b.surname) || a.otherNames.localeCompare(b.otherNames)) };
  }
  async function saveAttendance(meetingId, userId, status, expectedRevision, actor) {
    return db.runTransaction(async (tx) => {
      const meeting = await tx.get(ref("attendance_meetings", meetingId));
      if (!meeting.exists) return { error: "Meeting not found." };
      const record = ref("attendance_records", key(JSON.stringify([meetingId, userId])));
      const [registration, previous] = await Promise.all([tx.get(ref("course_registrations", key(JSON.stringify([userId, meeting.data().offeringId])))), tx.get(record)]);
      if (!registration.exists || registration.data().status !== "registered") return { error: "Student is not currently registered for this course." };
      const previousStatus = previous.exists ? previous.data().status : null;
      if ((previous.exists ? previous.data().revision : null) !== expectedRevision) return { error: "Attendance changed. Refresh and review it before saving." };
      const updatedAt = now();
      const revision = id();
      tx.set(record, { meetingId, userId, status, revision, updatedAt });
      sisLog(tx, actor, "attendance_recorded", null, { meetingId, userId, previousStatus, status });
      return { status, revision, updatedAt };
    });
  }
  async function getStudentAttendance(userId) {
    if (!await getStudentByUserId(userId)) return null;
    const records = await all(col("attendance_records").where("userId", "==", userId));
    const rows = await Promise.all(records.map(async (record) => {
      const meeting = await get("attendance_meetings", record.meetingId);
      if (!meeting) throw new Error("Attendance references a missing meeting.");
      const offering = await get("course_offerings", meeting.offeringId);
      if (!offering) throw new Error("Meeting references a missing course offering.");
      const [course, term] = await Promise.all([get("courses", offering.courseId), get("academic_terms", offering.termId)]);
      if (!course || !term) throw new Error("Course offering references a missing record.");
      return { meetingId: meeting.id, meetingDate: meeting.meetingDate, label: meeting.label, code: course.code, title: course.title, sessionName: term.sessionName, termName: term.termName, status: record.status, updatedAt: record.updatedAt };
    }));
    return rows.sort((a, b) => b.meetingDate.localeCompare(a.meetingDate) || a.code.localeCompare(b.code) || a.label.localeCompare(b.label));
  }
  async function getOperationalReport() {
    const [applications, students, registrations, results, meetings, attendance, invoices] = await Promise.all(
      ["applications", "students", "course_registrations", "academic_results", "attendance_meetings", "attendance_records", "invoices"].map((name) => all(col(name)))
    );
    const counts = (rows, field) => Object.entries(rows.reduce((acc, row) => {
      const value = row[field];
      if (typeof value !== "string" || !value) throw new Error(`Missing ${field} in reporting record.`);
      acc[value] = (acc[value] || 0) + 1;
      return acc;
    }, Object.create(null))).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => ({ status, count }));
    return { applications: counts(applications, "status"), students: students.length, registrations: counts(registrations, "status"), publishedResults: results.filter((result) => result.published).length, meetings: meetings.length, attendance: counts(attendance, "status"), studentFees: counts(invoices.filter((invoice) => invoice.invoiceKind === "student_fee"), "paymentStatus") };
  }
  async function createGradingScale(programId, name, bands, actor) {
    const scale = { id: id(), programId, name, bands, createdAt: now() };
    return db.runTransaction(async (tx) => {
      if (!(await tx.get(ref("programs", programId))).exists) return { error: "Programme not found." };
      tx.create(ref("grading_scales", scale.id), scale);
      tx.set(ref("programme_grading_scales", programId), { programId, scaleId: scale.id });
      sisLog(tx, actor, "grading_scale_created", null, { programId, scaleId: scale.id });
      return { scale };
    });
  }
  async function listResultRoster() {
    const [activeScales, registrations, programs] = await Promise.all([all(col("programme_grading_scales")), all(col("course_registrations").where("status", "==", "registered")), listPrograms()]);
    const scales = await Promise.all(activeScales.map(async (active) => {
      const scale = await get("grading_scales", active.scaleId);
      if (!scale) throw new Error(`Grading scale ${active.scaleId} does not exist.`);
      return scale;
    }));
    const roster = await Promise.all(registrations.map(async (registration) => {
      const [student, user, offering, result] = await Promise.all([getStudentByUserId(registration.userId), getUserById(registration.userId), get("course_offerings", registration.offeringId), get("academic_results", key(JSON.stringify([registration.userId, registration.offeringId])))]);
      if (!student || !user || !offering) throw new Error("Course registration references a missing record.");
      const [course, term] = await Promise.all([get("courses", offering.courseId), get("academic_terms", offering.termId)]);
      if (!course || !term) throw new Error("Course offering references a missing record.");
      return { userId: student.userId, offeringId: offering.id, surname: user.surname, otherNames: user.otherNames, matriculationNumber: student.matriculationNumber, programId: course.programId, code: course.code, title: course.title, creditUnits: course.creditUnits, sessionName: term.sessionName, termName: term.termName, registrationOpen: term.registrationOpen, draftScore: result?.draftScore ?? null, draftReason: result?.draftReason ?? null, draftId: result?.draftId ?? null, published: result?.published || null };
    }));
    return { scales, roster, programs };
  }
  async function saveResultDraft(userId, offeringId, score, reason, actor) {
    return db.runTransaction(async (tx) => {
      const record = ref("academic_results", key(JSON.stringify([userId, offeringId])));
      const [registration, offering, existing] = await Promise.all([tx.get(ref("course_registrations", key(JSON.stringify([userId, offeringId])))), tx.get(ref("course_offerings", offeringId)), tx.get(record)]);
      if (!registration.exists || registration.data().status !== "registered") return { error: "Student is not registered for this course." };
      if (!offering.exists) throw new Error("Course registration references a missing offering.");
      const term = await tx.get(ref("academic_terms", offering.data().termId));
      if (!term.exists) throw new Error("Course offering references a missing term.");
      if (term.data().registrationOpen) return { error: "Close registration for this term before recording results." };
      tx.set(record, { ...(existing.exists ? existing.data() : { userId, offeringId, published: null }), draftScore: score, draftReason: reason, draftId: id(), draftUpdatedAt: now() });
      sisLog(tx, actor, "result_draft_saved", reason, { userId, offeringId });
      return { success: true };
    });
  }
  async function publishResult(userId, offeringId, expectedDraftId, expectedScaleId, actor) {
    return db.runTransaction(async (tx) => {
      const record = ref("academic_results", key(JSON.stringify([userId, offeringId])));
      const [registration, offering, result] = await Promise.all([tx.get(ref("course_registrations", key(JSON.stringify([userId, offeringId])))), tx.get(ref("course_offerings", offeringId)), tx.get(record)]);
      if (!registration.exists || registration.data().status !== "registered") return { error: "Student is not registered for this course." };
      if (!offering.exists) throw new Error("Course registration references a missing offering.");
      const [term, course] = await Promise.all([tx.get(ref("academic_terms", offering.data().termId)), tx.get(ref("courses", offering.data().courseId))]);
      if (!term.exists || !course.exists) throw new Error("Course offering references a missing record.");
      if (term.data().registrationOpen) return { error: "Close registration for this term before publishing results." };
      if (!result.exists || result.data().draftScore == null) return { error: "Save a draft score before publishing." };
      if (result.data().draftId !== expectedDraftId) return { error: "The draft changed. Refresh and review it before publishing." };
      const active = await tx.get(ref("programme_grading_scales", course.data().programId));
      if (!active.exists) return { error: "Configure a grading scale for this programme before publishing." };
      if (active.data().scaleId !== expectedScaleId) return { error: "The grading scale changed. Refresh and review it before publishing." };
      const scale = await tx.get(ref("grading_scales", active.data().scaleId));
      if (!scale.exists) throw new Error("Active grading scale does not exist.");
      const band = gradeScore(result.data().draftScore, scale.data().bands);
      if (!band) throw new Error("Stored grading scale does not cover the result score.");
      const publication = { id: id(), version: (result.data().published?.version || 0) + 1, score: result.data().draftScore, grade: band.label, gradePoints: band.gradePoints, creditUnits: course.data().creditUnits, scaleId: scale.data().id, scaleName: scale.data().name, reason: result.data().draftReason, publishedAt: now() };
      tx.create(ref("result_publications", publication.id), { userId, offeringId, publication });
      tx.set(record, { ...result.data(), draftScore: null, draftReason: null, draftId: null, draftUpdatedAt: null, published: publication });
      sisLog(tx, actor, "result_published", publication.reason, { userId, offeringId, publicationId: publication.id, version: publication.version });
      return { publication };
    });
  }
  async function getStudentPublishedResults(userId) {
    if (!await getStudentByUserId(userId)) return null;
    const results = await all(col("academic_results").where("userId", "==", userId));
    const rows = await Promise.all(results.filter((result) => result.published).map(async (result) => {
      const offering = await get("course_offerings", result.offeringId);
      if (!offering) throw new Error("Result references a missing offering.");
      const [course, term] = await Promise.all([get("courses", offering.courseId), get("academic_terms", offering.termId)]);
      if (!course || !term) throw new Error("Result references a missing course or term.");
      const { reason, ...publication } = result.published;
      return { code: course.code, title: course.title, sessionName: term.sessionName, termName: term.termName, publication, termCreatedAt: term.createdAt };
    }));
    return rows.sort((a, b) => b.termCreatedAt.localeCompare(a.termCreatedAt) || a.code.localeCompare(b.code)).map(({ termCreatedAt, ...row }) => row);
  }
  async function getResultHistory(userId, offeringId) {
    const records = await all(col("result_publications").where("userId", "==", userId));
    const publications = await Promise.all(records.filter((record) => record.offeringId === offeringId).map(async (record) => {
      const scale = await get("grading_scales", record.publication.scaleId);
      if (!scale) throw new Error("Published result references a missing grading scale.");
      return { ...record.publication, scale: { name: scale.name, bands: scale.bands } };
    }));
    return publications.sort((a, b) => b.version - a.version);
  }
  const getInvoiceByNumber = (number) => get("invoices", number);
  async function getLatestInvoiceByUserId(userId) {
    const index = await get("user_invoices", userId);
    return index ? getInvoiceByNumber(index.invoiceNumber) : null;
  }
  async function createInvoice({ userId, amount, feeDescription, currency }) {
    const timestamp = now();
    const invoice = { id: id(), userId, invoiceNumber: `INV-${Date.now().toString().slice(-8)}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, amount, feeDescription, currency, paymentStatus: "Unpaid", paymentReference: null, paymentProvider: null, paidAt: null, updatedAt: timestamp, createdAt: timestamp };
    return db.runTransaction(async (tx) => {
      const index = ref("user_invoices", userId);
      const snap = await tx.get(index);
      if (snap.exists) {
        const existing = await tx.get(ref("invoices", snap.data().invoiceNumber));
        if (existing.exists) return existing.data();
      }
      tx.create(ref("invoices", invoice.invoiceNumber), invoice);
      tx.set(index, { invoiceNumber: invoice.invoiceNumber });
      return invoice;
    });
  }
  async function createStudentFee({ userId, amount, feeDescription, currency, requestId }, actor) {
    const timestamp = now();
    const invoice = { id: id(), userId, invoiceNumber: `INV-${Date.now().toString().slice(-8)}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, amount, feeDescription, currency, invoiceKind: "student_fee", paymentStatus: "Unpaid", paymentReference: null, paymentProvider: null, paidAt: null, updatedAt: timestamp, createdAt: timestamp };
    return db.runTransaction(async (tx) => {
      const requestRef = ref("student_fee_requests", requestId);
      const [request, student] = await Promise.all([tx.get(requestRef), tx.get(ref("students", userId))]);
      if (request.exists) {
        const previous = await tx.get(ref("invoices", request.data().invoiceNumber));
        if (!previous.exists) throw new Error("Student fee request references a missing invoice.");
        const saved = previous.data();
        if (saved.userId !== userId || saved.amount !== amount || saved.currency !== currency || saved.feeDescription !== feeDescription) return { error: "Request ID was already used for a different student fee." };
        return { invoice: saved };
      }
      if (!student.exists) return { error: "Student not found." };
      const log = audit({ invoiceNumber: invoice.invoiceNumber, actorType: "admin", actorId: actor.id, actorLabel: actor.label, action: "student_fee_assigned", note: feeDescription, metadata: { userId, amount, currency } });
      tx.create(ref("invoices", invoice.invoiceNumber), invoice);
      tx.create(requestRef, { userId, invoiceNumber: invoice.invoiceNumber });
      tx.create(ref("payment_audit_logs", log.id), log);
      return { invoice };
    });
  }
  async function listStudentFees(userId) {
    return sorted((await all(col("invoices").where("userId", "==", userId))).filter((invoice) => invoice.invoiceKind === "student_fee"), "createdAt");
  }
  async function listStudentFeesForAdmin() {
    const invoices = await all(col("invoices").where("invoiceKind", "==", "student_fee"));
    const rows = await Promise.all(invoices.map(async (invoice) => {
      const user = await getUserById(invoice.userId);
      if (!user) throw new Error("Student fee invoice references a missing user.");
      return { ...invoice, surname: user.surname, otherNames: user.otherNames, email: user.email };
    }));
    return sorted(rows, "createdAt");
  }
  async function createAuditLog(input) {
    const log = audit(input);
    await ref("payment_audit_logs", log.id).create(log);
    return log;
  }
  async function recordPaymentTransaction(input) {
    const tx = { id: id(), invoiceNumber: input.invoiceNumber || null, userId: input.userId || null, provider: input.provider, eventType: input.eventType || null, gatewayStatus: input.gatewayStatus || null, gatewayReference: input.gatewayReference || null, amount: input.amount ?? null, currency: input.currency || null, signatureValid: Boolean(input.signatureValid), payloadJson: JSON.stringify(input.payload || {}), processingNote: input.processingNote || null, receivedAt: now(), processedAt: input.processedAt || null };
    await ref("payment_transactions", tx.id).create(tx);
    return tx;
  }
  async function updateInvoicePayment(input) {
    const target = ref("invoices", input.invoiceNumber);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(target);
      if (!snap.exists) return null;
      const current = snap.data();
      if (input.action === "reconciliation_auto_fix" && current.paymentStatus === "Paid") return null;
      // Retried gateway deliveries must not overwrite an existing payment.
      if (["webhook", "gateway"].includes(input.actorType) && current.paymentStatus === "Paid") {
        if (input.paymentReference && input.paymentReference !== current.paymentReference) {
          const log = audit({ ...input, action: "duplicate_payment_received", beforeStatus: "Paid", afterStatus: "Paid", note: `Invoice already paid (${current.paymentReference || "no reference"}); received another successful payment ${input.paymentReference}. Review for refund.` });
          tx.create(ref("payment_audit_logs", log.id), log);
        }
        return current;
      }
      const timestamp = now();
      const status = String(input.status || "").trim() || current.paymentStatus;
      const updated = { ...current, paymentStatus: status, paymentReference: input.paymentReference || current.paymentReference || null, paymentProvider: input.paymentProvider || current.paymentProvider || null, paidAt: status === "Paid" ? (input.paidAt || current.paidAt || timestamp) : null, updatedAt: timestamp };
      const log = audit({ ...input, beforeStatus: current.paymentStatus, afterStatus: status });
      tx.set(target, updated);
      tx.create(ref("payment_audit_logs", log.id), log);
      return updated;
    });
  }
  const markInvoicePaid = (invoiceNumber, paymentReference, opts = {}) => updateInvoicePayment({ invoiceNumber, status: "Paid", paymentReference, actorType: "system", action: "invoice_mark_paid", ...opts });
  const manualOverrideInvoice = (input) => updateInvoicePayment({ ...input, actorType: "admin", action: "manual_override", metadata: { source: "admin_console", ...(input.metadata || {}) } });
  async function listRecentPaymentTransactions(limit = 120) { return all(col("payment_transactions").orderBy("receivedAt", "desc").limit(limit)); }
  async function listRecentAuditLogs(limit = 120) { return all(col("payment_audit_logs").orderBy("createdAt", "desc").limit(limit)); }
  async function listPaymentHistoryByInvoice(number) { return sorted(await all(col("payment_transactions").where("invoiceNumber", "==", number)), "receivedAt"); }
  async function listAuditLogsByInvoice(number) { return sorted(await all(col("payment_audit_logs").where("invoiceNumber", "==", number)), "createdAt"); }
  async function getPaymentConfirmation(number) { return (await listAuditLogsByInvoice(number)).find((a) => a.afterStatus === "Paid" && a.beforeStatus !== "Paid") || null; }
  async function getSuccessfulTransactionByReference(number, reference) { return reference ? (await listPaymentHistoryByInvoice(number)).find((t) => t.gatewayReference === reference && t.signatureValid && isSuccessGatewayStatus(t.gatewayStatus)) || null : null; }
  async function invoicesWithApplicants(limit, { status = "", q = "" } = {}) {
    // Filtering must occur before the limit, matching the SQLite behavior.
    const invoices = await all(col("invoices").orderBy("createdAt", "desc"));
    const result = [];
    for (const invoice of invoices) {
      if (status && invoice.paymentStatus !== status) continue;
      const user = await getUserById(invoice.userId);
      if (q && ![invoice.invoiceNumber, invoice.paymentReference || "", user?.email || ""].some((v) => v.toLowerCase().includes(q.toLowerCase()))) continue;
      result.push({ ...invoice, applicantSurname: user?.surname || "", applicantOtherNames: user?.otherNames || "", applicantEmail: user?.email || "" });
      if (result.length >= limit) break;
    }
    return result;
  }
  const listInvoicesForAdmin = (filters) => invoicesWithApplicants(200, filters);
  async function reconciliationRows(filters, limit) {
    const invoices = await invoicesWithApplicants(limit, filters);
    return Promise.all(invoices.map(async (invoice) => {
      const match = (await listPaymentHistoryByInvoice(invoice.invoiceNumber)).find((t) => t.signatureValid && isSuccessGatewayStatus(t.gatewayStatus) && t.amount != null && Math.round(t.amount * 100) === Math.round(invoice.amount * 100) && String(t.currency || "").toUpperCase() === invoice.currency.toUpperCase());
      const reference = match?.gatewayReference || "";
      return { ...invoice, paymentReference: invoice.paymentReference || "", paymentProvider: invoice.paymentProvider || "", paidAt: invoice.paidAt || "", latestSuccessReference: reference, latestSuccessProvider: match?.provider || "", latestSuccessAt: match?.receivedAt || "", reconciliationFlag: reference && invoice.paymentStatus !== "Paid" ? "MISSING_PAID_STATUS" : invoice.paymentStatus === "Paid" && !reference ? "PAID_WITHOUT_SIGNED_SUCCESS_TX" : "OK" };
    }));
  }
  const listReconciliationRows = (filters) => reconciliationRows(filters, 500);
  async function getReconciliationReport() {
    const rows = await reconciliationRows({}, 400);
    const convert = (r) => ({ invoice_number: r.invoiceNumber, payment_status: r.paymentStatus, payment_reference: r.paymentReference || null, payment_provider: r.paymentProvider || null, amount: r.amount, currency: r.currency, latest_success_reference: r.latestSuccessReference || null, latest_success_provider: r.latestSuccessProvider || null, latest_success_at: r.latestSuccessAt || null });
    return { payableMismatch: rows.filter((r) => r.reconciliationFlag === "MISSING_PAID_STATUS").map(convert), paidWithoutTx: rows.filter((r) => r.reconciliationFlag === "PAID_WITHOUT_SIGNED_SUCCESS_TX").map(convert) };
  }
  async function autoReconcileInvoices(actorId, actorLabel = null) {
    const report = await getReconciliationReport();
    let updated = 0;
    for (const row of report.payableMismatch) {
      if (await updateInvoicePayment({ invoiceNumber: row.invoice_number, status: "Paid", paymentReference: row.latest_success_reference, paymentProvider: row.latest_success_provider, paidAt: row.latest_success_at, actorType: "admin", actorId, actorLabel, action: "reconciliation_auto_fix", note: "Auto-reconciled based on successful signed transaction.", metadata: { previousStatus: row.payment_status } })) updated++;
    }
    return { updated, mismatches: report.payableMismatch.length, paidWithoutTx: report.paidWithoutTx.length };
  }
  async function getDashboardByUserId(userId) {
    const [user, application, latestInvoice] = await Promise.all([getUserById(userId), getApplicationByUserId(userId), getLatestInvoiceByUserId(userId)]);
    return { user, application, program: application ? await getProgramById(application.programId) : null, latestInvoice, paymentHistory: latestInvoice ? await listPaymentHistoryByInvoice(latestInvoice.invoiceNumber) : [] };
  }
  return { ensureSeed, getInstitutionSettings, saveInstitutionSettings, getAdminByUsername, getAdminById, listAdminUsers, createAdminUser, setAdminActive, resetAdminPassword, updateAdminRole, isAdminPasswordExpired, changeOwnAdminPassword, createUser, getUserByEmail, getUserById, listPrograms, getProgramById, createOrUpdateApplication, getApplicationByUserId, listAcademicStructure, createSchool, createDepartment, assignProgrammeDepartment, listAdmissions, decideAdmission, matriculateStudent, getStudentByUserId, listStudents, listCourseCatalog, createAcademicTerm, setRegistrationOpen, createCourse, createCourseOffering, getStudentCourses, changeCourseRegistration, createAttendanceMeeting, listAttendanceMeetings, getAttendanceRoster, saveAttendance, getStudentAttendance, getOperationalReport, createGradingScale, listResultRoster, saveResultDraft, publishResult, getStudentPublishedResults, getResultHistory, createInvoice, createStudentFee, listStudentFees, listStudentFeesForAdmin, createAuditLog, recordPaymentTransaction, manualOverrideInvoice, updateInvoicePayment, listInvoicesForAdmin, listReconciliationRows, listRecentPaymentTransactions, listRecentAuditLogs, listPaymentHistoryByInvoice, listAuditLogsByInvoice, getPaymentConfirmation, getSuccessfulTransactionByReference, getReconciliationReport, autoReconcileInvoices, isSuccessGatewayStatus, normalizeGatewayStatus, markInvoicePaid, getInvoiceByNumber, getLatestInvoiceByUserId, getDashboardByUserId };
}

module.exports = { createFirestoreStore };
