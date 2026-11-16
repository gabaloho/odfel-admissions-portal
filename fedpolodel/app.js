const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { loadBackendEnv, readFrontendEnvValue } = require("./src/config/env");

// Load backend.env before anything reads process.env (store.js reads PROGRAMS_JSON on load).
const LOADED_ENV_FILE = loadBackendEnv(__dirname);

const { createWebhookProcessor } = require("./src/payments/webhooks");
const { createMockGateway, validateCard, PUBLIC_TEST_CARDS } = require("./src/payments/mockGateway");
const { createPaystackClient } = require("./src/payments/paystack");
const { buildInvoiceDocument, renderInvoicePdf } = require("./src/invoices/document");
const { renderAcademicRecord } = require("./src/academic/record");
const { PROGRAMME_PRESETS, validateInstitutionSettings } = require("./src/config/institution");
const { validDecimal, validateGradingScale, gradeScore } = require("./src/config/grading");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "AdminPass123!";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const DEFAULT_APPLICATION_FEE_AMOUNT = 25000;
const applicationFeeAmountSetting = process.env.APPLICATION_FEE_AMOUNT;
if (applicationFeeAmountSetting != null && !applicationFeeAmountSetting.trim()) {
  throw new Error("APPLICATION_FEE_AMOUNT must be a non-negative number.");
}
const APPLICATION_FEE_AMOUNT = applicationFeeAmountSetting == null
  ? DEFAULT_APPLICATION_FEE_AMOUNT
  : Number(applicationFeeAmountSetting);
if (!Number.isFinite(APPLICATION_FEE_AMOUNT) || APPLICATION_FEE_AMOUNT < 0) {
  throw new Error("APPLICATION_FEE_AMOUNT must be a non-negative number.");
}
const APPLICATION_FEE_CURRENCY = String(process.env.APPLICATION_FEE_CURRENCY || "NGN")
  .trim()
  .toUpperCase();
if (!/^[A-Z]{3}$/.test(APPLICATION_FEE_CURRENCY)) {
  throw new Error("APPLICATION_FEE_CURRENCY must be a three-letter currency code.");
}
const APPLICATION_FEE_DESCRIPTION =
  String(process.env.APPLICATION_FEE_DESCRIPTION || "Application Processing Fee").trim();
if (!APPLICATION_FEE_DESCRIPTION) {
  throw new Error("APPLICATION_FEE_DESCRIPTION must not be empty.");
}
const PAYSTACK_SECRET_KEY = String(process.env.PAYSTACK_SECRET_KEY || "").trim();
const PAYSTACK_WEBHOOK_SECRETS = [
  process.env.PAYSTACK_WEBHOOK_SECRET,
  ...String(process.env.PAYSTACK_PREVIOUS_WEBHOOK_SECRETS || "").split(","),
]
  .map((value) => String(value || "").trim())
  .filter(Boolean);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
if (IS_PRODUCTION) {
  if (!PAYSTACK_SECRET_KEY || PAYSTACK_SECRET_KEY === "replace-with-your-paystack-secret-key") {
    throw new Error("Set PAYSTACK_SECRET_KEY from Secret Manager before starting the production server.");
  }
  if (!PAYSTACK_WEBHOOK_SECRETS.length || PAYSTACK_WEBHOOK_SECRETS.some((secret) => !secret.startsWith("whsec_"))) {
    throw new Error("Set PAYSTACK_WEBHOOK_SECRET to a Paystack whsec_ signing secret from Secret Manager.");
  }
  if (!PUBLIC_BASE_URL) {
    throw new Error("Set PUBLIC_BASE_URL to the HTTPS application URL before starting the production server.");
  }
  let publicUrl;
  try {
    publicUrl = new URL(PUBLIC_BASE_URL);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be an absolute HTTPS URL.");
  }
  if (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("PUBLIC_BASE_URL must be an HTTPS origin without a path, query, or fragment.");
  }
}
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || (IS_PRODUCTION ? "" : "change-me-webhook-secret");
if (IS_PRODUCTION) {
  const secret = String(process.env.SESSION_SECRET || "").trim();
  if (secret.length < 32 || secret === "change-this-secret-in-production") throw new Error("Set SESSION_SECRET to a random secret of at least 32 characters.");
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || ADMIN_PASSWORD === "AdminPass123!") throw new Error("Set unique ADMIN_USERNAME and ADMIN_PASSWORD in production.");
}
const { store, sessionStore } = require("./src/data/select-store").selectStore();
// Dummy-card checkout. On by default for development, off by default in production.
const MOCK_GATEWAY_ENABLED = process.env.MOCK_PAYMENTS_ENABLED
  ? ["1", "true", "yes"].includes(String(process.env.MOCK_PAYMENTS_ENABLED).trim().toLowerCase())
  : !IS_PRODUCTION;
if (IS_PRODUCTION && MOCK_GATEWAY_ENABLED) {
  throw new Error("MOCK_PAYMENTS_ENABLED must be false in production.");
}
// Name printed on invoice/receipt PDFs. Falls back to the frontend's VITE_INSTITUTION_NAME.
const INSTITUTION_NAME =
  String(process.env.INSTITUTION_NAME || "").trim() ||
  readFrontendEnvValue(__dirname, "VITE_INSTITUTION_NAME") ||
  "Your Institution";
const REACT_DIST_DIR = path.join(__dirname, "fedpolodfel-react", "dist");
const REACT_INDEX_FILE = path.join(REACT_DIST_DIR, "index.html");
const REACT_PUBLIC_ROUTES = new Set([
  "/",
  "/admission-requirement",
  "/start-application",
  "/check-status",
  "/print-document",
  "/continue-application",
]);

const webhookProcessor = createWebhookProcessor({
  store,
  secret: PAYMENT_WEBHOOK_SECRET,
  paystackSecretKey: PAYSTACK_SECRET_KEY || PAYMENT_WEBHOOK_SECRET,
  paystackWebhookSecrets: PAYSTACK_WEBHOOK_SECRETS.length ? PAYSTACK_WEBHOOK_SECRETS : [PAYMENT_WEBHOOK_SECRET],
  expectedPaystackDomain: IS_PRODUCTION ? "live" : null,
  mockGatewayEnabled: MOCK_GATEWAY_ENABLED,
});
const mockGateway = createMockGateway({ secret: PAYMENT_WEBHOOK_SECRET, webhookProcessor });
const paystackClient = createPaystackClient({ secretKey: PAYSTACK_SECRET_KEY });

const ROLE_PERMISSIONS = {
  super_admin: ["payments:view", "payments:write", "payments:reconcile", "admin-users:manage", "sis:manage", "student-fees:manage"],
  finance_admin: ["payments:view", "payments:write", "payments:reconcile", "student-fees:manage"],
  auditor: ["payments:view"],
};

// Payment webhooks must be registered before the JSON/urlencoded parsers: the
// signature is an HMAC of the exact raw bytes, and once express.json() has
// consumed the body express.raw() has nothing left to read.
app.post("/webhooks/payments", express.raw({ type: () => true, limit: "256kb" }), async (req, res) => {
  const result = await webhookProcessor.processWebhook({ headers: req.headers, rawBody: req.body });
  return res.status(result.httpStatus).send(result.message);
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
if (IS_PRODUCTION) app.set("trust proxy", 1);
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    // SameSite=Lax: browsers do not send the session cookie on cross-site POSTs,
    // so another website cannot submit the admin override form (or any other
    // state-changing request) using a logged-in admin's session.
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PRODUCTION || process.env.SESSION_COOKIE_SECURE === "true",
      maxAge: 86400000,
    },
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.currentAdmin = req.session.admin || null;
  res.locals.message = req.session.message || null;
  delete req.session.message;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.message = "Please log in to continue.";
    return res.redirect("/login");
  }
  return next();
}

function requireApiAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      ok: false,
      message: "Please log in to continue.",
    });
  }
  return next();
}

// Start a fresh session for exactly one identity. Regenerating prevents session
// fixation and guarantees a session is either an applicant *or* an admin, never
// both, so an applicant session can never carry admin rights.
function startSession(req, key, value) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session[key] = value;
      return resolve();
    });
  });
}

function studentSessionFor(user) {
  return {
    id: user.id,
    surname: user.surname,
    otherNames: user.otherNames,
    email: user.email,
  };
}

