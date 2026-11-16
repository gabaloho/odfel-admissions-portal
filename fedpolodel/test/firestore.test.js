const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createFirestoreStore } = require("../src/data/firestore");
const { FirestoreSessionStore } = require("../src/data/firestore-session");
const { selectStore } = require("../src/data/select-store");
const { createWebhookProcessor, hmacSha512Hex } = require("../src/payments/webhooks");

// An injected Firestore double, shared between independent adapter instances.
function fakeFirestore() {
  const data = new Map();
  let queue = Promise.resolve();
  const snap = (value) => ({ exists: value !== undefined, data: () => structuredClone(value) });
  function doc(path) {
    return {
      path,
      get: async () => snap(data.get(path)),
      set: async (value) => { data.set(path, structuredClone(value)); },
      create: async (value) => {
        if (data.has(path)) throw new Error("already exists");
        data.set(path, structuredClone(value));
      },
      delete: async () => { data.delete(path); },
      update: async (value) => {
        if (!data.has(path)) throw Object.assign(new Error("not found"), { code: 5 });
        data.set(path, { ...data.get(path), ...structuredClone(value) });
      },
    };
  }
  function query(name, filters = [], order = null, max = Infinity) {
    return {
      doc: (id) => doc(`${name}/${id}`),
      where: (field, op, value) => query(name, [...filters, [field, value]], order, max),
      orderBy: (field, direction) => query(name, filters, [field, direction], max),
      limit: (count) => query(name, filters, order, count),
      get: async () => {
        let rows = [...data.entries()].filter(([path, value]) => path.startsWith(`${name}/`) && filters.every(([field, expected]) => value[field] === expected)).map(([, value]) => value);
        if (order) rows.sort((a, b) => String(a[order[0]]).localeCompare(String(b[order[0]])) * (order[1] === "desc" ? -1 : 1));
        return { docs: rows.slice(0, max).map(snap) };
      },
    };
  }
  return {
    collection: (name) => query(name),
    runTransaction(fn) {
      const run = queue.then(async () => {
        const writes = [];
        const tx = {
          get: (ref) => ref.get(),
          set: (ref, value) => writes.push(() => ref.set(value)),
          create: (ref, value) => writes.push(() => ref.create(value)),
        };
        const result = await fn(tx);
        for (const write of writes) await write();
        return result;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

function sessionCall(store, method, ...args) {
  return new Promise((resolve, reject) => store[method](...args, (err, result) => err ? reject(err) : resolve(result)));
}

test("Firestore institution settings persist across adapters without deleting prior programmes", async () => {
  const db = fakeFirestore();
  const first = createFirestoreStore(db);
  const second = createFirestoreStore(db);
  await first.ensureSeed({ defaultAdminUsername: "admin", defaultAdminPassword: "AdminPass123!" });
  const oldProgram = (await first.listPrograms())[0];
  const audit = { actorType: "admin", actorId: "admin", action: "institution_settings_updated" };
  const settings = { institutionName: "Example", programmeNames: [oldProgram.name, "Computer Science"], feeAmount: 0.29 };
  const [a, b] = await Promise.all([first.saveInstitutionSettings(settings, audit), second.saveInstitutionSettings(settings, audit)]);
  assert.deepEqual(a.programmeIds, b.programmeIds);
  assert.equal((await second.getInstitutionSettings()).feeAmount, 0.29);
  assert.equal(a.programmeIds[0], oldProgram.id);
  await second.saveInstitutionSettings({ ...settings, programmeNames: ["Computer Science"] }, audit);
  assert.ok(await first.getProgramById(oldProgram.id));
  assert.equal((await first.listPrograms()).filter((p) => p.name === "Computer Science").length, 1);
  assert.equal((await first.listRecentAuditLogs()).filter((log) => log.action === "institution_settings_updated").length, 3);
});

test("Firestore SIS serializes decisions and unique matriculation across instances", async () => {
  const db = fakeFirestore();
  const a = createFirestoreStore(db);
  const b = createFirestoreStore(db);
  await a.ensureSeed({ defaultAdminUsername: "admin", defaultAdminPassword: "AdminPass123!" });
  const actor = { id: "staff", label: "Staff" };
  const school = (await a.createSchool("Technology", actor)).school;
  assert.ok((await b.createSchool("technology", actor)).error);
  const department = (await a.createDepartment(school.id, "Computing", actor)).department;
  const program = (await a.listPrograms())[0];
  await a.assignProgrammeDepartment(program.id, department.id, actor);
  const users = await Promise.all(["a", "b"].map((name) => a.createUser({ surname: name, otherNames: "User", email: `${name}@example.com`, phone: "1", passwordHash: "hash" })));
  for (const user of users) {
    await a.createOrUpdateApplication({ userId: user.id, programId: program.id, modeOfStudy: "Full-Time", previousInstitution: "School" });
    await a.decideAdmission(user.id, "Admitted", "Verified", actor);
  }
  const results = await Promise.all([a.matriculateStudent(users[0].id, "TEST/1", actor), b.matriculateStudent(users[1].id, "test/1", actor)]);
  assert.equal(results.filter((result) => result.student).length, 1);
  assert.equal(results.filter((result) => result.error).length, 1);
  const student = results.find((result) => result.student).student;
  assert.equal((await b.getApplicationByUserId(student.userId)).status, "Matriculated");
  assert.ok((await a.decideAdmission(student.userId, "Rejected", "Changed", actor)).error);
  assert.ok((await a.createOrUpdateApplication({ userId: student.userId, programId: program.id, modeOfStudy: "Other", previousInstitution: "School" })).error);
  assert.equal((await b.listStudents()).length, 1);
  assert.equal((await b.listAdmissions()).length, 2);
});

test("Firestore course registration respects programme and registration window across instances", async () => {
  const db = fakeFirestore();
  const a = createFirestoreStore(db);
  const b = createFirestoreStore(db);
  await a.ensureSeed({ defaultAdminUsername: "admin", defaultAdminPassword: "AdminPass123!" });
  const actor = { id: "staff", label: "Staff" };
  const program = (await a.listPrograms())[0];
  const school = (await a.createSchool("Technology", actor)).school;
  const department = (await a.createDepartment(school.id, "Computing", actor)).department;
  await a.assignProgrammeDepartment(program.id, department.id, actor);
  const user = await a.createUser({ surname: "Student", otherNames: "One", email: "student-courses@example.com", phone: "1", passwordHash: "hash" });
  await a.createOrUpdateApplication({ userId: user.id, programId: program.id, modeOfStudy: "Full-Time", previousInstitution: "School" });
  await a.decideAdmission(user.id, "Admitted", "Verified", actor);
  await a.matriculateStudent(user.id, "TEST/10", actor);
  const term = (await a.createAcademicTerm("2026/2027", "First", actor)).term;
  assert.ok((await b.createAcademicTerm("2026/2027", "first", actor)).error);
  const course = (await a.createCourse({ programId: program.id, code: "CSC101", title: "Computing", creditUnits: 3 }, actor)).course;
  const offering = (await a.createCourseOffering(term.id, course.id, actor)).offering;
  const studentActor = { label: "Student" };
  assert.ok((await b.changeCourseRegistration(user.id, offering.id, "registered", studentActor)).error);
  await a.setRegistrationOpen(term.id, true, actor);
  const attempts = await Promise.all([a.changeCourseRegistration(user.id, offering.id, "registered", studentActor), b.changeCourseRegistration(user.id, offering.id, "registered", studentActor)]);
  assert.equal(attempts.filter((result) => result.status === "registered").length, 1);
  assert.equal(attempts.filter((result) => result.error).length, 1);
  assert.equal((await b.getStudentCourses(user.id))[0].registrationStatus, "registered");
  const meeting = (await a.createAttendanceMeeting(offering.id, "2026-03-10", "Lecture 1", actor)).meeting;
  assert.ok((await b.createAttendanceMeeting(offering.id, "2026-03-10", "lecture 1", actor)).error);
  assert.ok((await b.saveAttendance(meeting.id, "unknown", "present", null, actor)).error);
  const initialMark = await a.saveAttendance(meeting.id, user.id, "present", null, actor);
  const updates = await Promise.all([a.saveAttendance(meeting.id, user.id, "late", initialMark.revision, actor), b.saveAttendance(meeting.id, user.id, "excused", initialMark.revision, actor)]);
  assert.equal(updates.filter((result) => result.error).length, 1);
  const recorded = updates.find((result) => result.status).status;
  assert.equal((await b.getStudentAttendance(user.id))[0].status, recorded);
  assert.equal((await b.getAttendanceRoster(meeting.id)).roster[0].status, recorded);
  const report = await b.getOperationalReport();
  assert.equal(report.students, 1);
  assert.equal(report.meetings, 1);
  assert.deepEqual(report.attendance, [{ status: recorded, count: 1 }]);
  await b.changeCourseRegistration(user.id, offering.id, "dropped", studentActor);
  assert.equal((await b.getAttendanceRoster(meeting.id)).roster[0].registrationStatus, "dropped");
  assert.ok((await a.saveAttendance(meeting.id, user.id, "absent", updates.find((result) => result.revision).revision, actor)).error);
  assert.equal((await b.getStudentAttendance(user.id))[0].status, recorded);
  await b.changeCourseRegistration(user.id, offering.id, "registered", studentActor);
  await a.setRegistrationOpen(term.id, false, actor);
  assert.ok((await b.changeCourseRegistration(user.id, offering.id, "dropped", studentActor)).error);
  assert.equal((await b.getStudentCourses(user.id))[0].registrationStatus, "registered");
  await a.saveResultDraft(user.id, offering.id, 70, "Verified", actor);
  assert.deepEqual(await b.getStudentPublishedResults(user.id), []);
  const scale = (await a.createGradingScale(program.id, "Example", [{ label: "F", minimumScore: 0, gradePoints: 0 }, { label: "A", minimumScore: 70, gradePoints: 5 }], actor)).scale;
  const row = (await b.listResultRoster()).roster[0];
  const publications = await Promise.all([a.publishResult(user.id, offering.id, row.draftId, scale.id, actor), b.publishResult(user.id, offering.id, row.draftId, scale.id, actor)]);
  assert.equal(publications.filter((result) => result.publication).length, 1);
  assert.equal((await b.getStudentPublishedResults(user.id))[0].publication.grade, "A");
  await a.saveResultDraft(user.id, offering.id, 55, "Correction", actor);
  assert.equal((await b.getStudentPublishedResults(user.id))[0].publication.score, 70);
  const corrected = (await b.listResultRoster()).roster[0];
  await b.publishResult(user.id, offering.id, corrected.draftId, scale.id, actor);
  assert.deepEqual((await a.getResultHistory(user.id, offering.id)).map((item) => item.version), [2, 1]);
  await a.setRegistrationOpen(term.id, true, actor);
  assert.ok((await b.changeCourseRegistration(user.id, offering.id, "dropped", studentActor)).error);
});

test("Firestore student fees are atomic, idempotent and separate from admission invoices", async () => {
  const db = fakeFirestore();
  const a = createFirestoreStore(db);
  const b = createFirestoreStore(db);
  await a.ensureSeed({ defaultAdminUsername: "admin", defaultAdminPassword: "AdminPass123!" });
  const actor = { id: "staff", label: "Staff" };
  const program = (await a.listPrograms())[0];
  const school = (await a.createSchool("Technology", actor)).school;
  const department = (await a.createDepartment(school.id, "Computing", actor)).department;
  await a.assignProgrammeDepartment(program.id, department.id, actor);
  const user = await a.createUser({ surname: "Student", otherNames: "One", email: "fees@example.com", phone: "1", passwordHash: "hash" });
  await a.createOrUpdateApplication({ userId: user.id, programId: program.id, modeOfStudy: "Full-Time", previousInstitution: "School" });
  const admission = await a.createInvoice({ userId: user.id, amount: 20, feeDescription: "Application", currency: "USD" });
  const charge = { userId: user.id, amount: 123.45, feeDescription: "Tuition", currency: "USD", requestId: "fee-request-1" };
  assert.ok((await a.createStudentFee(charge, actor)).error);
  await a.decideAdmission(user.id, "Admitted", "Verified", actor);
  await a.matriculateStudent(user.id, "FEE/1", actor);
  const [first, retry] = await Promise.all([a.createStudentFee(charge, actor), b.createStudentFee(charge, actor)]);
  assert.equal(first.invoice.invoiceNumber, retry.invoice.invoiceNumber);
  assert.ok((await b.createStudentFee({ ...charge, amount: 124 }, actor)).error);
  assert.equal((await b.listStudentFees(user.id)).length, 1);
  assert.equal((await b.listStudentFeesForAdmin())[0].surname, "Student");
  assert.equal((await b.getLatestInvoiceByUserId(user.id)).invoiceNumber, admission.invoiceNumber);
  assert.equal((await b.listAuditLogsByInvoice(first.invoice.invoiceNumber)).filter((log) => log.action === "student_fee_assigned").length, 1);
});

test("production requires an explicit real Firestore configuration", () => {
  assert.throws(() => selectStore({ NODE_ENV: "production" }), /DATA_STORE=firestore/);
  assert.throws(() => selectStore({ NODE_ENV: "production", DATA_STORE: "sqlite" }), /SQLite/);
  assert.throws(() => selectStore({ NODE_ENV: "production", DATA_STORE: "firestore", FIRESTORE_EMULATOR_HOST: "localhost:8080" }), /EMULATOR/);
  assert.throws(() => selectStore({ NODE_ENV: "production", DATA_STORE: "firestore" }), /GOOGLE_CLOUD_PROJECT/);
});

test("Firestore adapters persist workflows and enforce unique email and invoice creation", async () => {
  const db = fakeFirestore();
  const a = createFirestoreStore(db);
  const b = createFirestoreStore(db);
  await Promise.all([a.ensureSeed({ defaultAdminUsername: "admin", defaultAdminPassword: "AdminPass123!" }), b.ensureSeed({ defaultAdminUsername: "admin", defaultAdminPassword: "AdminPass123!" })]);
  assert.equal((await b.listAdminUsers()).length, 1);
  const userInput = { surname: "Jane", otherNames: "Doe", email: "JANE@example.com", phone: "1", passwordHash: "hash" };
  const results = await Promise.allSettled([a.createUser(userInput), b.createUser(userInput)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "DUPLICATE_EMAIL");
  const user = await b.getUserByEmail("jane@example.com");
  assert.equal(await b.getProgramById("invalid/path"), null);
  const program = (await a.listPrograms())[0];
  await a.createOrUpdateApplication({ userId: user.id, programId: program.id, modeOfStudy: "Distance", previousInstitution: "School", notes: "" });
  assert.equal((await b.getDashboardByUserId(user.id)).application.programId, program.id);
  const [invoice, same] = await Promise.all([a.createInvoice({ userId: user.id, amount: 25000, currency: "NGN", feeDescription: "Fee" }), b.createInvoice({ userId: user.id, amount: 25000, currency: "NGN", feeDescription: "Fee" })]);
  assert.equal(invoice.invoiceNumber, same.invoiceNumber);
  assert.equal((await b.getLatestInvoiceByUserId(user.id)).invoiceNumber, invoice.invoiceNumber);
  const created = await a.createAdminUser({ username: "finance", password: "StrongPass1!", role: "finance_admin" });
  assert.equal((await b.getAdminByUsername("finance")).id, created.admin.id);
  assert.equal((await b.resetAdminPassword(created.admin.id, "AnotherPass1!")).admin.mustChangePassword, true);
  const changed = await a.changeOwnAdminPassword({ adminId: created.admin.id, currentPassword: "AnotherPass1!", newPassword: "DifferentPass2!" });
  assert.equal(changed.admin.mustChangePassword, false);
  await b.setAdminActive(created.admin.id, false);
  assert.equal(await a.getAdminByUsername("finance"), null);
});

test("signed transactions and payment audit survive adapters; reconciliation rejects underpayment", async () => {
  const db = fakeFirestore();
  const store = createFirestoreStore(db);
  const reader = createFirestoreStore(db);
  const user = await store.createUser({ surname: "A", otherNames: "B", email: "a@example.com", phone: "1", passwordHash: "x" });
  const invoice = await store.createInvoice({ userId: user.id, amount: 25000, currency: "NGN", feeDescription: "Fee" });
  const processor = createWebhookProcessor({ store, secret: "secret", mockGatewayEnabled: false });
  const deliver = async (amount, reference) => {
    const body = Buffer.from(JSON.stringify({ event: "charge.success", data: { status: "success", reference, amount, currency: "NGN", metadata: { invoiceNumber: invoice.invoiceNumber } } }));
    return processor.processWebhook({ headers: { "x-paystack-signature": hmacSha512Hex("secret", body) }, rawBody: body });
  };
  assert.equal((await deliver(100, "underpaid")).outcome, "validation_failed");
  assert.equal((await reader.getReconciliationReport()).payableMismatch.length, 0);
  await Promise.all([
    deliver(2500000, "paid-1"),
    processor.processVerifiedPaystackTransaction({
      status: "success",
      reference: "paid-2",
      amount: 2500000,
      currency: "NGN",
      metadata: { invoiceNumber: invoice.invoiceNumber },
    }),
  ]);
  assert.equal((await reader.getInvoiceByNumber(invoice.invoiceNumber)).paymentStatus, "Paid");
  const logs = await reader.listAuditLogsByInvoice(invoice.invoiceNumber);
  assert.equal(logs.filter((log) => log.action === "gateway_webhook_success").length, 1);
  assert.equal(logs.filter((log) => log.action === "duplicate_payment_received").length, 1);
  assert.equal((await reader.listPaymentHistoryByInvoice(invoice.invoiceNumber)).length, 3);
});

test("Firestore sessions persist, expire, and cannot be resurrected by touch", async () => {
  const db = fakeFirestore();
  const first = new FirestoreSessionStore(db);
  const second = new FirestoreSessionStore(db);
  const value = { cookie: { expires: new Date(Date.now() + 60000).toISOString() }, user: { id: "applicant" } };
  await sessionCall(first, "set", "secret-session-id", value);
  assert.equal((await sessionCall(second, "get", "secret-session-id")).user.id, "applicant");
  await sessionCall(second, "destroy", "secret-session-id");
  await sessionCall(first, "touch", "secret-session-id", value);
  assert.equal(await sessionCall(second, "get", "secret-session-id"), null);
  await sessionCall(first, "set", "expired", { cookie: { expires: new Date(Date.now() - 1000).toISOString() } });
  assert.equal(await sessionCall(second, "get", "expired"), null);
  const timestampDb = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ expiresAt: { toDate: () => new Date(Date.now() + 60000) }, session: JSON.stringify(value) }) }) }) }) };
  assert.equal((await sessionCall(new FirestoreSessionStore(timestampDb), "get", "sid")).user.id, "applicant");
  const brokenDb = { collection: () => ({ doc: () => ({ get: async () => { throw new Error("unavailable"); } }) }) };
  await assert.rejects(sessionCall(new FirestoreSessionStore(brokenDb), "get", "sid"), /unavailable/);
});
