// End-to-end tests for payment authorization, webhooks, checkout and receipts.
// Starts the real server on a temporary database:  npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

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

// ---------------------------------------------------------------------------

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