// Re-check the admin against the database on every admin request so that a
// deactivated admin, or a role change, takes effect immediately.
// Returns an error string, or null when the session is a valid admin session.
async function verifyAdminSession(req) {
  if (!req.session.admin) {
    return "Admin login required.";
  }
  if (req.session.user) {
    delete req.session.admin;
    return "Applicant sessions cannot use admin tools. Log in with an admin account.";
  }
  const current = await store.getAdminById(req.session.admin.id);
  if (!current || !current.isActive) {
    delete req.session.admin;
    return "Admin account is no longer active.";
  }
  req.session.admin.role = current.role;
  req.session.admin.mustChangePassword = Boolean(current.mustChangePassword) || store.isAdminPasswordExpired(current);
  req.session.admin.passwordExpiresAt = current.passwordExpiresAt || null;
  return null;
}

function adminActorLabel(admin) {
  return `Admin: ${admin.username} (${admin.role})`;
}

async function requireAdminSession(req, res, next) {
  const problem = await verifyAdminSession(req);
  if (problem) {
    req.session.message = problem;
    return res.redirect("/admin/login");
  }

  return next();
}

async function requireAdmin(req, res, next) {
  const problem = await verifyAdminSession(req);
  if (problem) {
    req.session.message = problem;
    return res.redirect("/admin/login");
  }

  if (req.session.admin.mustChangePassword) {
    req.session.message = "You must change your password before continuing.";
    return res.redirect("/admin/change-password");
  }
  return next();
}

function hasPermission(admin, permission) {
  if (!admin || !admin.role) {
    return false;
  }
  const rolePerms = ROLE_PERMISSIONS[admin.role] || [];
  return rolePerms.includes(permission);
}

function requireAdminPermission(permission) {
  return async (req, res, next) => {
    const problem = await verifyAdminSession(req);
    if (problem) {
      req.session.message = problem;
      return res.redirect("/admin/login");
    }

    if (!hasPermission(req.session.admin, permission)) {
      req.session.message = "You do not have permission to perform this action.";
      return res.redirect("/admin/payments");
    }

    if (req.session.admin.mustChangePassword) {
      req.session.message = "You must change your password before continuing.";
      return res.redirect("/admin/change-password");
    }

    return next();
  };
}

async function requireApiAdmin(req, res, next) {
  const problem = await verifyAdminSession(req);
  if (problem) {
    return res.status(401).json({
      ok: false,
      message: problem,
    });
  }

  if (req.session.admin.mustChangePassword) {
    return res.status(403).json({
      ok: false,
      message: "Password update required.",
      next: "/admin/change-password",
    });
  }

  return next();
}

async function requireApiAdminSession(req, res, next) {
  const problem = await verifyAdminSession(req);
  if (problem) {
    return res.status(401).json({
      ok: false,
      message: problem,
    });
  }

  return next();
}

function requireApiAdminPermission(permission) {
  return async (req, res, next) => {
    const problem = await verifyAdminSession(req);
    if (problem) {
      return res.status(401).json({
        ok: false,
        message: problem,
      });
    }

    if (req.session.admin.mustChangePassword) {
      return res.status(403).json({
        ok: false,
        message: "Password update required.",
        next: "/admin/change-password",
      });
    }

    if (!hasPermission(req.session.admin, permission)) {
      return res.status(403).json({
        ok: false,
        message: "You do not have permission to perform this action.",
      });
    }

    return next();
  };
}

function buildAdminSession(admin) {
  return {
    id: admin.id,
    username: admin.username,
    role: admin.role,
    mustChangePassword: Boolean(admin.mustChangePassword) || store.isAdminPasswordExpired(admin),
    passwordExpiresAt: admin.passwordExpiresAt || null,
    loggedInAt: new Date().toISOString(),
  };
}

function escapeCsvValue(value) {
  let text = String(value == null ? "" : value);
  // Applicant-controlled values (names, emails) must not run as spreadsheet
  // formulas when finance opens the export in Excel/Sheets (CSV injection).
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  const escaped = text.replace(/"/g, '""');
  return `"${escaped}"`;
}

function rowsToCsv(rows, headers) {
  const headerRow = headers.map((h) => escapeCsvValue(h.label)).join(",");
  const dataRows = rows.map((row) => headers.map((h) => escapeCsvValue(row[h.key])).join(","));
  return [headerRow, ...dataRows].join("\n");
}

// Request bodies are untrusted: JSON can carry numbers, arrays or objects where a
// string is expected (node:sqlite even treats an object as named parameters).
// Returns the trimmed string, or "" for anything that is not a string/number.
function textField(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.trim() : "";
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function validateRegistration(body = {}) {
  const values = {
    surname: textField(body.surname),
    otherNames: textField(body.otherNames),
    email: textField(body.email).toLowerCase(),
    phone: textField(body.phone),
    password: typeof body.password === "string" ? body.password : "",
  };
  if (!values.surname || !values.otherNames || !values.email || !values.phone || !values.password) {
    return { error: "All registration fields are required." };
  }
  if (values.surname.length > 100 || values.otherNames.length > 150) {
    return { error: "Names must be at most 100 (surname) and 150 (other names) characters." };
  }
  if (values.email.length > 190 || !EMAIL_PATTERN.test(values.email)) {
    return { error: "Enter a valid email address." };
  }
  if (values.phone.length > 30) {
    return { error: "Phone number must be at most 30 characters." };
  }
  if (values.password.length < MIN_PASSWORD_LENGTH || values.password.length > 200) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  return { values };
}

async function validatePreApplication(body = {}) {
  const values = {
    programId: textField(body.programId),
    modeOfStudy: textField(body.modeOfStudy),
    previousInstitution: textField(body.previousInstitution),
    notes: textField(body.notes),
  };
  if (!values.programId || !values.modeOfStudy || !values.previousInstitution) {
    return { error: "Program, mode of study, and previous institution are required." };
  }
  if (values.modeOfStudy.length > 60 || values.previousInstitution.length > 190 || values.notes.length > 2000) {
    return { error: "One of the fields is too long." };
  }
  const settings = await store.getInstitutionSettings();
  if (!await store.getProgramById(values.programId) || (settings && !settings.programmeIds.includes(values.programId))) {
    return { error: "Selected program is invalid." };
  }
  if (settings && !settings.modesOfStudy.includes(values.modeOfStudy)) return { error: "Selected mode of study is invalid." };
  return { values };
}

async function availablePrograms() {
  const [programs, settings] = await Promise.all([store.listPrograms(), store.getInstitutionSettings()]);
  return settings ? programs.filter((program) => settings.programmeIds.includes(program.id)) : programs;
}

async function applicationFee() {
  const settings = await store.getInstitutionSettings();
  return settings
    ? { amount: settings.feeAmount, currency: settings.currency, feeDescription: settings.feeDescription }
    : { amount: APPLICATION_FEE_AMOUNT, currency: APPLICATION_FEE_CURRENCY, feeDescription: APPLICATION_FEE_DESCRIPTION };
}

const OVERRIDE_STATUSES = ["Paid", "Unpaid", "Pending", "Failed"];

function parseOverrideRequest(body = {}) {
  const values = {
    status: textField(body.status),
    paymentReference: textField(body.paymentReference) || null,
    paymentProvider: textField(body.paymentProvider) || null,
    note: textField(body.note) || null,
  };
  if (!OVERRIDE_STATUSES.includes(values.status)) {
    return { error: "Invalid status selection for manual override." };
  }
  if (!values.note) {
    return { error: "A note explaining the manual verification is required." };
  }
  if (
    (values.paymentReference && values.paymentReference.length > 120) ||
    (values.paymentProvider && values.paymentProvider.length > 40) ||
    values.note.length > 500
  ) {
    return { error: "Reference (120), provider (40) or note (500) is too long." };
  }
  return { values };
}

const SELF_PAY_FORBIDDEN_MESSAGE =
  "Applicants cannot mark invoices as paid. Pay with a card from the invoice page, " +
  "or contact the finance office to verify an offline payment.";

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

async function loadInvoiceDocument(invoice) {
  const user = await store.getUserById(invoice.userId);
  const application = await store.getApplicationByUserId(invoice.userId);
  const student = invoice.invoiceKind === "student_fee" ? await store.getStudentByUserId(invoice.userId) : null;
  const programId = student?.programId || application?.programId;
  const program = programId ? await store.getProgramById(programId) : null;
  const settings = await store.getInstitutionSettings();
  const document = await buildInvoiceDocument({
    store,
    invoice,
    user,
    program,
    institutionName: settings?.institutionName || INSTITUTION_NAME,
  });
  return { user, application, program, document };
}

async function sendInvoicePdf(res, invoice, { inline = false } = {}) {
  const { document } = await loadInvoiceDocument(invoice);
  const fileName = document.kind === "receipt"
    ? `payment-receipt-${document.receiptNumber}.pdf`
    : `invoice-${document.invoiceNumber}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${fileName}"`);
  res.setHeader("Cache-Control", "private, no-store");
  return renderInvoicePdf(document, res);
}

function sendApiError(res, status, message, extra = {}) {
  return res.status(status).json({
    ok: false,
    message,
    ...extra,
  });
}

function sendApiSuccess(res, payload = {}) {
  return res.status(200).json({
    ok: true,
    ...payload,
  });
}

function requireJsonBody(req, res, next) {
  if (!req.is("application/json")) {
    return sendApiError(res, 415, "Send the request body as JSON with the header Content-Type: application/json.");
  }
  return next();
}

function describePostEndpoint(description, example) {
  return async (req, res) => {
    res.set("Allow", "POST");
    return sendApiError(
      res,
      405,
      `The API is up. ${description} Send a POST request with a JSON body to use this endpoint.`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        example,
      }
    );
  };
}

