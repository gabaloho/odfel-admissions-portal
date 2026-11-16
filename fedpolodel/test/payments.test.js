// End-to-end tests for payment authorization, webhooks, checkout and receipts.
// Starts the real server on a temporary database:  npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { inflateSync } = require("node:zlib");
const { Writable } = require("node:stream");
const { once } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { renderAcademicRecord } = require("../src/academic/record");

const WEBHOOK_SECRET = "test-webhook-secret";
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "AdminPass123!";
const APP_JS = path.join(__dirname, "..", "app.js");

let BASE;
let mainServer;
const tmpDirs = [];
const children = new Set();

function tempDir() {
  const dir = path.join(__dirname, `test-data-${crypto.randomUUID()}`);
  fs.mkdirSync(dir);
  tmpDirs.push(dir);
  return dir;
}

let nextPort = 3900 + Math.floor(Math.random() * 400);

/**
 * Starts app.js on its own port and temporary database.
 * `env` entries set to undefined are removed from the child's environment.
 * Resolves { base, child, output } once listening; rejects with the output if
 * the process exits first (used to test startup validation).
 */
function startServer(env = {}) {
  const port = nextPort++;
  const childEnv = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    DATABASE_PATH: path.join(tempDir(), "test.db"),
    BACKEND_ENV_FILE: "none",
    PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ADMIN_USERNAME,
    ADMIN_PASSWORD,
    MOCK_PAYMENTS_ENABLED: "true",
    APPLICATION_FEE_AMOUNT: "20",
    APPLICATION_FEE_CURRENCY: "USD",
    ...env,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }

  const child = spawn(process.execPath, ["--no-warnings", APP_JS], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Server did not start:\n${output}`));
    }, 15000);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes("running on")) {
        clearTimeout(timer);
        resolve({ base: `http://127.0.0.1:${port}`, child, output });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`Server exited (${code}):\n${output}`), { output }));
    });
  });
}

before(async () => {
  mainServer = await startServer();
  BASE = mainServer.base;
});