function reactBuildExists() {
  return fs.existsSync(REACT_INDEX_FILE);
}

function serveReactApp(req, res, next) {
  if (!reactBuildExists()) {
    return next();
  }
  return res.sendFile(REACT_INDEX_FILE);
}

function sendReactBuildMissing(req, res) {
  return res
    .status(503)
    .send(
      "React build not found. Run `npm run build` in the project root (fedpolodel/), " +
        "or use `npm run dev` for the Vite dev server."
    );
}

// Serves the React app for a page route, or the "build missing" notice.
function servePage(req, res) {
  return serveReactApp(req, res, () => sendReactBuildMissing(req, res));
}

app.get(
  "/api/auth/register",
  describePostEndpoint("This endpoint creates an applicant account (signup).", {
    surname: "Doe",
    otherNames: "Jane",
    email: "jane@example.com",
    phone: "08000000000",
    password: "your-password",
  })
);

app.get(
  "/api/auth/login",
  describePostEndpoint("This endpoint signs in an applicant.", {
    email: "jane@example.com",
    password: "your-password",
  })
);

app.get("/api/health", async (req, res) => {
  return sendApiSuccess(res, { status: "up", uptimeSeconds: Math.round(process.uptime()) });
});

app.get("/api/institution", async (req, res) => {
  const settings = await store.getInstitutionSettings();
  return sendApiSuccess(res, { configured: Boolean(settings), settings });
});

app.get("/api/admin/institution", requireApiAdminPermission("admin-users:manage"), async (req, res) => {
  return sendApiSuccess(res, {
    settings: await store.getInstitutionSettings(),
    existingPrograms: await store.listPrograms(),
    presets: PROGRAMME_PRESETS,
    defaults: {
      institutionName: INSTITUTION_NAME,
      institutionWebsite: readFrontendEnvValue(__dirname, "VITE_INSTITUTION_WEBSITE") || "",
      institutionEmail: readFrontendEnvValue(__dirname, "VITE_INSTITUTION_EMAIL") || "",
      institutionPhone: readFrontendEnvValue(__dirname, "VITE_INSTITUTION_PHONE") || "",
      institutionAddress: readFrontendEnvValue(__dirname, "VITE_INSTITUTION_ADDRESS") || "",
      institutionLogo: readFrontendEnvValue(__dirname, "VITE_INSTITUTION_LOGO") || "",
      currency: APPLICATION_FEE_CURRENCY,
      feeAmount: APPLICATION_FEE_AMOUNT,
      feeDescription: APPLICATION_FEE_DESCRIPTION,
      modesOfStudy: (readFrontendEnvValue(__dirname, "VITE_MODES_OF_STUDY") || "Full-Time,Part-Time,Distance Learning").split(",").map((mode) => mode.trim()).filter(Boolean),
      language: "en",
    },
  });
});

app.post("/api/admin/institution", requireApiAdminPermission("admin-users:manage"), requireJsonBody, async (req, res) => {
  const { values, error } = validateInstitutionSettings(req.body);
  if (error) return sendApiError(res, 400, error);
  const settings = await store.saveInstitutionSettings(values, {
    actorType: "admin",
    actorId: req.session.admin.id,
    actorLabel: adminActorLabel(req.session.admin),
    action: "institution_settings_updated",
    note: "Institution settings and available programmes updated.",
  });
  return sendApiSuccess(res, { settings, message: "Institution settings saved." });
});

function validSisId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,189}$/i.test(value);
}

function sisActor(req) {
  return { id: req.session.admin.id, label: adminActorLabel(req.session.admin) };
}

function sendSisResult(res, result, message) {
  return result.error ? sendApiError(res, 409, result.error) : sendApiSuccess(res, { ...result, message });
}

app.get("/api/admin/sis/structure", requireApiAdminPermission("sis:manage"), async (req, res) => {
  return sendApiSuccess(res, await store.listAcademicStructure());
});

app.post("/api/admin/sis/schools", requireApiAdminPermission("sis:manage"), requireJsonBody, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name || name.length > 190) return sendApiError(res, 400, "Enter a school name of up to 190 characters.");
  return sendSisResult(res, await store.createSchool(name, sisActor(req)), "School created.");
});

app.post("/api/admin/sis/departments", requireApiAdminPermission("sis:manage"), requireJsonBody, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const schoolId = req.body?.schoolId;
  if (!name || name.length > 190 || !validSisId(schoolId)) return sendApiError(res, 400, "Enter a valid school and department name.");
  return sendSisResult(res, await store.createDepartment(schoolId, name, sisActor(req)), "Department created.");
});

app.post("/api/admin/sis/programme-department", requireApiAdminPermission("sis:manage"), requireJsonBody, async (req, res) => {
  const { programId, departmentId } = req.body || {};
  if (!validSisId(programId) || !validSisId(departmentId)) return sendApiError(res, 400, "Choose a valid programme and department.");
  return sendSisResult(res, await store.assignProgrammeDepartment(programId, departmentId, sisActor(req)), "Programme assigned.");
});

app.get("/api/admin/sis/admissions", requireApiAdminPermission("sis:manage"), async (req, res) => {
  return sendApiSuccess(res, { applications: await store.listAdmissions() });
});

app.post("/api/admin/sis/admissions/:userId/decision", requireApiAdminPermission("sis:manage"), requireJsonBody, async (req, res) => {
  const { decision, note } = req.body || {};
  if (!validSisId(req.params.userId) || !["Admitted", "Rejected"].includes(decision) || typeof note !== "string" || !note.trim() || note.trim().length > 1000) return sendApiError(res, 400, "Choose a decision and enter a reason of up to 1000 characters.");
  return sendSisResult(res, await store.decideAdmission(req.params.userId, decision, note.trim(), sisActor(req)), "Admission decision saved.");
});

app.post("/api/admin/sis/admissions/:userId/matriculate", requireApiAdminPermission("sis:manage"), requireJsonBody, async (req, res) => {
  const value = req.body?.matriculationNumber;
  const number = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!validSisId(req.params.userId) || !/^[A-Z0-9][A-Z0-9/_-]{0,59}$/.test(number)) return sendApiError(res, 400, "Enter a matriculation number using letters, numbers, /, _ or - (up to 60 characters).");
  return sendSisResult(res, await store.matriculateStudent(req.params.userId, number, sisActor(req)), "Student matriculated.");
});

app.get("/api/admin/sis/students", requireApiAdminPermission("sis:manage"), async (req, res) => {
  return sendApiSuccess(res, { students: await store.listStudents() });
});

app.get("/api/admin/student-fees", requireApiAdminPermission("student-fees:manage"), async (req, res) => {
  const [students, invoices, settings] = await Promise.all([store.listStudents(), store.listStudentFeesForAdmin(), store.getInstitutionSettings()]);
  return sendApiSuccess(res, { students: students.map(({ userId, surname, otherNames, matriculationNumber }) => ({ userId, surname, otherNames, matriculationNumber })), invoices, currency: settings?.currency || APPLICATION_FEE_CURRENCY });
});

app.post("/api/admin/student-fees", requireApiAdminPermission("student-fees:manage"), requireJsonBody, async (req, res) => {
  const { userId, requestId } = req.body || {};
  const feeDescription = typeof req.body?.feeDescription === "string" ? req.body.feeDescription.trim() : "";
  const currency = typeof req.body?.currency === "string" ? req.body.currency.trim().toUpperCase() : "";
  const rawAmount = req.body?.amount;
  if (!validSisId(userId) || !validSisId(requestId) || !feeDescription || feeDescription.length > 190 || !/^[A-Z]{3}$/.test(currency) || typeof rawAmount !== "string" || !/^\d{1,12}(?:\.\d{1,2})?$/.test(rawAmount)) {
    return sendApiError(res, 400, "Enter a valid student, request ID, description, three-letter currency and positive amount with at most two decimal places.");
  }
  const [whole, fraction = ""] = rawAmount.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor) || minor <= 0) return sendApiError(res, 400, "Enter a positive amount that can be processed.");
  return sendSisResult(res, await store.createStudentFee({ userId, amount: minor / 100, feeDescription, currency, requestId }, sisActor(req)), "Student fee assigned.");
});

app.get("/api/student/fees", requireApiAuth, async (req, res) => {
  if (!await store.getStudentByUserId(req.session.user.id)) return sendApiError(res, 403, "Only matriculated students can view student fees.");
  return sendApiSuccess(res, { invoices: await store.listStudentFees(req.session.user.id) });
});

app.get("/api/admin/sis/courses", requireApiAdminPermission("sis:manage"), async (req, res) => {
  return sendApiSuccess(res, await store.listCourseCatalog());
});

app.post("/api/admin/sis/terms", requireApiAdminPermission("sis:manage"), requireJsonBody, async (req, res) => {
  const sessionName = typeof req.body?.sessionName === "string" ? req.body.sessionName.trim() : "";
  const termName = typeof req.body?.termName === "string" ? req.body.termName.trim() : "";
  if (!sessionName || sessionName.length > 100 || !termName || termName.length > 100) return sendApiError(res, 400, "Enter a session and term name of up to 100 characters each.");
  return sendSisResult(res, await store.createAcademicTerm(sessionName, termName, sisActor(req)), "Academic term created.");
});

app.post("/api/admin/sis/terms/:termId/registration", requireApiAdminPermission("sis:manage"), requireJsonBody, async (req, res) => {
  if (!validSisId(req.params.termId) || typeof req.body?.open !== "boolean") return sendApiError(res, 400, "Choose a valid term and registration state.");
  return sendSisResult(res, await store.setRegistrationOpen(req.params.termId, req.body.open, sisActor(req)), req.body.open ? "Registration opened." : "Registration closed.");
});

app.post("/api/admin/sis/courses", requireApiAdminPermission("sis:manage"), requireJsonBody, async (req, res) => {
  const programId = req.body?.programId;
  const code = typeof req.body?.code === "string" ? req.body.code.trim().toUpperCase() : "";
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const creditUnits = req.body?.creditUnits;
  if (!validSisId(programId) || !/^[A-Z0-9][A-Z0-9_-]{0,29}$/.test(code) || !title || title.length > 190 || !Number.isInteger(creditUnits) || creditUnits < 1 || creditUnits > 30) return sendApiError(res, 400, "Enter a programme, valid course code, title and 1 to 30 credit units.");
  return sendSisResult(res, await store.createCourse({ programId, code, title, creditUnits }, sisActor(req)), "Course created.");
});

app.post("/api/admin/sis/offerings", requireApiAdminPermission("sis:manage"), requireJsonBody, async (req, res) => {
  const { termId, courseId } = req.body || {};
  if (!validSisId(termId) || !validSisId(courseId)) return sendApiError(res, 400, "Choose a valid term and course.");
  return sendSisResult(res, await store.createCourseOffering(termId, courseId, sisActor(req)), "Course offered.");
});

app.get("/api/student/courses", requireApiAuth, async (req, res) => {
  const courses = await store.getStudentCourses(req.session.user.id);
  if (!courses) return sendApiError(res, 403, "Only matriculated students can view course registration.");
  return sendApiSuccess(res, { courses });
});

app.post("/api/student/courses/:offeringId", requireApiAuth, requireJsonBody, async (req, res) => {
  const { status } = req.body || {};
  if (!validSisId(req.params.offeringId) || !["registered", "dropped"].includes(status)) return sendApiError(res, 400, "Choose a valid course and registration action.");
  const actor = { label: `Student: ${req.session.user.email}` };
  return sendSisResult(res, await store.changeCourseRegistration(req.session.user.id, req.params.offeringId, status, actor), status === "registered" ? "Course registered." : "Course dropped.");
});

app.get("/api/admin/sis/attendance", requireApiAdminPermission("sis:manage"), async (req, res) => {
  const [catalog, meetings] = await Promise.all([store.listCourseCatalog(), store.listAttendanceMeetings()]);
  return sendApiSuccess(res, { ...catalog, meetings });
});

app.post("/api/admin/sis/attendance/meetings", requireApiAdminPermission("sis:manage"), requireJsonBody, async (req, res) => {
  const { offeringId, meetingDate } = req.body || {};
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  const date = typeof meetingDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(meetingDate) ? new Date(`${meetingDate}T00:00:00.000Z`) : new Date(NaN);
  if (!validSisId(offeringId) || !label || label.length > 100 || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== meetingDate) return sendApiError(res, 400, "Choose a course offering, valid date and meeting label of up to 100 characters.");
  return sendSisResult(res, await store.createAttendanceMeeting(offeringId, meetingDate, label, sisActor(req)), "Meeting created.");
});

app.get("/api/admin/sis/attendance/meetings/:meetingId", requireApiAdminPermission("sis:manage"), async (req, res) => {
  if (!validSisId(req.params.meetingId)) return sendApiError(res, 400, "Choose a valid meeting.");
  const result = await store.getAttendanceRoster(req.params.meetingId);
  return result ? sendApiSuccess(res, result) : sendApiError(res, 404, "Meeting not found.");
});

app.post("/api/admin/sis/attendance/meetings/:meetingId", requireApiAdminPermission("sis:manage"), requireJsonBody, async (req, res) => {
  const { userId, status, expectedRevision } = req.body || {};
  const statuses = ["present", "absent", "late", "excused"];
  if (!validSisId(req.params.meetingId) || !validSisId(userId) || !statuses.includes(status) || !(expectedRevision === null || validSisId(expectedRevision))) return sendApiError(res, 400, "Choose a student, attendance status and the previously reviewed revision.");
  return sendSisResult(res, await store.saveAttendance(req.params.meetingId, userId, status, expectedRevision, sisActor(req)), "Attendance saved.");
});

app.get("/api/student/attendance", requireApiAuth, async (req, res) => {
  const records = await store.getStudentAttendance(req.session.user.id);
  if (!records) return sendApiError(res, 403, "Only matriculated students can view attendance.");
  return sendApiSuccess(res, { records });
});

app.get("/api/admin/sis/report", requireApiAdminPermission("sis:manage"), async (req, res) => {
  return sendApiSuccess(res, { report: await store.getOperationalReport() });
});

app.get("/api/admin/sis/results", requireApiAdminPermission("sis:manage"), async (req, res) => {
  const data = await store.listResultRoster();
  const roster = data.roster.map((row) => {
    const scale = data.scales.find((item) => item.programId === row.programId);
    const draftPreview = scale && row.draftScore != null ? gradeScore(row.draftScore, scale.bands) : null;
    return { ...row, draftPreview, activeScaleId: scale?.id || null };
  });
  return sendApiSuccess(res, { ...data, roster });
});

app.post("/api/admin/sis/grading-scales", requireApiAdminPermission("sis:manage"), requireJsonBody, async (req, res) => {
  if (!validSisId(req.body?.programId)) return sendApiError(res, 400, "Choose a valid programme.");
  const { values, error } = validateGradingScale(req.body);
  if (error) return sendApiError(res, 400, error);
  return sendSisResult(res, await store.createGradingScale(req.body.programId, values.name, values.bands, sisActor(req)), "Grading scale saved.");
});

app.post("/api/admin/sis/results/draft", requireApiAdminPermission("sis:manage"), requireJsonBody, async (req, res) => {
  const { userId, offeringId, score, reason } = req.body || {};
  if (!validSisId(userId) || !validSisId(offeringId) || !validDecimal(score, 100) || typeof reason !== "string" || !reason.trim() || reason.trim().length > 1000) return sendApiError(res, 400, "Enter a valid score from 0 to 100 and an audit reason of up to 1000 characters.");
  return sendSisResult(res, await store.saveResultDraft(userId, offeringId, score, reason.trim(), sisActor(req)), "Draft result saved.");
});

app.post("/api/admin/sis/results/publish", requireApiAdminPermission("sis:manage"), requireJsonBody, async (req, res) => {
  const { userId, offeringId, draftId, scaleId } = req.body || {};
  if (!validSisId(userId) || !validSisId(offeringId) || !validSisId(draftId) || !validSisId(scaleId)) return sendApiError(res, 400, "Review the draft and grading scale before publishing.");
  return sendSisResult(res, await store.publishResult(userId, offeringId, draftId, scaleId, sisActor(req)), "Result published.");
});