after(() => {
  for (const child of children) child.kill();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Minimal cookie-jar client so each "browser" keeps its own session.
function client(base) {
  let cookie = "";
  return async function request(method, urlPath, { json, headers = {}, raw, form } = {}) {
    const init = { method, headers: { ...headers }, redirect: "manual" };
    if (cookie) init.headers.cookie = cookie;
    if (json !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(json);
    } else if (form !== undefined) {
      init.headers["content-type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(form).toString();
    } else if (raw !== undefined) {
      init.body = raw;
    }
    const res = await fetch((base || BASE) + urlPath, init);
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const type = res.headers.get("content-type") || "";
    let body;
    if (type.includes("application/json")) body = await res.json();
    else if (type.includes("application/pdf")) body = Buffer.from(await res.arrayBuffer());
    else body = await res.text();
    return { status: res.status, body, headers: res.headers };
  };
}

let studentCounter = 0;
async function newStudentWithInvoice(base) {
  const http = client(base);
  studentCounter += 1;
  const email = `student${studentCounter}-${Date.now()}@example.com`;
  let r = await http("POST", "/api/auth/register", {
    json: { surname: "Test", otherNames: `Student ${studentCounter}`, email, phone: "0800", password: "secret123" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await http("POST", "/api/pre-application", {
    json: { programId: "sample-program", modeOfStudy: "Full-Time", previousInstitution: "Test School" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await http("POST", "/api/invoice/create");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { http, email, invoiceNumber: r.body.invoice.invoiceNumber };
}

async function adminClient() {
  const http = client();
  const r = await http("POST", "/api/admin/login", { json: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return http;
}

async function invoiceStatus(http, invoiceNumber) {
  const r = await http("GET", `/api/invoice/${invoiceNumber}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.invoice.paymentStatus;
}

async function auditsFor(invoiceNumber) {
  const admin = await adminClient();
  const r = await admin("GET", "/api/admin/payments");
  assert.equal(r.status, 200);
  return r.body.audits.filter((a) => a.invoiceNumber === invoiceNumber);
}

function paystackBody(invoiceNumber, { amountMinor = 2000, currency = "USD", status = "success", reference = `PSK-${crypto.randomUUID()}` } = {}) {
  return JSON.stringify({
    event: "charge.success",
    data: { status, reference, amount: amountMinor, currency, metadata: { invoiceNumber } },
  });
}

function sign(body, secret = WEBHOOK_SECRET) {
  return crypto.createHmac("sha512", secret).update(body).digest("hex");
}

const VALID_CARD = { cardholderName: "Test Student", cardNumber: "4242 4242 4242 4242", expiry: "12/40", cvc: "123" };

function pdfPageText(pdf) {
  const contents = pdf.toString("latin1");
  return [...contents.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((match) => {
    const stream = inflateSync(Buffer.from(match[1], "latin1")).toString("latin1");
    return [...stream.matchAll(/<([0-9a-f]+)>/gi)].map((item) => Buffer.from(item[1], "hex").toString("latin1")).join("");
  });
}

// ---------------------------------------------------------------------------

test("unofficial record identifies every page as uncertified", async () => {
  const chunks = [];
  const output = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback(); } });
  const completed = new Promise((resolve, reject) => { output.on("finish", resolve); output.on("error", reject); });
  const results = Array.from({ length: 70 }, (_, index) => ({ sessionName: "Session", termName: "Term", code: `COURSE${index}`, title: "Test course", publication: { score: 60, grade: "C", gradePoints: 3, creditUnits: 2 } }));
  renderAcademicRecord({ institutionName: "School", studentName: "Student", matriculationNumber: "TEST/1", programName: "Programme", results }, output);
  await completed;
  const pdf = Buffer.concat(chunks);
  const pages = pdfPageText(pdf);
  assert.ok(pages.length > 1);
  assert.equal(pages.length, (pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length);
  for (const page of pages) assert.ok(page.includes("UNOFFICIAL ACADEMIC RECORD"));
});

test("existing application invoices survive the student-fee schema migration", async () => {
  const database = path.join(tempDir(), "legacy.db");
  const original = await startServer({ DATABASE_PATH: database });
  let restarted;
  try {
    const student = await newStudentWithInvoice(original.base);
    original.child.kill();
    await once(original.child, "exit");
    const db = new DatabaseSync(database);
    db.exec("DROP TABLE student_fee_requests; ALTER TABLE invoices DROP COLUMN invoice_kind");
    db.close();
    restarted = await startServer({ DATABASE_PATH: database });
    const http = client(restarted.base);
    assert.equal((await http("POST", "/api/auth/login", { json: { email: student.email, password: "secret123" } })).status, 200);
    const dashboard = (await http("GET", "/api/dashboard")).body.snapshot;
    assert.equal(dashboard.latestInvoice.invoiceNumber, student.invoiceNumber);
    assert.equal(dashboard.latestInvoice.invoiceKind, "application");
  } finally {
    if (restarted) restarted.child.kill();
    else if (original.child.exitCode === null) original.child.kill();
  }
});

test("student fees are authorized, idempotent, isolated and paid only for the full verified amount", async () => {
  const server = await startServer();
  try {
    const first = await newStudentWithInvoice(server.base);
    const second = await newStudentWithInvoice(server.base);
    const firstId = (await first.http("GET", "/api/dashboard")).body.snapshot.user.id;
    const secondId = (await second.http("GET", "/api/dashboard")).body.snapshot.user.id;
    const admin = client(server.base);
    await admin("POST", "/api/admin/login", { json: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
    const school = (await admin("POST", "/api/admin/sis/schools", { json: { name: "School" } })).body.school;
    const department = (await admin("POST", "/api/admin/sis/departments", { json: { schoolId: school.id, name: "Computing" } })).body.department;
    await admin("POST", "/api/admin/sis/programme-department", { json: { programId: "sample-program", departmentId: department.id } });
    const charge = { userId: firstId, requestId: crypto.randomUUID(), feeDescription: "Tuition", amount: "123.45", currency: "USD" };
    assert.equal((await admin("POST", "/api/admin/student-fees", { json: charge })).status, 409);
    assert.equal((await first.http("GET", "/api/student/fees")).status, 403);
    for (const [id, number] of [[firstId, "FEES/1"], [secondId, "FEES/2"]]) {
      await admin("POST", `/api/admin/sis/admissions/${id}/decision`, { json: { decision: "Admitted", note: "Approved" } });
      await admin("POST", `/api/admin/sis/admissions/${id}/matriculate`, { json: { matriculationNumber: number } });
    }
    assert.equal((await first.http("POST", "/api/admin/student-fees", { json: charge })).status, 401);
    for (const amount of ["0", "-1", "1.001", "1e2", 12]) {
      assert.equal((await admin("POST", "/api/admin/student-fees", { json: { ...charge, amount } })).status, 400);
    }
    const [created, retry] = await Promise.all([admin("POST", "/api/admin/student-fees", { json: charge }), admin("POST", "/api/admin/student-fees", { json: charge })]);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const invoice = created.body.invoice;
    assert.equal(retry.body.invoice.invoiceNumber, invoice.invoiceNumber);
    assert.equal((await admin("POST", "/api/admin/student-fees", { json: { ...charge, amount: "125.00" } })).status, 409);
    assert.equal((await first.http("GET", "/api/student/fees")).body.invoices.length, 1);
    assert.equal((await second.http("GET", "/api/student/fees")).body.invoices.length, 0);
    assert.equal((await second.http("GET", `/api/invoice/${invoice.invoiceNumber}`)).status, 404);
    assert.equal((await first.http("GET", "/api/dashboard")).body.snapshot.latestInvoice.invoiceNumber, first.invoiceNumber);
    assert.equal((await first.http("POST", "/api/invoice/create")).body.invoice.invoiceNumber, first.invoiceNumber);
    assert.equal((await first.http("GET", `/api/invoice/${invoice.invoiceNumber}`)).body.document.title, "Student Fee Invoice");
    const pdf = await first.http("GET", `/api/invoice/${invoice.invoiceNumber}/pdf`);
    assert.ok(pdfPageText(pdf.body).join("").includes("Student Fee Invoice".toUpperCase()));
    assert.equal((await first.http("POST", `/api/invoice/${invoice.invoiceNumber}/pay`)).status, 403);
    for (const amountMinor of [12344, 12345]) {
      const body = paystackBody(invoice.invoiceNumber, { amountMinor });
      await client(server.base)("POST", "/webhooks/payments", { raw: body, headers: { "content-type": "application/json", "x-paystack-signature": sign(body) } });
      assert.equal(await invoiceStatus(first.http, invoice.invoiceNumber), amountMinor === 12345 ? "Paid" : "Unpaid");
    }
    assert.equal(await invoiceStatus(first.http, first.invoiceNumber), "Unpaid");
    const admissions = (await admin("GET", "/api/admin/sis/admissions")).body.applications;
    assert.equal(admissions.find((application) => application.userId === firstId).paymentStatus, "Unpaid");
    const logs = (await admin("GET", "/api/admin/payments")).body.audits.filter((entry) => entry.invoiceNumber === invoice.invoiceNumber && entry.action === "student_fee_assigned");
    assert.equal(logs.length, 1);
    for (const role of ["auditor", "finance_admin"]) {
      await admin("POST", "/api/admin/users", { json: { username: `fee-${role}`, password: "TempPass123!", role } });
      const staff = client(server.base);
      await staff("POST", "/api/admin/login", { json: { username: `fee-${role}`, password: "TempPass123!" } });
      await staff("POST", "/api/admin/change-password", { json: { currentPassword: "TempPass123!", newPassword: "FinalPass123!", confirmPassword: "FinalPass123!" } });
      assert.equal((await staff("GET", "/api/admin/student-fees")).status, role === "auditor" ? 403 : 200);
      assert.equal((await staff("POST", "/api/admin/student-fees", { json: { ...charge, requestId: crypto.randomUUID() } })).status, role === "auditor" ? 403 : 200);
    }
  } finally {
    server.child.kill();
  }
});

test("course registration is student-owned, programme-specific, and limited to open terms", async () => {
  const server = await startServer();
  try {
    const first = await newStudentWithInvoice(server.base);
    const second = await newStudentWithInvoice(server.base);
    const firstId = (await first.http("GET", "/api/dashboard")).body.snapshot.user.id;
    const secondId = (await second.http("GET", "/api/dashboard")).body.snapshot.user.id;
    const admin = client(server.base);
    await admin("POST", "/api/admin/login", { json: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
    assert.equal((await second.http("GET", "/api/student/courses")).status, 403);
    assert.equal((await second.http("GET", "/api/student/academic-record.pdf")).status, 403);
    assert.equal((await client(server.base)("GET", "/api/student/academic-record.pdf")).status, 401);
    assert.equal((await first.http("POST", "/api/admin/sis/terms", { json: { sessionName: "2026/2027", termName: "First" } })).status, 401);
    const school = (await admin("POST", "/api/admin/sis/schools", { json: { name: "School" } })).body.school;
    const department = (await admin("POST", "/api/admin/sis/departments", { json: { schoolId: school.id, name: "Computing" } })).body.department;
    await admin("POST", "/api/admin/sis/programme-department", { json: { programId: "sample-program", departmentId: department.id } });
    await admin("POST", `/api/admin/sis/admissions/${firstId}/decision`, { json: { decision: "Admitted", note: "Approved" } });
    await admin("POST", `/api/admin/sis/admissions/${firstId}/matriculate`, { json: { matriculationNumber: "COURSE/1" } });
    const term = (await admin("POST", "/api/admin/sis/terms", { json: { sessionName: "2026/2027", termName: "First" } })).body.term;
    assert.ok(term?.id);
    assert.equal((await admin("POST", "/api/admin/sis/terms", { json: { sessionName: "2026/2027", termName: "first" } })).status, 409);
    assert.equal((await admin("POST", "/api/admin/sis/courses", { json: { programId: "sample-program", code: "CSC101", title: "Computing", creditUnits: 0 } })).status, 400);
    const course = (await admin("POST", "/api/admin/sis/courses", { json: { programId: "sample-program", code: "csc101", title: "Computing", creditUnits: 3 } })).body.course;
    assert.equal(course.code, "CSC101");
    const offering = (await admin("POST", "/api/admin/sis/offerings", { json: { termId: term.id, courseId: course.id } })).body.offering;
    const config = await admin("POST", "/api/admin/institution", { json: {
      institutionName: "Example", language: "en", currency: "USD", feeAmount: 20, feeDescription: "Fee",
      modesOfStudy: ["Full-Time"], programmeNames: ["Sample Program (configure before launch)", "Other Programme"],
    } });
    assert.equal(config.status, 200);
    const otherProgram = config.body.settings.programmeIds[1];
    const otherCourse = (await admin("POST", "/api/admin/sis/courses", { json: { programId: otherProgram, code: "OTHER1", title: "Other", creditUnits: 2 } })).body.course;
    const otherOffering = (await admin("POST", "/api/admin/sis/offerings", { json: { termId: term.id, courseId: otherCourse.id } })).body.offering;
    assert.equal((await admin("POST", "/api/admin/sis/offerings", { json: { termId: term.id, courseId: course.id } })).status, 409);
    const change = (http, status) => http("POST", `/api/student/courses/${offering.id}`, { json: { status } });
    assert.equal((await change(first.http, "registered")).status, 409);
    assert.equal((await admin("POST", `/api/admin/sis/terms/${term.id}/registration`, { json: { open: true } })).status, 200);
    assert.equal((await first.http("GET", "/api/student/courses")).body.courses.length, 1);
    assert.equal((await first.http("POST", `/api/student/courses/${otherOffering.id}`, { json: { status: "registered" } })).status, 409);
    assert.equal((await change(second.http, "registered")).status, 409);
    assert.equal((await change(first.http, "registered")).status, 200);
    assert.equal((await change(first.http, "registered")).status, 409);
    const meetingInput = { offeringId: offering.id, meetingDate: "2026-03-10", label: "Lecture 1" };
    assert.equal((await admin("POST", "/api/admin/sis/attendance/meetings", { json: { ...meetingInput, meetingDate: "2026-02-30" } })).status, 400);
    const meeting = (await admin("POST", "/api/admin/sis/attendance/meetings", { json: meetingInput })).body.meeting;
    assert.ok(meeting?.id);
    assert.equal((await admin("POST", "/api/admin/sis/attendance/meetings", { json: { ...meetingInput, label: "lecture 1" } })).status, 409);
    assert.equal((await first.http("GET", "/api/admin/sis/attendance")).status, 401);
    assert.equal((await second.http("GET", "/api/student/attendance")).status, 403);
    const mark = (userId, status, expectedRevision) => admin("POST", `/api/admin/sis/attendance/meetings/${meeting.id}`, { json: { userId, status, expectedRevision } });
    assert.equal((await mark(secondId, "present", null)).status, 409);
    const initialMark = await mark(firstId, "present", null);
    assert.equal(initialMark.status, 200);
    const concurrent = await Promise.all([mark(firstId, "late", initialMark.body.revision), mark(firstId, "absent", initialMark.body.revision)]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
    const savedAttendance = concurrent.find((r) => r.status === 200).body.status;
    assert.equal((await first.http("GET", "/api/student/attendance")).body.records[0].status, savedAttendance);
    const report = (await admin("GET", "/api/admin/sis/report")).body.report;
    assert.equal(report.students, 1);
    assert.equal(report.meetings, 1);
    assert.deepEqual(report.attendance, [{ status: savedAttendance, count: 1 }]);
    assert.equal((await change(first.http, "dropped")).status, 200);
    const droppedRoster = (await admin("GET", `/api/admin/sis/attendance/meetings/${meeting.id}`)).body.roster;
    assert.equal(droppedRoster[0].registrationStatus, "dropped");
    assert.equal((await mark(firstId, "excused", concurrent.find((r) => r.status === 200).body.revision)).status, 409);
    assert.equal((await first.http("GET", "/api/student/attendance")).body.records[0].status, savedAttendance);
    assert.equal((await change(first.http, "registered")).status, 200);
    const resultDraft = { userId: firstId, offeringId: offering.id, score: 75.25, reason: "Initial review" };
    assert.equal((await admin("POST", "/api/admin/sis/results/draft", { json: resultDraft })).status, 409);
    await admin("POST", `/api/admin/sis/terms/${term.id}/registration`, { json: { open: false } });
    assert.equal((await change(first.http, "dropped")).status, 409);
    const saved = (await first.http("GET", "/api/student/courses")).body.courses[0];
    assert.equal(saved.registrationStatus, "registered");
    assert.equal(saved.registrationOpen, false);
    const logs = (await admin("GET", "/api/admin/payments")).body.audits;
    assert.equal(logs.filter((entry) => entry.action === "course_registration_changed").length, 3);
    assert.equal((await admin("POST", "/api/admin/sis/grading-scales", { json: { programId: "sample-program", name: "Invalid", bands: [{ label: "A", minimumScore: 50, gradePoints: 5 }] } })).status, 400);
    assert.equal((await admin("POST", "/api/admin/sis/results/draft", { json: { ...resultDraft, score: 75.001 } })).status, 400);
    assert.equal((await admin("POST", "/api/admin/sis/results/draft", { json: resultDraft })).status, 200);
    assert.deepEqual((await first.http("GET", "/api/student/results")).body.results, []);
    let row = (await admin("GET", "/api/admin/sis/results")).body.roster.find((entry) => entry.userId === firstId);
    assert.equal(row.draftPreview, null);
    assert.equal((await admin("POST", "/api/admin/sis/results/publish", { json: { userId: firstId, offeringId: offering.id, draftId: row.draftId, scaleId: "missing" } })).status, 409);
    const scale = (await admin("POST", "/api/admin/sis/grading-scales", { json: { programId: "sample-program", name: "Example scale", bands: [{ label: "Fail", minimumScore: 0, gradePoints: 0 }, { label: "A", minimumScore: 70, gradePoints: 5 }] } })).body.scale;
    row = (await admin("GET", "/api/admin/sis/results")).body.roster.find((entry) => entry.userId === firstId);
    assert.equal(row.draftPreview.label, "A");
    const publish = { userId: firstId, offeringId: offering.id, draftId: row.draftId, scaleId: scale.id };
    assert.equal((await first.http("POST", "/api/admin/sis/results/publish", { json: publish })).status, 401);
    assert.equal((await admin("POST", "/api/admin/sis/results/publish", { json: publish })).status, 200);
    let studentResult = (await first.http("GET", "/api/student/results")).body.results[0].publication;
    assert.equal(studentResult.score, 75.25);
    assert.equal(studentResult.grade, "A");
    assert.equal(studentResult.reason, undefined);
    const record = await first.http("GET", "/api/student/academic-record.pdf");
    assert.equal(record.status, 200);
    assert.equal(record.body.subarray(0, 5).toString(), "%PDF-");
    assert.equal(record.headers.get("cache-control"), "private, no-store");
    const recordText = pdfPageText(record.body).join("");
    assert.ok(recordText.includes("UNOFFICIAL ACADEMIC RECORD"));
    assert.ok(recordText.includes("CSC101"));
    assert.ok(recordText.includes("75.25"));
    assert.ok(!recordText.includes("Initial review"));
    await admin("POST", `/api/admin/sis/admissions/${secondId}/decision`, { json: { decision: "Admitted", note: "Approved" } });
    await admin("POST", `/api/admin/sis/admissions/${secondId}/matriculate`, { json: { matriculationNumber: "COURSE/2" } });
    assert.deepEqual((await second.http("GET", "/api/student/results")).body.results, []);
    assert.equal((await second.http("GET", `/api/admin/sis/results/${firstId}/${offering.id}/history`)).status, 401);
    assert.equal((await admin("POST", "/api/admin/sis/results/draft", { json: { ...resultDraft, score: 65, reason: "Correction" } })).status, 200);
    assert.equal((await first.http("GET", "/api/student/results")).body.results[0].publication.score, 75.25);
    row = (await admin("GET", "/api/admin/sis/results")).body.roster.find((entry) => entry.userId === firstId);
    const correctedDraftId = row.draftId;
    const newScale = (await admin("POST", "/api/admin/sis/grading-scales", { json: { programId: "sample-program", name: "Updated example", bands: [{ label: "Fail", minimumScore: 0, gradePoints: 0 }, { label: "C", minimumScore: 60, gradePoints: 3 }] } })).body.scale;
    assert.equal((await admin("POST", "/api/admin/sis/results/publish", { json: { ...publish, draftId: correctedDraftId } })).status, 409);
    assert.equal((await admin("POST", "/api/admin/sis/results/draft", { json: { ...resultDraft, score: 65, reason: "Confirmed correction" } })).status, 200);
    assert.equal((await admin("POST", "/api/admin/sis/results/publish", { json: { ...publish, draftId: correctedDraftId, scaleId: newScale.id } })).status, 409);
    row = (await admin("GET", "/api/admin/sis/results")).body.roster.find((entry) => entry.userId === firstId);
    assert.equal((await admin("POST", "/api/admin/sis/results/publish", { json: { ...publish, draftId: row.draftId, scaleId: newScale.id } })).status, 200);
    studentResult = (await first.http("GET", "/api/student/results")).body.results[0].publication;
    assert.equal(studentResult.score, 65);
    assert.equal(studentResult.grade, "C");
    assert.equal(studentResult.version, 2);
    const history = (await admin("GET", `/api/admin/sis/results/${firstId}/${offering.id}/history`)).body.publications;
    assert.deepEqual(history.map((publication) => publication.scaleId), [newScale.id, scale.id]);
    assert.equal(history[1].score, 75.25);
    assert.equal(history[1].scale.bands[1].label, "A");
    await admin("POST", `/api/admin/sis/terms/${term.id}/registration`, { json: { open: true } });
    assert.equal((await change(first.http, "dropped")).status, 409);
  } finally {
    server.child.kill();
  }
});

test("SIS decisions and matriculation require authorization and preserve academic history", async () => {
  const server = await startServer();
  try {
    const first = await newStudentWithInvoice(server.base);
    const second = await newStudentWithInvoice(server.base);
    const firstId = (await first.http("GET", "/api/dashboard")).body.snapshot.user.id;
    const secondId = (await second.http("GET", "/api/dashboard")).body.snapshot.user.id;
    const anon = client(server.base);
    const admin = client(server.base);
    assert.equal((await anon("GET", "/api/admin/sis/students")).status, 401);
    assert.equal((await first.http("GET", "/api/admin/sis/admissions")).status, 401);
    await admin("POST", "/api/admin/login", { json: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
    const admissions = (await admin("GET", "/api/admin/sis/admissions")).body.applications;
    assert.equal(admissions.find((entry) => entry.userId === firstId).previousInstitution, "Test School");
    assert.equal(admissions.find((entry) => entry.userId === firstId).paymentStatus, "Unpaid");
    const school = (await admin("POST", "/api/admin/sis/schools", { json: { name: "School of Technology" } })).body.school;
    assert.ok(school?.id);
    assert.equal((await admin("POST", "/api/admin/sis/schools", { json: { name: "school of technology" } })).status, 409);
    const department = (await admin("POST", "/api/admin/sis/departments", { json: { name: "Computing", schoolId: school.id } })).body.department;
    assert.ok(department?.id);
    assert.equal((await admin("POST", "/api/admin/sis/programme-department", { json: { programId: "sample-program", departmentId: department.id } })).status, 200);
    assert.equal((await admin("POST", `/api/admin/sis/admissions/${firstId}/matriculate`, { json: { matriculationNumber: "POLY/001" } })).status, 409);
    assert.equal((await admin("POST", `/api/admin/sis/admissions/${firstId}/decision`, { json: { decision: "Admitted", note: "" } })).status, 400);
    assert.equal((await admin("POST", `/api/admin/sis/admissions/${firstId}/decision`, { json: { decision: "Admitted", note: "Requirements verified" } })).status, 200);
    assert.equal((await first.http("POST", "/api/pre-application", { json: { programId: "sample-program", modeOfStudy: "Full-Time", previousInstitution: "Changed" } })).status, 409);
    assert.equal((await admin("POST", `/api/admin/sis/admissions/${firstId}/matriculate`, { json: { matriculationNumber: "poly/001" } })).status, 200);
    const snapshot = (await first.http("GET", "/api/dashboard")).body.snapshot;
    assert.equal(snapshot.application.status, "Matriculated");
    assert.equal(snapshot.student.matriculationNumber, "POLY/001");
    assert.equal((await admin("POST", `/api/admin/sis/admissions/${firstId}/decision`, { json: { decision: "Rejected", note: "Changed" } })).status, 409);
    assert.equal((await admin("POST", `/api/admin/sis/admissions/${secondId}/decision`, { json: { decision: "Admitted", note: "Verified" } })).status, 200);
    assert.equal((await admin("POST", `/api/admin/sis/admissions/${secondId}/matriculate`, { json: { matriculationNumber: "poly/001" } })).status, 409);
    const other = (await admin("POST", "/api/admin/sis/departments", { json: { name: "Engineering", schoolId: school.id } })).body.department;
    await admin("POST", "/api/admin/sis/programme-department", { json: { programId: "sample-program", departmentId: other.id } });
    const students = (await admin("GET", "/api/admin/sis/students")).body.students;
    assert.equal(students.length, 1);
    assert.equal(students[0].departmentName, "Computing");
    const audits = (await admin("GET", "/api/admin/payments")).body.audits;
    assert.ok(audits.some((log) => log.action === "admission_decision"));
    assert.ok(audits.some((log) => log.action === "student_matriculated"));
    assert.equal((await admin("POST", "/api/admin/users", { json: { username: "sis-auditor", password: "TempPass123!", role: "auditor" } })).status, 200);
    const auditor = client(server.base);
    await auditor("POST", "/api/admin/login", { json: { username: "sis-auditor", password: "TempPass123!" } });
    await auditor("POST", "/api/admin/change-password", { json: { currentPassword: "TempPass123!", newPassword: "FinalPass123!", confirmPassword: "FinalPass123!" } });
    assert.equal((await auditor("GET", "/api/admin/sis/students")).status, 403);
    assert.equal((await auditor("POST", "/api/admin/sis/schools", { json: { name: "Unauthorized" } })).status, 403);
    assert.equal((await auditor("GET", "/api/admin/sis/results")).status, 403);
    assert.equal((await auditor("GET", "/api/admin/sis/attendance")).status, 403);
    assert.equal((await auditor("GET", "/api/admin/sis/report")).status, 403);
  } finally {
    server.child.kill();
  }
});

test("institution setup is restricted, persists programmes and fees, and preserves existing invoices", async () => {
  const server = await startServer();
  try {
    const old = await newStudentWithInvoice(server.base);
    const anonymous = client(server.base);
    const admin = client(server.base);
    const settings = {
      institutionName: "Example Polytechnic", institutionWebsite: "https://example.com",
      institutionLogo: "", institutionEmail: "office@example.com", institutionPhone: "",
      institutionAddress: "", language: "en", currency: "USD", feeAmount: 0.29,
      feeDescription: "Admissions", modesOfStudy: ["Evening"], programmeNames: ["Computer Science", "Custom Programme"],
    };
    assert.equal((await anonymous("GET", "/api/institution")).body.configured, false);
    assert.equal((await anonymous("POST", "/api/admin/institution", { json: settings })).status, 401);
    assert.equal((await admin("POST", "/api/admin/login", { json: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } })).status, 200);
    for (const invalid of [
      { ...settings, feeAmount: 1.001 },
      { ...settings, institutionWebsite: "javascript:alert(1)" },
      { ...settings, institutionLogo: "/\\evil.example/logo.png" },
      { ...settings, language: "fr" },
      { ...settings, programmeNames: ["Computer Science", "computer science"] },
    ]) {
      assert.equal((await admin("POST", "/api/admin/institution", { json: invalid })).status, 400);
    }
    settings.institutionLogo = "/logo.png";
    let response = await admin("POST", "/api/admin/institution", { json: settings });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const selected = response.body.settings.programmeIds;
    assert.equal(selected.length, 2);
    assert.equal((await anonymous("GET", "/api/institution")).body.settings.institutionName, "Example Polytechnic");
    assert.equal((await anonymous("GET", "/api/institution")).body.settings.institutionLogo, "/logo.png");
    const oldInvoice = await old.http("GET", `/api/invoice/${old.invoiceNumber}`);
    assert.equal(oldInvoice.body.invoice.amount, 20);
    assert.equal(oldInvoice.body.program.id, "sample-program");

    const student = client(server.base);
    assert.equal((await student("POST", "/api/auth/register", { json: { surname: "New", otherNames: "Applicant", email: "new@example.com", phone: "1", password: "secret123" } })).status, 200);
    response = await student("GET", "/api/programs");
    assert.deepEqual(response.body.programs.map((p) => p.name).sort(), settings.programmeNames.slice().sort());
    const application = { programId: selected[0], modeOfStudy: "Evening", previousInstitution: "School" };
    assert.equal((await student("POST", "/api/pre-application", { json: { ...application, programId: "sample-program" } })).status, 400);
    assert.equal((await student("POST", "/api/pre-application", { json: { ...application, modeOfStudy: "Full-Time" } })).status, 400);
    assert.equal((await student("POST", "/api/pre-application", { json: application })).status, 200);
    response = await student("POST", "/api/invoice/create");
    assert.equal(response.body.invoice.amount, 0.29);
    assert.equal(response.body.invoice.feeDescription, "Admissions");

    response = await admin("POST", "/api/admin/institution", { json: { ...settings, programmeNames: ["Custom Programme"], feeAmount: 30 } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal((await student("GET", "/api/programs")).body.programs.length, 1);
    assert.equal((await student("POST", "/api/invoice/create")).body.invoice.amount, 0.29);
    assert.equal((await old.http("GET", `/api/invoice/${old.invoiceNumber}`)).body.invoice.amount, 20);
    assert.ok((await admin("GET", "/api/admin/payments")).body.audits.some((log) => log.action === "institution_settings_updated"));

    assert.equal((await admin("POST", "/api/admin/users", { json: { username: "auditor-setup", password: "TempPass123!", role: "auditor" } })).status, 200);
    const auditor = client(server.base);
    await auditor("POST", "/api/admin/login", { json: { username: "auditor-setup", password: "TempPass123!" } });
    await auditor("POST", "/api/admin/change-password", { json: { currentPassword: "TempPass123!", newPassword: "FinalPass123!", confirmPassword: "FinalPass123!" } });
    assert.equal((await auditor("GET", "/api/admin/institution")).status, 403);
    assert.equal((await auditor("POST", "/api/admin/institution", { json: settings })).status, 403);
  } finally {
    server.child.kill();
  }
});

test("configured application fee is a flat USD 20", async () => {
  const { http, invoiceNumber } = await newStudentWithInvoice();
  const r = await http("GET", `/api/invoice/${invoiceNumber}`);
  assert.equal(r.body.invoice.amount, 20);
  assert.equal(r.body.invoice.currency, "USD");
  assert.equal(r.body.document.kind, "invoice");
  assert.equal(r.body.checkout.enabled, true);
  assert.equal(r.body.user.passwordHash, undefined, "password hash must not be sent to the browser");
});

test("default application fee is NGN 25,000", async () => {
  const server = await startServer({ APPLICATION_FEE_AMOUNT: undefined, APPLICATION_FEE_CURRENCY: undefined });
  try {
    const { http, invoiceNumber } = await newStudentWithInvoice(server.base);
    const r = await http("GET", `/api/invoice/${invoiceNumber}`);
    assert.equal(r.body.invoice.amount, 25000);
    assert.equal(r.body.invoice.currency, "NGN");
  } finally {
    server.child.kill();
  }
});

test("a student cannot mark their own invoice paid (API or form endpoint)", async () => {
  const { http, invoiceNumber } = await newStudentWithInvoice();

  let r = await http("POST", `/api/invoice/${invoiceNumber}/pay`);
  assert.equal(r.status, 403);
  r = await http("POST", `/invoice/${invoiceNumber}/pay`);
  assert.equal(r.status, 403);

  assert.equal(await invoiceStatus(http, invoiceNumber), "Unpaid");
});

test("a student session cannot use admin payment endpoints", async () => {
  const { http, invoiceNumber } = await newStudentWithInvoice();

  let r = await http("POST", `/api/admin/invoices/${invoiceNumber}/override`, { json: { status: "Paid", note: "self" } });
  assert.equal(r.status, 401);
  r = await http("POST", `/admin/invoices/${invoiceNumber}/override`, { form: { status: "Paid", note: "self" } });
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /\/admin\/login$/);
  r = await http("POST", "/api/admin/reconcile");
  assert.equal(r.status, 401);
  r = await http("GET", "/api/admin/payments");
  assert.equal(r.status, 401);

  assert.equal(await invoiceStatus(http, invoiceNumber), "Unpaid");
});

test("a session holds one identity: admin login drops the student, student login drops the admin", async () => {
  const { http } = await newStudentWithInvoice();
  let r = await http("POST", "/api/admin/login", { json: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
  assert.equal(r.status, 200);
  r = await http("GET", "/api/auth/session");
  assert.equal(r.body.user, null);
  assert.ok(r.body.admin);

  const email = `switch-${Date.now()}@example.com`;
  await http("POST", "/api/auth/register", {
    json: { surname: "S", otherNames: "W", email, phone: "1", password: "secret123" },
  });
  r = await http("GET", "/api/auth/session");
  assert.equal(r.body.admin, null);
  r = await http("GET", "/api/admin/payments");
  assert.equal(r.status, 401);
});

test("webhook with a wrong or missing signature returns 401 and changes nothing", async () => {
  const { http, invoiceNumber } = await newStudentWithInvoice();
  const body = paystackBody(invoiceNumber);

  const anon = client();
  let r = await anon("POST", "/webhooks/payments", {
    raw: body,
    headers: { "content-type": "application/json", "x-paystack-signature": sign(body, "wrong-secret") },
  });
  assert.equal(r.status, 401);

  r = await anon("POST", "/webhooks/payments", { raw: body, headers: { "content-type": "application/json" } });
  assert.equal(r.status, 401);

  r = await anon("POST", "/webhooks/payments", {
    raw: body,
    headers: { "content-type": "application/json", "x-mock-gateway-signature": "00ff" },
  });
  assert.equal(r.status, 401);

  // A signature for a different body (tampered payload) must also fail.
  r = await anon("POST", "/webhooks/payments", {
    raw: body,
    headers: { "content-type": "application/json", "x-paystack-signature": sign(paystackBody(invoiceNumber, { amountMinor: 1 })) },
  });
  assert.equal(r.status, 401);

  assert.equal(await invoiceStatus(http, invoiceNumber), "Unpaid");
});

test("a correctly signed success webhook marks the invoice paid and is audited as the webhook", async () => {
  const { http, invoiceNumber } = await newStudentWithInvoice();
  const reference = `PSK-${crypto.randomUUID()}`;
  const body = paystackBody(invoiceNumber, { reference });

  const anon = client();
  let r = await anon("POST", "/webhooks/payments", {
    raw: body,
    headers: { "content-type": "application/json", "x-paystack-signature": sign(body) },
  });
  assert.equal(r.status, 200, r.body);

  r = await http("GET", `/api/invoice/${invoiceNumber}`);
  assert.equal(r.body.invoice.paymentStatus, "Paid");
  assert.equal(r.body.invoice.paymentReference, reference);
  assert.equal(r.body.document.kind, "receipt");
  assert.equal(r.body.checkout.enabled, false);

  // Replayed delivery is idempotent.
  r = await anon("POST", "/webhooks/payments", {
    raw: body,
    headers: { "content-type": "application/json", "x-paystack-signature": sign(body) },
  });
  assert.equal(r.status, 200);

  const audits = await auditsFor(invoiceNumber);
  const paid = audits.filter((a) => a.afterStatus === "Paid" && a.beforeStatus !== "Paid");
  assert.equal(paid.length, 1, "exactly one transition to Paid");
  assert.equal(paid[0].actorType, "webhook");
  assert.equal(paid[0].actorId, "paystack");
  assert.match(paid[0].actorLabel, /webhook.*paystack.*verified/i);
});

test("concurrent payment webhooks cannot replace the first successful reference", async () => {
  const { http, invoiceNumber } = await newStudentWithInvoice();
  const anon = client();
  const firstBody = paystackBody(invoiceNumber, { reference: "PSK-first-reference" });
  const secondBody = paystackBody(invoiceNumber, { reference: "PSK-second-reference" });
  const [first, second] = await Promise.all([
    anon("POST", "/webhooks/payments", {
      raw: firstBody,
      headers: { "content-type": "application/json", "x-paystack-signature": sign(firstBody) },
    }),
    anon("POST", "/webhooks/payments", {
      raw: secondBody,
      headers: { "content-type": "application/json", "x-paystack-signature": sign(secondBody) },
    }),
  ]);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const invoiceResponse = await http("GET", `/api/invoice/${invoiceNumber}`);
  assert.equal(invoiceResponse.body.invoice.paymentStatus, "Paid");
  assert.ok(["PSK-first-reference", "PSK-second-reference"].includes(invoiceResponse.body.invoice.paymentReference));
  const audits = await auditsFor(invoiceNumber);
  assert.equal(audits.filter((entry) => entry.action === "gateway_webhook_success").length, 1);
  assert.equal(audits.filter((entry) => entry.action === "duplicate_payment_received").length, 1);
});

test("a signed webhook with the wrong amount or currency does not mark the invoice paid", async () => {
  const { http, invoiceNumber } = await newStudentWithInvoice();
  const anon = client();

  for (const opts of [{ amountMinor: 100 }, { currency: "NGN" }]) {
    const body = paystackBody(invoiceNumber, opts);
    const r = await anon("POST", "/webhooks/payments", {
      raw: body,
      headers: { "content-type": "application/json", "x-paystack-signature": sign(body) },
    });
    assert.equal(r.status, 202, r.body);
  }

  assert.equal(await invoiceStatus(http, invoiceNumber), "Unpaid");
  const audits = await auditsFor(invoiceNumber);
  assert.equal(audits.filter((a) => a.action === "gateway_webhook_rejected").length, 2);
});

test("student card checkout: invalid and declined cards leave the invoice unpaid", async () => {
  const { http, invoiceNumber } = await newStudentWithInvoice();

  let r = await http("POST", `/api/invoice/${invoiceNumber}/checkout`, { json: { ...VALID_CARD, cardNumber: "4111 1111 1111 1111" } });
  assert.equal(r.status, 400);
  r = await http("POST", `/api/invoice/${invoiceNumber}/checkout`, { json: { ...VALID_CARD, expiry: "01/20" } });
  assert.equal(r.status, 400);
  r = await http("POST", `/api/invoice/${invoiceNumber}/checkout`, { json: { ...VALID_CARD, cardNumber: "4000 0000 0000 0002" } });
  assert.equal(r.status, 402);

  assert.equal(await invoiceStatus(http, invoiceNumber), "Unpaid");
});

test("student card checkout with the dummy card pays via the verified gateway webhook", async () => {
  const { http, email, invoiceNumber } = await newStudentWithInvoice();

  // A client-supplied amount/status is ignored; the stored invoice amount is charged.
  let r = await http("POST", `/api/invoice/${invoiceNumber}/checkout`, {
    json: { ...VALID_CARD, amount: 0.01, status: "Paid" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.invoice.paymentStatus, "Paid");
  assert.equal(r.body.document.kind, "receipt");
  assert.match(r.body.document.receiptNumber, /^RCT-/);
  assert.equal(r.body.document.payment.method, "Visa ending 4242");
  assert.equal(r.body.document.payment.confirmedBy, "Payment gateway (verified)");

  r = await http("POST", `/api/invoice/${invoiceNumber}/checkout`, { json: VALID_CARD });
  assert.equal(r.status, 409, "cannot pay twice");

  const admin = await adminClient();
  r = await admin("GET", "/api/admin/payments");
  const tx = r.body.transactions.find((t) => t.invoiceNumber === invoiceNumber && t.gatewayStatus === "success");
  assert.equal(tx.amount, 20);
  assert.equal(tx.signatureValid, true);
  assert.ok(!tx.payloadJson.includes("4242424242424242"), "full card number must never be stored");

  const audits = r.body.audits.filter((a) => a.invoiceNumber === invoiceNumber);
  const initiated = audits.find((a) => a.action === "checkout_initiated");
  assert.equal(initiated.actorType, "user");
  assert.equal(initiated.actorLabel, `Applicant: ${email}`);
  assert.equal(initiated.afterStatus, "Unpaid", "the applicant's action does not change the status");
  const paid = audits.find((a) => a.action === "gateway_webhook_success");
  assert.equal(paid.actorType, "webhook");
  assert.equal(paid.actorId, "mock");
});

test("invoice and receipt download as PDF, only for the owner", async () => {
  const { http, invoiceNumber } = await newStudentWithInvoice();

  let r = await http("GET", `/api/invoice/${invoiceNumber}/pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.match(r.headers.get("content-disposition"), new RegExp(`invoice-${invoiceNumber}\\.pdf`));
  assert.equal(r.body.subarray(0, 5).toString(), "%PDF-");

  await http("POST", `/api/invoice/${invoiceNumber}/checkout`, { json: VALID_CARD });
  r = await http("GET", `/api/invoice/${invoiceNumber}/pdf`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /payment-receipt-RCT-.*\.pdf/);
  assert.equal(r.body.subarray(0, 5).toString(), "%PDF-");

  const other = await newStudentWithInvoice();
  r = await other.http("GET", `/api/invoice/${invoiceNumber}/pdf`);
  assert.equal(r.status, 404);
  r = await client()("GET", `/api/invoice/${invoiceNumber}/pdf`);
  assert.equal(r.status, 401);
});

test("an admin can manually approve a payment; the audit trail records which admin", async () => {
  const { http, invoiceNumber } = await newStudentWithInvoice();
  const admin = await adminClient();

  let r = await admin("POST", `/api/admin/invoices/${invoiceNumber}/override`, { json: { status: "Paid" } });
  assert.equal(r.status, 400, "a note is required");

  r = await admin("POST", `/api/admin/invoices/${invoiceNumber}/override`, {
    json: { status: "Paid", paymentReference: "BANK-TELLER-001", note: "Bank teller verified by finance" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  r = await http("GET", `/api/invoice/${invoiceNumber}`);
  assert.equal(r.body.invoice.paymentStatus, "Paid");
  assert.equal(r.body.document.payment.confirmedBy, "Finance office (manually verified)");

  const audit = (await auditsFor(invoiceNumber)).find((a) => a.action === "manual_override");
  assert.equal(audit.actorType, "admin");
  assert.equal(audit.actorId, ADMIN_USERNAME);
  assert.equal(audit.actorLabel, `Admin: ${ADMIN_USERNAME} (super_admin)`);
  assert.equal(audit.note, "Bank teller verified by finance");
});

test("admins without payments:write, or deactivated admins, cannot change payment status", async () => {
  const { http, invoiceNumber } = await newStudentWithInvoice();
  const superAdmin = await adminClient();

  const username = `auditor${Date.now()}`;
  const tempPassword = "TempPass123!";
  const finalPassword = "FinalPass123!";
  let r = await superAdmin("POST", "/api/admin/users", { json: { username, password: tempPassword, role: "auditor" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const auditorId = r.body.admin.id;

  const auditor = client();
  await auditor("POST", "/api/admin/login", { json: { username, password: tempPassword } });
  r = await auditor("POST", "/api/admin/change-password", {
    json: { currentPassword: tempPassword, newPassword: finalPassword, confirmPassword: finalPassword },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  r = await auditor("POST", `/api/admin/invoices/${invoiceNumber}/override`, { json: { status: "Paid", note: "x" } });
  assert.equal(r.status, 403, "auditor role is read-only");

  // Promote to finance_admin, then deactivate: the live session must lose access.
  await superAdmin("POST", `/api/admin/users/${auditorId}/role`, { json: { role: "finance_admin" } });
  await superAdmin("POST", `/api/admin/users/${auditorId}/toggle-active`, { json: { makeActive: "0" } });
  r = await auditor("POST", `/api/admin/invoices/${invoiceNumber}/override`, { json: { status: "Paid", note: "x" } });
  assert.equal(r.status, 401);

  assert.equal(await invoiceStatus(http, invoiceNumber), "Unpaid");
});

// ---------------------------------------------------------------------------
// Billing audit regressions

test("Auto Reconcile does not mark an under-paid invoice as paid", async () => {
  const { http, invoiceNumber } = await newStudentWithInvoice();
  // Correctly signed, but pays USD 1 of USD 20.
  const body = paystackBody(invoiceNumber, { amountMinor: 100 });
  let r = await client()("POST", "/webhooks/payments", {
    raw: body,
    headers: { "content-type": "application/json", "x-paystack-signature": sign(body) },
  });
  assert.equal(r.status, 202);

  const admin = await adminClient();
  r = await admin("POST", "/api/admin/reconcile");
  assert.equal(r.status, 200);
  assert.equal(await invoiceStatus(http, invoiceNumber), "Unpaid");

  // The full, correct payment is still accepted.
  const good = paystackBody(invoiceNumber, { amountMinor: 2000 });
  await client()("POST", "/webhooks/payments", {
    raw: good,
    headers: { "content-type": "application/json", "x-paystack-signature": sign(good) },
  });
  assert.equal(await invoiceStatus(http, invoiceNumber), "Paid");
});

test("the dashboard never exposes the password hash or rejected webhook attempts", async () => {
  const { http, invoiceNumber } = await newStudentWithInvoice();
  const forged = paystackBody(invoiceNumber);
  await client()("POST", "/webhooks/payments", {
    raw: forged,
    headers: { "content-type": "application/json", "x-paystack-signature": sign(forged, "attacker") },
  });
  await http("POST", `/api/invoice/${invoiceNumber}/checkout`, { json: VALID_CARD });

  const r = await http("GET", "/api/dashboard");
  assert.equal(r.status, 200);
  assert.equal(r.body.snapshot.user.passwordHash, undefined);
  assert.ok(!JSON.stringify(r.body).includes("passwordHash"));
  assert.ok(r.body.snapshot.paymentHistory.length >= 1);
  for (const tx of r.body.snapshot.paymentHistory) {
    assert.equal(tx.signatureValid, true);
    assert.equal(tx.payloadJson, undefined);
  }
});

test("APIs reject malformed or wrongly typed input with JSON 4xx, never a 500 or stack trace", async () => {
  const http = client();
  let r = await http("POST", "/api/auth/login", { raw: "not json", headers: { "content-type": "application/json" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.ok(!JSON.stringify(r.body).includes("at "), "no stack trace");

  r = await http("POST", "/api/auth/register", {
    json: { surname: 1, otherNames: [], email: {}, phone: true, password: 5 },
  });
  assert.equal(r.status, 400);
  r = await http("POST", "/api/auth/register", {
    json: { surname: "A", otherNames: "B", email: "not-an-email", phone: "1", password: "secret123" },
  });
  assert.equal(r.status, 400);
  r = await http("POST", "/api/auth/register", {
    json: { surname: "A", otherNames: "B", email: `short${Date.now()}@example.com`, phone: "1", password: "pw" },
  });
  assert.equal(r.status, 400, "passwords shorter than 8 characters are refused");

  const { http: student, invoiceNumber } = await newStudentWithInvoice();
  r = await student("POST", "/api/pre-application", {
    json: { programId: { a: 1 }, modeOfStudy: "Full-Time", previousInstitution: "X" },
  });
  assert.equal(r.status, 400);

  const admin = await adminClient();
  r = await admin("POST", `/api/admin/invoices/${invoiceNumber}/override`, {
    json: { status: "Paid", note: "ok", paymentReference: { a: 1 } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.invoice.paymentReference, null, "non-string reference is not stored as [object Object]");

  r = await http("GET", "/api/does-not-exist");
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
});

test("the reconciliation CSV neutralises spreadsheet formulas in applicant data", async () => {
  const http = client();
  const email = `csv${Date.now()}@example.com`;
  await http("POST", "/api/auth/register", {
    json: { surname: '=HYPERLINK("http://evil.example","x")', otherNames: "+cmd|calc", email, phone: "1", password: "secret123" },
  });
  await http("POST", "/api/pre-application", {
    json: { programId: "sample-program", modeOfStudy: "Full-Time", previousInstitution: "X" },
  });
  await http("POST", "/api/invoice/create");

  const admin = await adminClient();
  const r = await admin("GET", `/admin/payments/export.csv?q=${encodeURIComponent(email)}`);
  assert.equal(r.status, 200);
  const line = r.body.split("\n")[1];
  assert.ok(line.includes(`"'=HYPERLINK(`), line);
  assert.ok(line.includes(`"'+cmd|calc"`), line);
  assert.ok(!/(^|,)"[=+\-@]/.test(line), "no cell starts with a formula character");
});

test("admins can open any invoice/receipt PDF; applicants and anonymous users cannot use the admin route", async () => {
  const { http, invoiceNumber } = await newStudentWithInvoice();
  const admin = await adminClient();
  let r = await admin("GET", `/api/admin/invoices/${invoiceNumber}/pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.equal(r.body.subarray(0, 5).toString(), "%PDF-");

  r = await http("GET", `/api/admin/invoices/${invoiceNumber}/pdf`);
  assert.equal(r.status, 401);
  r = await client()("GET", `/api/admin/invoices/${invoiceNumber}/pdf`);
  assert.equal(r.status, 401);
});

test("the session cookie is HttpOnly and SameSite=Lax (admin forms cannot be submitted cross-site)", async () => {
  const r = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  const cookie = r.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
});

test("settings are loaded from backend.env; real environment variables take precedence", async () => {
  const dir = tempDir();
  const envFile = path.join(dir, "backend.env");
  fs.writeFileSync(envFile, "APPLICATION_FEE_AMOUNT=35\nAPPLICATION_FEE_DESCRIPTION=Fee From File\n");

  const fromFile = await startServer({ BACKEND_ENV_FILE: envFile, APPLICATION_FEE_AMOUNT: undefined });
  try {
    const { http, invoiceNumber } = await newStudentWithInvoice(fromFile.base);
    const r = await http("GET", `/api/invoice/${invoiceNumber}`);
    assert.equal(r.body.invoice.amount, 35);
    assert.equal(r.body.invoice.feeDescription, "Fee From File");
  } finally {
    fromFile.child.kill();
  }

  const envWins = await startServer({ BACKEND_ENV_FILE: envFile, APPLICATION_FEE_AMOUNT: "50" });
  try {
    const { http, invoiceNumber } = await newStudentWithInvoice(envWins.base);
    const r = await http("GET", `/api/invoice/${invoiceNumber}`);
    assert.equal(r.body.invoice.amount, 50);
  } finally {
    envWins.child.kill();
  }
});

test("a zero-amount invoice cannot be 'paid' by card", async () => {
  const free = await startServer({ APPLICATION_FEE_AMOUNT: "0" });
  try {
    const { http, invoiceNumber } = await newStudentWithInvoice(free.base);
    let r = await http("GET", `/api/invoice/${invoiceNumber}`);
    assert.equal(r.body.checkout.enabled, false);
    assert.equal(r.body.checkout.noAmountDue, true);
    r = await http("POST", `/api/invoice/${invoiceNumber}/checkout`, { json: VALID_CARD });
    assert.equal(r.status, 400);
    assert.equal(await invoiceStatus(http, invoiceNumber), "Unpaid");
  } finally {
    free.child.kill();
  }
});

test("production refuses to start without real Paystack credentials", async () => {
  const configurations = [
    { PAYSTACK_SECRET_KEY: undefined, PAYSTACK_WEBHOOK_SECRET: "whsec_test_secret" },
    { PAYSTACK_SECRET_KEY: "sk_test_private", PAYSTACK_WEBHOOK_SECRET: undefined },
    { PAYSTACK_SECRET_KEY: "sk_test_private", PAYSTACK_WEBHOOK_SECRET: "replace-with-your-paystack-webhook-secret" },
  ];
  for (const configuration of configurations) {
    const started = startServer({
      NODE_ENV: "production",
      ...configuration,
      PUBLIC_BASE_URL: "https://portal.example.com",
      SESSION_SECRET: "a-secure-session-secret-over-32-characters",
      ADMIN_PASSWORD: "AnotherStrongPassword1!",
    });
    started.then(({ child }) => child.kill(), () => {});
    await assert.rejects(started, (err) => /PAYSTACK_SECRET_KEY|PAYSTACK_WEBHOOK_SECRET/.test(err.output || err.message));
  }
});

test("production refuses to start without explicit Firestore", async () => {
  for (const provider of [undefined, "sqlite"]) {
    const started = startServer({
      NODE_ENV: "production",
      DATA_STORE: provider,
      PAYSTACK_SECRET_KEY: "sk_test_private",
      PAYSTACK_WEBHOOK_SECRET: "whsec_test_secret",
      PUBLIC_BASE_URL: "https://portal.example.com",
      SESSION_SECRET: "a-secure-session-secret-over-32-characters",
      ADMIN_PASSWORD: "AnotherStrongPassword1!",
      MOCK_PAYMENTS_ENABLED: "false",
    });
    started.then(({ child }) => child.kill(), () => {});
    await assert.rejects(started, (err) => /DATA_STORE=firestore|SQLite is not supported/.test(err.output || err.message));
  }
});

test("invoice numbers stay unique when the generator collides", () => {
  const dir = tempDir();
  const script = `
    const store = require(${JSON.stringify(path.join(__dirname, "..", "src", "data", "store.js"))});
    store.ensureSeed({ defaultAdminUsername: "admin", defaultAdminPassword: "AdminPass123!" });
    const user = store.createUser({ surname: "U", otherNames: "V", email: "u@example.com", phone: "1", passwordHash: "x" });
    Date.now = () => 1700000000000;             // freeze the timestamp part
    const randoms = [0.5, 0.5, 0.5, 0.9];       // 2nd invoice collides once, then succeeds
    Math.random = () => randoms.shift() ?? 0.1;
    const a = store.createInvoice({ userId: user.id, amount: 20, feeDescription: "Fee", currency: "USD" });
    const b = store.createInvoice({ userId: user.id, amount: 20, feeDescription: "Fee", currency: "USD" });
    console.log(JSON.stringify([a.invoiceNumber, b.invoiceNumber]));
  `;
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, ["--no-warnings", "-e", script], {
    env: { ...process.env, DATABASE_PATH: path.join(dir, "unit.db") },
  }).toString();
  const [a, b] = JSON.parse(out.trim().split("\n").pop());
  assert.notEqual(a, b);
});