app.get("/api/admin/sis/results/:userId/:offeringId/history", requireApiAdminPermission("sis:manage"), async (req, res) => {
  if (!validSisId(req.params.userId) || !validSisId(req.params.offeringId)) return sendApiError(res, 400, "Choose a valid student and course.");
  return sendApiSuccess(res, { publications: await store.getResultHistory(req.params.userId, req.params.offeringId) });
});

app.get("/api/student/results", requireApiAuth, async (req, res) => {
  const results = await store.getStudentPublishedResults(req.session.user.id);
  if (!results) return sendApiError(res, 403, "Only matriculated students can view results.");
  return sendApiSuccess(res, { results });
});

app.get("/api/student/academic-record.pdf", requireApiAuth, async (req, res) => {
  const userId = req.session.user.id;
  const [student, user, results, settings] = await Promise.all([
    store.getStudentByUserId(userId), store.getUserById(userId),
    store.getStudentPublishedResults(userId), store.getInstitutionSettings(),
  ]);
  if (!student) return sendApiError(res, 403, "Only matriculated students can download an academic record.");
  if (!user || !results) throw new Error("Student academic record references missing data.");
  const program = await store.getProgramById(student.programId);
  if (!program) throw new Error("Student academic record references a missing programme.");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="unofficial-academic-record.pdf"');
  res.setHeader("Cache-Control", "private, no-store");
  return renderAcademicRecord({
    institutionName: settings?.institutionName || INSTITUTION_NAME,
    studentName: `${user.surname} ${user.otherNames}`,
    matriculationNumber: student.matriculationNumber,
    programName: program.name,
    results,
  }, res);
});

app.get("/api/auth/session", async (req, res) => {
  return sendApiSuccess(res, {
    user: req.session.user || null,
    admin: req.session.admin || null,
  });
});

app.post("/api/auth/register", requireJsonBody, async (req, res) => {
  const { values, error } = validateRegistration(req.body || {});
  if (error) {
    return sendApiError(res, 400, error);
  }
  const { surname, otherNames, email, phone, password } = values;

  if (await store.getUserByEmail(email)) {
    return sendApiError(res, 409, "An account with this email already exists.");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  let user;
  try {
    user = await store.createUser({ surname, otherNames, email, phone, passwordHash });
  } catch (error) {
    if (error.code === "DUPLICATE_EMAIL" || error.errcode === 2067) return sendApiError(res, 409, "An account with this email already exists.");
    throw error;
  }

  await startSession(req, "user", studentSessionFor(user));

  return sendApiSuccess(res, {
    message: "Account created successfully.",
    user: req.session.user,
    next: "/pre-application",
  });
});

app.post("/api/auth/login", requireJsonBody, async (req, res) => {
  const email = textField(req.body?.email);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const user = email ? await store.getUserByEmail(email) : null;

  if (!user) {
    return sendApiError(res, 401, "Invalid email or password.");
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return sendApiError(res, 401, "Invalid email or password.");
  }

  await startSession(req, "user", studentSessionFor(user));

  return sendApiSuccess(res, {
    message: "Welcome back.",
    user: req.session.user,
    next: "/dashboard",
  });
});

app.post("/api/auth/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.status(200).json({ ok: true, message: "Logged out." });
  });
});

app.get("/api/programs", requireApiAuth, async (req, res) => {
  return sendApiSuccess(res, {
    programs: await availablePrograms(),
  });
});

app.get("/api/pre-application", requireApiAuth, async (req, res) => {
  return sendApiSuccess(res, {
    programs: await availablePrograms(),
    previous: await store.getApplicationByUserId(req.session.user.id),
  });
});

app.post("/api/pre-application", requireApiAuth, async (req, res) => {
  const { values, error } = await validatePreApplication(req.body || {});
  if (error) {
    return sendApiError(res, 400, error);
  }

  const saved = await store.createOrUpdateApplication({
    userId: req.session.user.id,
    ...values,
  });
  if (saved.error) return sendApiError(res, 409, saved.error);

  return sendApiSuccess(res, {
    message: "Pre-application saved successfully.",
    next: "/invoice/create",
  });
});

app.post("/api/invoice/create", requireApiAuth, async (req, res) => {
  const application = await store.getApplicationByUserId(req.session.user.id);
  if (!application) {
    return sendApiError(res, 400, "Please complete pre-application first.", { next: "/pre-application" });
  }

  const existingInvoice = await store.getLatestInvoiceByUserId(req.session.user.id);
  if (existingInvoice) {
    return sendApiSuccess(res, {
      invoice: existingInvoice,
      next: `/invoice/${existingInvoice.invoiceNumber}`,
    });
  }

  const invoice = await store.createInvoice({
    userId: req.session.user.id,
    ...await applicationFee(),
  });

  return sendApiSuccess(res, {
    invoice,
    message: "Invoice generated.",
    next: `/invoice/${invoice.invoiceNumber}`,
  });
});

app.get("/api/invoice/:invoiceNumber", requireApiAuth, async (req, res) => {
  const invoice = await store.getInvoiceByNumber(req.params.invoiceNumber);
  if (!invoice || invoice.userId !== req.session.user.id) {
    return sendApiError(res, 404, "Invoice not found.");
  }

  const { user, application, program, document } = await loadInvoiceDocument(invoice);

  return sendApiSuccess(res, {
    invoice,
    user: publicUser(user),
    application,
    program,
    document,
    checkout: {
      enabled: (MOCK_GATEWAY_ENABLED || Boolean(PAYSTACK_SECRET_KEY)) && invoice.paymentStatus !== "Paid" && invoice.amount > 0,
      noAmountDue: !(invoice.amount > 0),
      mode: MOCK_GATEWAY_ENABLED ? "test" : PAYSTACK_SECRET_KEY ? "paystack" : "unavailable",
      testCards: MOCK_GATEWAY_ENABLED ? PUBLIC_TEST_CARDS : [],
    },
  });
});

app.get("/api/invoice/:invoiceNumber/pdf", requireApiAuth, async (req, res) => {
  const invoice = await store.getInvoiceByNumber(req.params.invoiceNumber);
  if (!invoice || invoice.userId !== req.session.user.id) {
    return sendApiError(res, 404, "Invoice not found.");
  }

  return sendInvoicePdf(res, invoice);
});

// Card checkout (test mode). The applicant submits card details only; the
// amount comes from the stored invoice and the Paid status is set by the
// gateway's signed webhook, never by this request.
app.post("/api/invoice/:invoiceNumber/checkout", requireApiAuth, async (req, res) => {
  const invoice = await store.getInvoiceByNumber(req.params.invoiceNumber);
  if (!invoice || invoice.userId !== req.session.user.id) {
    return sendApiError(res, 404, "Invoice not found.");
  }

  if (invoice.paymentStatus === "Paid") {
    return sendApiError(res, 409, "This invoice has already been paid.");
  }

  if (!(invoice.amount > 0)) {
    return sendApiError(res, 400, "There is no amount due on this invoice. Contact the admissions office.");
  }

  if (MOCK_GATEWAY_ENABLED) {
    const { card, error } = validateCard(req.body || {});
    if (error) {
      return sendApiError(res, 400, error);
    }

    await store.createAuditLog({
      invoiceNumber: invoice.invoiceNumber,
      actorType: "user",
      actorId: req.session.user.id,
      actorLabel: `Applicant: ${req.session.user.email}`,
      action: "checkout_initiated",
      beforeStatus: invoice.paymentStatus,
      afterStatus: invoice.paymentStatus,
      note: `Card checkout started (${card.brand} ending ${card.last4}). Status unchanged until the gateway confirms.`,
      metadata: { gateway: "mock" },
    });

    const charge = await mockGateway.charge({ invoice, card });

    if (!charge.success) {
      return sendApiError(res, 402, `Payment declined: ${charge.declineReason}`, {
        reference: charge.reference,
      });
    }

    if (charge.webhook.outcome !== "marked_paid" && charge.webhook.outcome !== "already_paid") {
      return sendApiError(res, 502, `Payment could not be verified: ${charge.webhook.message}`, {
        reference: charge.reference,
      });
    }

    const updated = await store.getInvoiceByNumber(invoice.invoiceNumber);
    return sendApiSuccess(res, {
      message: `Payment successful. Reference: ${charge.reference}`,
      invoice: updated,
      document: (await loadInvoiceDocument(updated)).document,
    });
  }

  if (!PAYSTACK_SECRET_KEY) {
    return sendApiError(res, 503, "Online payment is not configured. Contact the finance office.");
  }

  const amountMinor = Math.round(Number(invoice.amount) * 100);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return sendApiError(res, 400, "The invoice amount cannot be processed as a Paystack payment.");
  }
  let callbackUrl;
  try {
    const baseUrl = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    callbackUrl = new URL("/payments/callback", baseUrl).toString();
  } catch {
    return sendApiError(res, 503, "Online payment callback URL is not configured.");
  }

  const reference = `ODFEL-${crypto.randomUUID()}`;
  try {
    const checkout = await paystackClient.initializeTransaction({
      email: req.session.user.email,
      amount: amountMinor,
      currency: invoice.currency,
      reference,
      callbackUrl,
      metadata: { invoiceNumber: invoice.invoiceNumber },
    });
    await store.recordPaymentTransaction({
      invoiceNumber: invoice.invoiceNumber,
      userId: req.session.user.id,
      provider: "paystack",
      eventType: "transaction.initialize",
      gatewayStatus: "initialized",
      gatewayReference: checkout.reference,
      amount: invoice.amount,
      currency: invoice.currency,
      signatureValid: false,
      payload: { reference: checkout.reference },
      processingNote: "Hosted Paystack checkout initialized; payment is not confirmed.",
    });
    await store.createAuditLog({
      invoiceNumber: invoice.invoiceNumber,
      actorType: "user",
      actorId: req.session.user.id,
      actorLabel: `Applicant: ${req.session.user.email}`,
      action: "checkout_initiated",
      beforeStatus: invoice.paymentStatus,
      afterStatus: invoice.paymentStatus,
      note: "Hosted Paystack checkout initialized. Status remains unchanged until payment verification.",
      metadata: { gateway: "paystack", reference: checkout.reference },
    });
    return sendApiSuccess(res, {
      checkoutUrl: checkout.checkoutUrl,
      reference: checkout.reference,
      message: "Continue to Paystack to complete payment.",
    });
  } catch (error) {
    console.error("Paystack checkout initialization failed.", error);
    return sendApiError(res, 502, "Could not start online payment. Please try again or contact the finance office.");
  }
});

// Applicants may not declare their own invoice paid. Payment status changes only
// through a verified gateway webhook (see /api/invoice/:n/checkout and
// /webhooks/payments) or an admin with payments:write.
app.post("/api/invoice/:invoiceNumber/pay", async (req, res) => {
  return sendApiError(res, 403, SELF_PAY_FORBIDDEN_MESSAGE);
});

app.get("/api/dashboard", requireApiAuth, async (req, res) => {
  const snapshot = await store.getDashboardByUserId(req.session.user.id);
  return sendApiSuccess(res, {
    snapshot: {
      ...snapshot,
      user: publicUser(snapshot.user),
      student: await store.getStudentByUserId(req.session.user.id),
      // Applicants see their verified gateway events only (not rejected/forged
      // webhook attempts) and never the raw gateway payload.
      paymentHistory: snapshot.paymentHistory
        .filter((tx) => tx.signatureValid)
        .map(({ payloadJson, userId, ...tx }) => tx),
    },
  });
});

app.get("/api/admin/session", async (req, res) => {
  return sendApiSuccess(res, {
    admin: req.session.admin || null,
  });
});

app.post("/api/admin/login", async (req, res) => {
  const username = textField(req.body?.username);
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  const admin = username ? await store.getAdminByUsername(username) : null;
  if (!admin) {
    return sendApiError(res, 401, "Invalid admin credentials.");
  }

  const ok = bcrypt.compareSync(password, admin.passwordHash);
  if (!ok) {
    return sendApiError(res, 401, "Invalid admin credentials.");
  }

  await startSession(req, "admin", buildAdminSession(admin));

  if (req.session.admin.mustChangePassword) {
    return sendApiSuccess(res, {
      message: "Password update required before you can access admin tools.",
      admin: req.session.admin,
      next: "/admin/change-password",
    });
  }

  return sendApiSuccess(res, {
    message: "Admin login successful.",
    admin: req.session.admin,
    next: "/admin/payments",
  });
});

app.post("/api/admin/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    return sendApiSuccess(res, { message: "Admin logged out." });
  });
});

app.post("/api/admin/change-password", requireApiAdminSession, async (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  const confirmPassword = String(req.body.confirmPassword || "");

  if (!newPassword || !confirmPassword || !currentPassword) {
    return sendApiError(res, 400, "All password fields are required.");
  }

  if (newPassword !== confirmPassword) {
    return sendApiError(res, 400, "New password and confirmation do not match.");
  }

  const result = await store.changeOwnAdminPassword({
    adminId: req.session.admin.id,
    currentPassword,
    newPassword,
  });

  if (result.error) {
    return sendApiError(res, 400, result.error);
  }

  req.session.admin.mustChangePassword = false;
  req.session.admin.passwordExpiresAt = result.admin.passwordExpiresAt || null;

  return sendApiSuccess(res, {
    message: "Password changed successfully.",
    admin: req.session.admin,
    next: "/admin/payments",
  });
});

app.get("/api/admin/users", requireApiAdminPermission("admin-users:manage"), async (req, res) => {
  return sendApiSuccess(res, {
    currentAdmin: req.session.admin,
    roles: Object.keys(ROLE_PERMISSIONS),
    admins: await store.listAdminUsers(),
  });
});

app.post("/api/admin/users", requireApiAdminPermission("admin-users:manage"), async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "").trim();

  if (!ROLE_PERMISSIONS[role]) {
    return sendApiError(res, 400, "Invalid admin role selected.");
  }

  const result = await store.createAdminUser({ username, password, role });
  if (result.error) {
    return sendApiError(res, 400, result.error);
  }

  return sendApiSuccess(res, {
    message: `Admin account '${username}' created.`,
    admin: result.admin,
  });
});

app.post(
  "/api/admin/users/:adminId/toggle-active",
  requireApiAdminPermission("admin-users:manage"),
  async (req, res) => {
    const adminId = req.params.adminId;
    const makeActive = String(req.body.makeActive || "").trim() === "1";

    if (req.session.admin.id === adminId && !makeActive) {
      return sendApiError(res, 400, "You cannot deactivate your own account while logged in.");
    }

    const updated = await store.setAdminActive(adminId, makeActive);
    if (!updated) {
      return sendApiError(res, 404, "Admin account not found.");
    }

    return sendApiSuccess(res, {
      message: `Admin account '${updated.username}' is now ${updated.isActive ? "active" : "inactive"}.`,
      admin: updated,
    });
  }
);

app.post("/api/admin/users/:adminId/role", requireApiAdminPermission("admin-users:manage"), async (req, res) => {
  const adminId = req.params.adminId;
  const role = String(req.body.role || "").trim();

  if (!ROLE_PERMISSIONS[role]) {
    return sendApiError(res, 400, "Invalid role value.");
  }

  const updated = await store.updateAdminRole(adminId, role);
  if (!updated) {
    return sendApiError(res, 404, "Admin account not found.");
  }

  if (req.session.admin.id === updated.id) {
    req.session.admin.role = updated.role;
  }

  return sendApiSuccess(res, {
    message: `Role updated for '${updated.username}' to ${updated.role}.`,
    admin: updated,
  });
});

app.post("/api/admin/users/:adminId/password", requireApiAdminPermission("admin-users:manage"), async (req, res) => {
  const adminId = req.params.adminId;
  const password = String(req.body.password || "");

  const result = await store.resetAdminPassword(adminId, password);
  if (result.error) {
    return sendApiError(res, 400, result.error);
  }

  return sendApiSuccess(res, {
    message: `Password reset for '${result.admin.username}'.`,
    admin: result.admin,
  });
});

app.get("/api/admin/payments", requireApiAdminPermission("payments:view"), async (req, res) => {
  const status = textField(req.query.status);
  const q = textField(req.query.q);

  return sendApiSuccess(res, {
    filters: { status, q },
    currentAdmin: req.session.admin,
    canManageAdmins: hasPermission(req.session.admin, "admin-users:manage"),
    canWrite: hasPermission(req.session.admin, "payments:write"),
    canReconcile: hasPermission(req.session.admin, "payments:reconcile"),
    invoices: await store.listInvoicesForAdmin({ status, q }),
    transactions: await store.listRecentPaymentTransactions(100),
    audits: await store.listRecentAuditLogs(100),
    reconciliation: await store.getReconciliationReport(),
  });
});

// Lets finance staff open the exact invoice/receipt the applicant sees.
app.get("/api/admin/invoices/:invoiceNumber/pdf", requireApiAdminPermission("payments:view"), async (req, res) => {
  const invoice = await store.getInvoiceByNumber(req.params.invoiceNumber);
  if (!invoice) {
    return sendApiError(res, 404, "Invoice not found.");
  }
  return sendInvoicePdf(res, invoice, { inline: true });
});

app.post("/api/admin/reconcile", requireApiAdminPermission("payments:reconcile"), async (req, res) => {
  const result = await store.autoReconcileInvoices(req.session.admin.username, adminActorLabel(req.session.admin));
  return sendApiSuccess(res, {
    message: `Reconciliation complete: ${result.updated} updated, ${result.mismatches} mismatch(es) detected, ${result.paidWithoutTx} paid-without-tx.`,
    result,
  });
});

app.post(
  "/api/admin/invoices/:invoiceNumber/override",
  requireApiAdminPermission("payments:write"),
  async (req, res) => {
    const invoiceNumber = req.params.invoiceNumber;
    const { values, error } = parseOverrideRequest(req.body || {});
    if (error) {
      return sendApiError(res, 400, error);
    }
    const { status, paymentReference, paymentProvider, note } = values;

    const updated = await store.manualOverrideInvoice({
      invoiceNumber,
      status,
      paymentReference,
      paymentProvider: paymentProvider || (status === "Paid" ? "manual" : null),
      actorId: req.session.admin.username,
      actorLabel: adminActorLabel(req.session.admin),
      note,
      metadata: { adminId: req.session.admin.id, role: req.session.admin.role },
    });

    if (!updated) {
      return sendApiError(res, 404, "Invoice not found for manual override.");
    }

    return sendApiSuccess(res, {
      message: `Manual override completed for ${invoiceNumber}.`,
      invoice: updated,
    });
  }
);

app.get("/", servePage);

app.get("/register", async (req, res) => {
  return servePage(req, res);
});

app.post("/register", async (req, res) => {
  const { values, error } = validateRegistration(req.body || {});
  if (error) {
    req.session.message = error;
    return res.redirect("/register");
  }
  const { surname, otherNames, email, phone, password } = values;

  if (await store.getUserByEmail(email)) {
    req.session.message = "An account with this email already exists.";
    return res.redirect("/register");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  let user;
  try {
    user = await store.createUser({ surname, otherNames, email, phone, passwordHash });
  } catch (error) {
    if (error.code !== "DUPLICATE_EMAIL" && error.errcode !== 2067) throw error;
    req.session.message = "An account with this email already exists.";
    return res.redirect("/register");
  }

  await startSession(req, "user", studentSessionFor(user));
  req.session.message = "Account created successfully.";

  return res.redirect("/pre-application");
});

app.get("/login", async (req, res) => {
  return servePage(req, res);
});

app.post("/login", async (req, res) => {
  const email = textField(req.body?.email);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const user = email ? await store.getUserByEmail(email) : null;

  if (!user) {
    req.session.message = "Invalid email or password.";
    return res.redirect("/login");
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    req.session.message = "Invalid email or password.";
    return res.redirect("/login");
  }

  await startSession(req, "user", studentSessionFor(user));
  req.session.message = "Welcome back.";

  return res.redirect("/dashboard");
});

app.post("/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.redirect("/");
  });
});

app.get("/pre-application", requireAuth, async (req, res) => {
  return servePage(req, res);
});

app.post("/pre-application", requireAuth, async (req, res) => {
  const { values, error } = await validatePreApplication(req.body || {});
  if (error) {
    req.session.message = error;
    return res.redirect("/pre-application");
  }

  const saved = await store.createOrUpdateApplication({
    userId: req.session.user.id,
    ...values,
  });
  if (saved.error) {
    req.session.message = saved.error;
    return res.redirect("/dashboard");
  }

  req.session.message = "Pre-application saved successfully.";
  return res.redirect("/invoice/create");
});

app.get("/invoice/create", requireAuth, async (req, res) => {
  const application = await store.getApplicationByUserId(req.session.user.id);
  if (!application) {
    req.session.message = "Please complete pre-application first.";
    return res.redirect("/pre-application");
  }

  const existingInvoice = await store.getLatestInvoiceByUserId(req.session.user.id);
  if (existingInvoice) {
    return res.redirect(`/invoice/${existingInvoice.invoiceNumber}`);
  }

  const invoice = await store.createInvoice({
    userId: req.session.user.id,
    ...await applicationFee(),
  });

  req.session.message = "Invoice generated.";
  return res.redirect(`/invoice/${invoice.invoiceNumber}`);
});

app.get("/invoice/:invoiceNumber", requireAuth, async (req, res) => {
  const invoice = await store.getInvoiceByNumber(req.params.invoiceNumber);
  if (!invoice || invoice.userId !== req.session.user.id) {
    req.session.message = "Invoice not found.";
    return res.redirect("/dashboard");
  }

  return servePage(req, res);
});

app.post("/invoice/:invoiceNumber/pay", async (req, res) => {
  return res.status(403).send(SELF_PAY_FORBIDDEN_MESSAGE);
});

app.get("/payments/callback", async (req, res) => {
  const reference = typeof req.query.reference === "string" ? req.query.reference : "";
  if (!PAYSTACK_SECRET_KEY || !reference) return res.redirect("/dashboard?payment=not-confirmed");

  try {
    const transaction = await paystackClient.verifyTransaction(reference);
    if (transaction.reference !== reference) throw new Error("Paystack returned a different transaction reference.");
    const result = await webhookProcessor.processVerifiedPaystackTransaction(transaction);
    let metadata = transaction.metadata && typeof transaction.metadata === "object"
      ? transaction.metadata
      : {};
    if (typeof transaction.metadata === "string") {
      try {
        metadata = JSON.parse(transaction.metadata);
      } catch {
        metadata = {};
      }
    }
    const invoiceNumber = typeof metadata.invoiceNumber === "string" ? metadata.invoiceNumber : "";
    const invoice = invoiceNumber ? await store.getInvoiceByNumber(invoiceNumber) : null;
    if (!invoice || invoice.userId !== req.session.user?.id) return res.redirect("/login");
    const payment = result.outcome === "marked_paid" || result.outcome === "already_paid"
      ? "success"
      : "pending";
    return res.redirect(`/invoice/${encodeURIComponent(invoice.invoiceNumber)}?payment=${payment}`);
  } catch (error) {
    console.error("Paystack callback verification failed.", error);
    return res.redirect("/dashboard?payment=verification-failed");
  }
});

app.get("/admin/login", async (req, res) => {
  return servePage(req, res);
});

app.post("/admin/login", async (req, res) => {
  const username = textField(req.body?.username);
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  const admin = username ? await store.getAdminByUsername(username) : null;
  if (!admin) {
    req.session.message = "Invalid admin credentials.";
    return res.redirect("/admin/login");
  }

  const ok = bcrypt.compareSync(password, admin.passwordHash);
  if (!ok) {
    req.session.message = "Invalid admin credentials.";
    return res.redirect("/admin/login");
  }

  await startSession(req, "admin", buildAdminSession(admin));

  if (req.session.admin.mustChangePassword) {
    req.session.message = "Password update required before you can access admin tools.";
    return res.redirect("/admin/change-password");
  }

  req.session.message = "Admin login successful.";
  return res.redirect("/admin/payments");
});

app.get("/admin/change-password", requireAdminSession, async (req, res) => {
  return servePage(req, res);
});

app.post("/admin/change-password", requireAdminSession, async (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  const confirmPassword = String(req.body.confirmPassword || "");

  if (!newPassword || !confirmPassword || !currentPassword) {
    req.session.message = "All password fields are required.";
    return res.redirect("/admin/change-password");
  }

  if (newPassword !== confirmPassword) {
    req.session.message = "New password and confirmation do not match.";
    return res.redirect("/admin/change-password");
  }

  const result = await store.changeOwnAdminPassword({
    adminId: req.session.admin.id,
    currentPassword,
    newPassword,
  });

  if (result.error) {
    req.session.message = result.error;
    return res.redirect("/admin/change-password");
  }

  req.session.admin.mustChangePassword = false;
  req.session.admin.passwordExpiresAt = result.admin.passwordExpiresAt || null;
  req.session.message = "Password changed successfully.";
  return res.redirect("/admin/payments");
});

app.post("/admin/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    return res.redirect("/admin/login");
  });
});

app.get("/admin/users", requireAdminPermission("admin-users:manage"), async (req, res) => {
  return servePage(req, res);
});

app.get("/admin/institution", requireAdminPermission("admin-users:manage"), async (req, res) => {
  return servePage(req, res);
});

app.get("/admin/sis", requireAdminPermission("sis:manage"), async (req, res) => {
  return servePage(req, res);
});

app.get("/admin/courses", requireAdminPermission("sis:manage"), async (req, res) => {
  return servePage(req, res);
});

app.get("/admin/results", requireAdminPermission("sis:manage"), async (req, res) => {
  return servePage(req, res);
});

app.get("/admin/student-fees", requireAdminPermission("student-fees:manage"), async (req, res) => {
  return servePage(req, res);
});

app.get("/admin/attendance", requireAdminPermission("sis:manage"), async (req, res) => {
  return servePage(req, res);
});

app.get("/admin/reports", requireAdminPermission("sis:manage"), async (req, res) => {
  return servePage(req, res);
});

app.post("/admin/users", requireAdminPermission("admin-users:manage"), async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "").trim();

  if (!ROLE_PERMISSIONS[role]) {
    req.session.message = "Invalid admin role selected.";
    return res.redirect("/admin/users");
  }

  const result = await store.createAdminUser({ username, password, role });
  if (result.error) {
    req.session.message = result.error;
    return res.redirect("/admin/users");
  }

  req.session.message = `Admin account '${username}' created.`;
  return res.redirect("/admin/users");
});

app.post("/admin/users/:adminId/toggle-active", requireAdminPermission("admin-users:manage"), async (req, res) => {
  const adminId = req.params.adminId;
  const makeActive = String(req.body.makeActive || "").trim() === "1";

  if (req.session.admin.id === adminId && !makeActive) {
    req.session.message = "You cannot deactivate your own account while logged in.";
    return res.redirect("/admin/users");
  }

  const updated = await store.setAdminActive(adminId, makeActive);
  if (!updated) {
    req.session.message = "Admin account not found.";
    return res.redirect("/admin/users");
  }

  req.session.message = `Admin account '${updated.username}' is now ${updated.isActive ? "active" : "inactive"}.`;
  return res.redirect("/admin/users");
});

app.post("/admin/users/:adminId/role", requireAdminPermission("admin-users:manage"), async (req, res) => {
  const adminId = req.params.adminId;
  const role = String(req.body.role || "").trim();

  if (!ROLE_PERMISSIONS[role]) {
    req.session.message = "Invalid role value.";
    return res.redirect("/admin/users");
  }

  const updated = await store.updateAdminRole(adminId, role);
  if (!updated) {
    req.session.message = "Admin account not found.";
    return res.redirect("/admin/users");
  }

  if (req.session.admin.id === updated.id) {
    req.session.admin.role = updated.role;
  }

  req.session.message = `Role updated for '${updated.username}' to ${updated.role}.`;
  return res.redirect("/admin/users");
});

app.post("/admin/users/:adminId/password", requireAdminPermission("admin-users:manage"), async (req, res) => {
  const adminId = req.params.adminId;
  const password = String(req.body.password || "");

  const result = await store.resetAdminPassword(adminId, password);
  if (result.error) {
    req.session.message = result.error;
    return res.redirect("/admin/users");
  }

  req.session.message = `Password reset for '${result.admin.username}'.`;
  return res.redirect("/admin/users");
});

app.get("/admin/payments", requireAdmin, async (req, res) => {
  if (!hasPermission(req.session.admin, "payments:view")) {
    req.session.message = "You do not have permission to view payments.";
    return res.redirect("/");
  }

  return servePage(req, res);
});

app.get("/admin/payments/export.csv", requireAdminPermission("payments:view"), async (req, res) => {
  const status = textField(req.query.status);
  const q = textField(req.query.q);
  const rows = await store.listReconciliationRows({ status, q });

  const headers = [
    { key: "invoiceNumber", label: "invoice_number" },
    { key: "applicantSurname", label: "applicant_surname" },
    { key: "applicantOtherNames", label: "applicant_other_names" },
    { key: "applicantEmail", label: "applicant_email" },
    { key: "amount", label: "amount" },
    { key: "currency", label: "currency" },
    { key: "paymentStatus", label: "payment_status" },
    { key: "paymentReference", label: "payment_reference" },
    { key: "paymentProvider", label: "payment_provider" },
    { key: "paidAt", label: "paid_at" },
    { key: "latestSuccessReference", label: "latest_signed_success_reference" },
    { key: "latestSuccessProvider", label: "latest_signed_success_provider" },
    { key: "latestSuccessAt", label: "latest_signed_success_at" },
    { key: "reconciliationFlag", label: "reconciliation_flag" },
    { key: "createdAt", label: "created_at" },
    { key: "updatedAt", label: "updated_at" },
  ];

  const csv = rowsToCsv(rows, headers);
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `payments-reconciliation-${now}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=\"${fileName}\"`);
  return res.status(200).send(csv);
});

app.post("/admin/invoices/:invoiceNumber/override", requireAdminPermission("payments:write"), async (req, res) => {
  const invoiceNumber = req.params.invoiceNumber;
  const { values, error } = parseOverrideRequest(req.body || {});
  if (error) {
    req.session.message = error;
    return res.redirect("/admin/payments");
  }
  const { status, paymentReference, paymentProvider, note } = values;

  const updated = await store.manualOverrideInvoice({
    invoiceNumber,
    status,
    paymentReference,
    paymentProvider: paymentProvider || (status === "Paid" ? "manual" : null),
    actorId: req.session.admin.username,
    actorLabel: adminActorLabel(req.session.admin),
    note,
    metadata: { adminId: req.session.admin.id, role: req.session.admin.role },
  });

  if (!updated) {
    req.session.message = "Invoice not found for manual override.";
    return res.redirect("/admin/payments");
  }

  req.session.message = `Manual override completed for ${invoiceNumber}.`;
  return res.redirect("/admin/payments");
});

app.post("/admin/reconcile", requireAdmin, async (req, res) => {
  if (!hasPermission(req.session.admin, "payments:reconcile")) {
    req.session.message = "You do not have permission to reconcile payments.";
    return res.redirect("/admin/payments");
  }

  const result = await store.autoReconcileInvoices(req.session.admin.username, adminActorLabel(req.session.admin));
  req.session.message = `Reconciliation complete: ${result.updated} updated, ${result.mismatches} mismatch(es) detected, ${result.paidWithoutTx} paid-without-tx.`;
  return res.redirect("/admin/payments");
});

app.get("/dashboard", requireAuth, async (req, res) => {
  return servePage(req, res);
});

app.get("/courses", requireAuth, async (req, res) => {
  return servePage(req, res);
});

app.get("/results", requireAuth, async (req, res) => {
  return servePage(req, res);
});

app.get("/fees", requireAuth, async (req, res) => {
  return servePage(req, res);
});

app.get("/attendance", requireAuth, async (req, res) => {
  return servePage(req, res);
});

// Unknown API routes answer in JSON (the frontend expects JSON from /api).
app.use("/api", async (req, res) => sendApiError(res, 404, "API endpoint not found."));

app.use(express.static(REACT_DIST_DIR));

app.get(/.*/, (req, res, next) => {
  if (REACT_PUBLIC_ROUTES.has(req.path)) {
    return serveReactApp(req, res, next);
  }
  return next();
});

// Error handler: malformed JSON bodies become a clean 400, anything unexpected a
// 500 without a stack trace (the stack is logged on the server instead).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.type === "entity.parse.failed" ? 400
    : err.type === "entity.too.large" ? 413
      : 500;
  const message = status === 400 ? "Malformed request body."
    : status === 413 ? "Request body is too large."
      : "Something went wrong. Please try again.";
  if (status === 500) {
    console.error(err);
  }
  if (req.path.startsWith("/api/")) {
    return sendApiError(res, status, message);
  }
  return res.status(status).type("text/plain").send(message);
});

async function start() {
  await store.ensureSeed({
    defaultAdminUsername: ADMIN_USERNAME,
    defaultAdminPassword: ADMIN_PASSWORD,
  });
  app.listen(PORT, () => {
  if (LOADED_ENV_FILE) {
    console.log(`Loaded settings from ${path.relative(process.cwd(), LOADED_ENV_FILE) || LOADED_ENV_FILE}`);
  }
  const paymentMode = MOCK_GATEWAY_ENABLED ? "local test mode" : PAYSTACK_SECRET_KEY ? "Paystack hosted checkout" : "unavailable";
  console.log(`Application fee: ${APPLICATION_FEE_CURRENCY} ${APPLICATION_FEE_AMOUNT.toFixed(2)}; payment mode: ${paymentMode}`);
  if (reactBuildExists()) {
    console.log(`Unified mode (React + admissions backend) running on http://127.0.0.1:${PORT}`);
  } else {
    console.log(
      `Admissions API running on http://127.0.0.1:${PORT} ` +
        "(no React build here: open the Vite dev server, http://localhost:5173, or run `npm run build`)"
    );
  }
  });
}
start().catch((error) => { console.error(error); process.exitCode = 1; });
