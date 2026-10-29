const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const store = require("./src/data/store");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "AdminPass123!";
const applicationFeeAmountSetting = process.env.APPLICATION_FEE_AMOUNT;
if (
  process.env.NODE_ENV === "production" &&
  (!applicationFeeAmountSetting || !applicationFeeAmountSetting.trim())
) {
  throw new Error("Set APPLICATION_FEE_AMOUNT before starting the production server (use 0 for free applications).");
}
if (applicationFeeAmountSetting != null && !applicationFeeAmountSetting.trim()) {
  throw new Error("APPLICATION_FEE_AMOUNT must be a non-negative number.");
}
const APPLICATION_FEE_AMOUNT = applicationFeeAmountSetting == null
  ? 0
  : Number(applicationFeeAmountSetting);
if (!Number.isFinite(APPLICATION_FEE_AMOUNT) || APPLICATION_FEE_AMOUNT < 0) {
  throw new Error("APPLICATION_FEE_AMOUNT must be a non-negative number.");
}
const APPLICATION_FEE_CURRENCY = String(process.env.APPLICATION_FEE_CURRENCY || "USD")
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
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || "change-me-webhook-secret";
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

store.ensureSeed({
  defaultAdminUsername: ADMIN_USERNAME,
  defaultAdminPassword: ADMIN_PASSWORD,
});

const ROLE_PERMISSIONS = {
  super_admin: ["payments:view", "payments:write", "payments:reconcile", "admin-users:manage"],
  finance_admin: ["payments:view", "payments:write", "payments:reconcile"],
  auditor: ["payments:view"],
};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
    resave: false,
    saveUninitialized: false,
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

function requireAdminSession(req, res, next) {
  if (!req.session.admin) {
    req.session.message = "Admin login required.";
    return res.redirect("/admin/login");
  }

  return next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    req.session.message = "Admin login required.";
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
  return (req, res, next) => {
    if (!req.session.admin) {
      req.session.message = "Admin login required.";
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

function requireApiAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.status(401).json({
      ok: false,
      message: "Admin login required.",
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

function requireApiAdminSession(req, res, next) {
  if (!req.session.admin) {
    return res.status(401).json({
      ok: false,
      message: "Admin login required.",
    });
  }

  return next();
}

function requireApiAdminPermission(permission) {
  return (req, res, next) => {
    if (!req.session.admin) {
      return res.status(401).json({
        ok: false,
        message: "Admin login required.",
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
  const text = String(value == null ? "" : value);
  const escaped = text.replace(/"/g, '""');
  return `"${escaped}"`;
}

function rowsToCsv(rows, headers) {
  const headerRow = headers.map((h) => escapeCsvValue(h.label)).join(",");
  const dataRows = rows.map((row) => headers.map((h) => escapeCsvValue(row[h.key])).join(","));
  return [headerRow, ...dataRows].join("\n");
}

function safeCompareHex(signatureA, signatureB) {
  try {
    const a = Buffer.from(String(signatureA || ""), "hex");
    const b = Buffer.from(String(signatureB || ""), "hex");
    if (a.length === 0 || b.length === 0 || a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function detectWebhookProvider(headers) {
  if (headers["x-paystack-signature"]) return "paystack";
  if (headers["verif-hash"] || headers["x-flutterwave-signature"]) return "flutterwave";
  return "unknown";
}

function verifyWebhookSignature(provider, headers, rawBodyBuffer) {
  if (!PAYMENT_WEBHOOK_SECRET) {
    return false;
  }

  if (provider === "paystack") {
    const signature = headers["x-paystack-signature"];
    const expected = crypto
      .createHmac("sha512", PAYMENT_WEBHOOK_SECRET)
      .update(rawBodyBuffer)
      .digest("hex");
    return safeCompareHex(signature, expected);
  }

  if (provider === "flutterwave") {
    const signature = headers["verif-hash"] || headers["x-flutterwave-signature"];
    return String(signature || "") === PAYMENT_WEBHOOK_SECRET;
  }

  return false;
}

function parseWebhookPayload(provider, payload) {
  const data = payload && payload.data ? payload.data : {};
  const eventType = payload.event || payload.type || "unknown";
  let invoiceNumber = null;
  let gatewayStatus = "unknown";
  let gatewayReference = null;
  let amount = null;
  let currency = null;

  if (provider === "paystack") {
    invoiceNumber =
      data?.metadata?.invoiceNumber ||
      data?.metadata?.invoice_number ||
      data?.invoice_number ||
      null;
    gatewayStatus = data?.status || payload?.status || (eventType === "charge.success" ? "success" : "unknown");
    gatewayReference = data?.reference || data?.tx_ref || null;
    amount = typeof data?.amount === "number" ? data.amount / 100 : null;
    currency = data?.currency || null;
  } else if (provider === "flutterwave") {
    invoiceNumber =
      data?.meta?.invoiceNumber ||
      data?.meta?.invoice_number ||
      data?.invoice_number ||
      payload?.invoiceNumber ||
      null;
    gatewayStatus = data?.status || payload?.status || "unknown";
    gatewayReference = data?.tx_ref || data?.flw_ref || payload?.reference || null;
    amount = data?.amount == null ? null : Number(data.amount);
    currency = data?.currency || payload?.currency || null;
  }

  return {
    eventType,
    invoiceNumber,
    gatewayStatus,
    gatewayReference,
    amount,
    currency,
  };
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

function reactBuildExists() {
  return fs.existsSync(REACT_INDEX_FILE);
}

function serveReactApp(req, res, next) {
  if (!reactBuildExists()) {
    return next();
  }
  return res.sendFile(REACT_INDEX_FILE);
}

app.get("/api/auth/session", (req, res) => {
  return sendApiSuccess(res, {
    user: req.session.user || null,
    admin: req.session.admin || null,
  });
});

app.post("/api/auth/register", async (req, res) => {
  const { surname, otherNames, email, phone, password } = req.body || {};

  if (!surname || !otherNames || !email || !phone || !password) {
    return sendApiError(res, 400, "All registration fields are required.");
  }

  if (store.getUserByEmail(email)) {
    return sendApiError(res, 409, "An account with this email already exists.");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = store.createUser({ surname, otherNames, email, phone, passwordHash });

  req.session.user = {
    id: user.id,
    surname: user.surname,
    otherNames: user.otherNames,
    email: user.email,
  };

  return sendApiSuccess(res, {
    message: "Account created successfully.",
    user: req.session.user,
    next: "/pre-application",
  });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = store.getUserByEmail(email);

  if (!user) {
    return sendApiError(res, 401, "Invalid email or password.");
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return sendApiError(res, 401, "Invalid email or password.");
  }

  req.session.user = {
    id: user.id,
    surname: user.surname,
    otherNames: user.otherNames,
    email: user.email,
  };

  return sendApiSuccess(res, {
    message: "Welcome back.",
    user: req.session.user,
    next: "/dashboard",
  });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.status(200).json({ ok: true, message: "Logged out." });
  });
});

app.get("/api/programs", requireApiAuth, (req, res) => {
  return sendApiSuccess(res, {
    programs: store.listPrograms(),
  });
});

app.get("/api/pre-application", requireApiAuth, (req, res) => {
  return sendApiSuccess(res, {
    programs: store.listPrograms(),
    previous: store.getApplicationByUserId(req.session.user.id),
  });
});

app.post("/api/pre-application", requireApiAuth, (req, res) => {
  const { programId, modeOfStudy, previousInstitution, notes } = req.body || {};

  if (!programId || !modeOfStudy || !previousInstitution) {
    return sendApiError(res, 400, "Program, mode of study, and previous institution are required.");
  }

  const selectedProgram = store.getProgramById(programId);
  if (!selectedProgram) {
    return sendApiError(res, 400, "Selected program is invalid.");
  }

  store.createOrUpdateApplication({
    userId: req.session.user.id,
    programId,
    modeOfStudy,
    previousInstitution,
    notes: notes || "",
  });

  return sendApiSuccess(res, {
    message: "Pre-application saved successfully.",
    next: "/invoice/create",
  });
});

app.post("/api/invoice/create", requireApiAuth, (req, res) => {
  const application = store.getApplicationByUserId(req.session.user.id);
  if (!application) {
    return sendApiError(res, 400, "Please complete pre-application first.", { next: "/pre-application" });
  }

  const existingInvoice = store.getLatestInvoiceByUserId(req.session.user.id);
  if (existingInvoice) {
    return sendApiSuccess(res, {
      invoice: existingInvoice,
      next: `/invoice/${existingInvoice.invoiceNumber}`,
    });
  }

  const invoice = store.createInvoice({
    userId: req.session.user.id,
    amount: APPLICATION_FEE_AMOUNT,
    feeDescription: APPLICATION_FEE_DESCRIPTION,
    currency: APPLICATION_FEE_CURRENCY,
  });

  return sendApiSuccess(res, {
    invoice,
    message: "Invoice generated.",
    next: `/invoice/${invoice.invoiceNumber}`,
  });
});

app.get("/api/invoice/:invoiceNumber", requireApiAuth, (req, res) => {
  const invoice = store.getInvoiceByNumber(req.params.invoiceNumber);
  if (!invoice || invoice.userId !== req.session.user.id) {
    return sendApiError(res, 404, "Invoice not found.");
  }

  const user = store.getUserById(req.session.user.id);
  const application = store.getApplicationByUserId(req.session.user.id);
  const program = application ? store.getProgramById(application.programId) : null;

  return sendApiSuccess(res, {
    invoice,
    user,
    application,
    program,
  });
});

app.post("/api/invoice/:invoiceNumber/pay", requireApiAuth, (req, res) => {
  const invoice = store.getInvoiceByNumber(req.params.invoiceNumber);
  if (!invoice || invoice.userId !== req.session.user.id) {
    return sendApiError(res, 404, "Invoice not found.");
  }

  if (invoice.paymentStatus === "Paid") {
    return sendApiError(res, 400, "This invoice has already been paid.", {
      next: `/invoice/${invoice.invoiceNumber}`,
    });
  }

  const reference = `MOCK-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`;
  store.recordPaymentTransaction({
    invoiceNumber: invoice.invoiceNumber,
    userId: invoice.userId,
    provider: "mock",
    eventType: "mock.charge.success",
    gatewayStatus: "success",
    gatewayReference: reference,
    amount: invoice.amount,
    currency: invoice.currency,
    signatureValid: true,
    payload: {
      invoiceNumber: invoice.invoiceNumber,
      reference,
    },
    processingNote: "Local mock payment completed.",
    processedAt: new Date().toISOString(),
  });

  const updated = store.markInvoicePaid(invoice.invoiceNumber, reference, {
    paymentProvider: "mock",
    actorType: "user",
    actorId: req.session.user.id,
    action: "mock_payment",
    note: "Invoice paid via local mock action.",
  });

  return sendApiSuccess(res, {
    message: `Payment successful. Reference: ${reference}`,
    invoice: updated,
    next: "/dashboard",
  });
});

app.get("/api/dashboard", requireApiAuth, (req, res) => {
  return sendApiSuccess(res, {
    snapshot: store.getDashboardByUserId(req.session.user.id),
  });
});

app.get("/api/admin/session", (req, res) => {
  return sendApiSuccess(res, {
    admin: req.session.admin || null,
  });
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};

  const admin = store.getAdminByUsername(username);
  if (!admin) {
    return sendApiError(res, 401, "Invalid admin credentials.");
  }

  const ok = bcrypt.compareSync(String(password || ""), admin.passwordHash);
  if (!ok) {
    return sendApiError(res, 401, "Invalid admin credentials.");
  }

  req.session.admin = buildAdminSession(admin);

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

app.post("/api/admin/logout", (req, res) => {
  delete req.session.admin;
  return sendApiSuccess(res, { message: "Admin logged out." });
});

app.post("/api/admin/change-password", requireApiAdminSession, (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  const confirmPassword = String(req.body.confirmPassword || "");

  if (!newPassword || !confirmPassword || !currentPassword) {
    return sendApiError(res, 400, "All password fields are required.");
  }

  if (newPassword !== confirmPassword) {
    return sendApiError(res, 400, "New password and confirmation do not match.");
  }

  const result = store.changeOwnAdminPassword({
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

app.get("/api/admin/users", requireApiAdminPermission("admin-users:manage"), (req, res) => {
  return sendApiSuccess(res, {
    currentAdmin: req.session.admin,
    roles: Object.keys(ROLE_PERMISSIONS),
    admins: store.listAdminUsers(),
  });
});

app.post("/api/admin/users", requireApiAdminPermission("admin-users:manage"), (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "").trim();

  if (!ROLE_PERMISSIONS[role]) {
    return sendApiError(res, 400, "Invalid admin role selected.");
  }

  const result = store.createAdminUser({ username, password, role });
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
  (req, res) => {
    const adminId = req.params.adminId;
    const makeActive = String(req.body.makeActive || "").trim() === "1";

    if (req.session.admin.id === adminId && !makeActive) {
      return sendApiError(res, 400, "You cannot deactivate your own account while logged in.");
    }

    const updated = store.setAdminActive(adminId, makeActive);
    if (!updated) {
      return sendApiError(res, 404, "Admin account not found.");
    }

    return sendApiSuccess(res, {
      message: `Admin account '${updated.username}' is now ${updated.isActive ? "active" : "inactive"}.`,
      admin: updated,
    });
  }
);

app.post("/api/admin/users/:adminId/role", requireApiAdminPermission("admin-users:manage"), (req, res) => {
  const adminId = req.params.adminId;
  const role = String(req.body.role || "").trim();

  if (!ROLE_PERMISSIONS[role]) {
    return sendApiError(res, 400, "Invalid role value.");
  }

  const updated = store.updateAdminRole(adminId, role);
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

app.post("/api/admin/users/:adminId/password", requireApiAdminPermission("admin-users:manage"), (req, res) => {
  const adminId = req.params.adminId;
  const password = String(req.body.password || "");

  const result = store.resetAdminPassword(adminId, password);
  if (result.error) {
    return sendApiError(res, 400, result.error);
  }

  return sendApiSuccess(res, {
    message: `Password reset for '${result.admin.username}'.`,
    admin: result.admin,
  });
});

app.get("/api/admin/payments", requireApiAdminPermission("payments:view"), (req, res) => {
  const status = String(req.query.status || "").trim();
  const q = String(req.query.q || "").trim();

  return sendApiSuccess(res, {
    filters: { status, q },
    currentAdmin: req.session.admin,
    canManageAdmins: hasPermission(req.session.admin, "admin-users:manage"),
    canWrite: hasPermission(req.session.admin, "payments:write"),
    canReconcile: hasPermission(req.session.admin, "payments:reconcile"),
    invoices: store.listInvoicesForAdmin({ status, q }),
    transactions: store.listRecentPaymentTransactions(100),
    audits: store.listRecentAuditLogs(100),
    reconciliation: store.getReconciliationReport(),
  });
});

app.post("/api/admin/reconcile", requireApiAdminPermission("payments:reconcile"), (req, res) => {
  const result = store.autoReconcileInvoices(req.session.admin.username);
  return sendApiSuccess(res, {
    message: `Reconciliation complete: ${result.updated} updated, ${result.mismatches} mismatch(es) detected, ${result.paidWithoutTx} paid-without-tx.`,
    result,
  });
});

app.post(
  "/api/admin/invoices/:invoiceNumber/override",
  requireApiAdminPermission("payments:write"),
  (req, res) => {
    const invoiceNumber = req.params.invoiceNumber;
    const status = String(req.body.status || "").trim();
    const paymentReference = String(req.body.paymentReference || "").trim() || null;
    const paymentProvider = String(req.body.paymentProvider || "").trim() || null;
    const note = String(req.body.note || "").trim() || null;
    const allowed = ["Paid", "Unpaid", "Pending", "Failed"];

    if (!allowed.includes(status)) {
      return sendApiError(res, 400, "Invalid status selection for manual override.");
    }

    const updated = store.manualOverrideInvoice({
      invoiceNumber,
      status,
      paymentReference,
      paymentProvider,
      actorId: req.session.admin.username,
      note,
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

app.get("/", serveReactApp, (req, res) => {
  return res.status(503).send("React build not found. Run npm run unified:build.");
});

app.get("/register", (req, res) => {
  return serveReactApp(req, res, () => {
    return res.status(503).send("React build not found. Run npm run unified:build.");
  });
});

app.post("/register", async (req, res) => {
  const { surname, otherNames, email, phone, password } = req.body;

  if (!surname || !otherNames || !email || !phone || !password) {
    req.session.message = "All registration fields are required.";
    return res.redirect("/register");
  }

  if (store.getUserByEmail(email)) {
    req.session.message = "An account with this email already exists.";
    return res.redirect("/register");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = store.createUser({ surname, otherNames, email, phone, passwordHash });

  req.session.user = {
    id: user.id,
    surname: user.surname,
    otherNames: user.otherNames,
    email: user.email,
  };
  req.session.message = "Account created successfully.";

  return res.redirect("/pre-application");
});

app.get("/login", (req, res) => {
  return serveReactApp(req, res, () => {
    return res.status(503).send("React build not found. Run npm run unified:build.");
  });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = store.getUserByEmail(email);

  if (!user) {
    req.session.message = "Invalid email or password.";
    return res.redirect("/login");
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    req.session.message = "Invalid email or password.";
    return res.redirect("/login");
  }

  req.session.user = {
    id: user.id,
    surname: user.surname,
    otherNames: user.otherNames,
    email: user.email,
  };
  req.session.message = "Welcome back.";

  return res.redirect("/dashboard");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.get("/pre-application", requireAuth, (req, res) => {
  return serveReactApp(req, res, () => {
    return res.status(503).send("React build not found. Run npm run unified:build.");
  });
});

app.post("/pre-application", requireAuth, (req, res) => {
  const { programId, modeOfStudy, previousInstitution, notes } = req.body;

  if (!programId || !modeOfStudy || !previousInstitution) {
    req.session.message = "Program, mode of study, and previous institution are required.";
    return res.redirect("/pre-application");
  }

  const selectedProgram = store.getProgramById(programId);
  if (!selectedProgram) {
    req.session.message = "Selected program is invalid.";
    return res.redirect("/pre-application");
  }

  store.createOrUpdateApplication({
    userId: req.session.user.id,
    programId,
    modeOfStudy,
    previousInstitution,
    notes: notes || "",
  });

  req.session.message = "Pre-application saved successfully.";
  return res.redirect("/invoice/create");
});

app.get("/invoice/create", requireAuth, (req, res) => {
  const application = store.getApplicationByUserId(req.session.user.id);
  if (!application) {
    req.session.message = "Please complete pre-application first.";
    return res.redirect("/pre-application");
  }

  const existingInvoice = store.getLatestInvoiceByUserId(req.session.user.id);
  if (existingInvoice) {
    return res.redirect(`/invoice/${existingInvoice.invoiceNumber}`);
  }

  const invoice = store.createInvoice({
    userId: req.session.user.id,
    amount: APPLICATION_FEE_AMOUNT,
    feeDescription: APPLICATION_FEE_DESCRIPTION,
    currency: APPLICATION_FEE_CURRENCY,
  });

  req.session.message = "Invoice generated.";
  return res.redirect(`/invoice/${invoice.invoiceNumber}`);
});

app.get("/invoice/:invoiceNumber", requireAuth, (req, res) => {
  const invoice = store.getInvoiceByNumber(req.params.invoiceNumber);
  if (!invoice || invoice.userId !== req.session.user.id) {
    req.session.message = "Invoice not found.";
    return res.redirect("/dashboard");
  }

  return serveReactApp(req, res, () => {
    return res.status(503).send("React build not found. Run npm run unified:build.");
  });
});

app.post("/invoice/:invoiceNumber/pay", requireAuth, (req, res) => {
  const invoice = store.getInvoiceByNumber(req.params.invoiceNumber);
  if (!invoice || invoice.userId !== req.session.user.id) {
    req.session.message = "Invoice not found.";
    return res.redirect("/dashboard");
  }

  if (invoice.paymentStatus === "Paid") {
    req.session.message = "This invoice has already been paid.";
    return res.redirect(`/invoice/${invoice.invoiceNumber}`);
  }

  const reference = `MOCK-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`;
  store.recordPaymentTransaction({
    invoiceNumber: invoice.invoiceNumber,
    userId: invoice.userId,
    provider: "mock",
    eventType: "mock.charge.success",
    gatewayStatus: "success",
    gatewayReference: reference,
    amount: invoice.amount,
    currency: invoice.currency,
    signatureValid: true,
    payload: {
      invoiceNumber: invoice.invoiceNumber,
      reference,
    },
    processingNote: "Local mock payment completed.",
    processedAt: new Date().toISOString(),
  });

  store.markInvoicePaid(invoice.invoiceNumber, reference, {
    paymentProvider: "mock",
    actorType: "user",
    actorId: req.session.user.id,
    action: "mock_payment",
    note: "Invoice paid via local mock action.",
  });

  req.session.message = `Payment successful. Reference: ${reference}`;

  return res.redirect(`/invoice/${invoice.invoiceNumber}`);
});

app.post("/webhooks/payments", express.raw({ type: "application/json" }), (req, res) => {
  const provider = detectWebhookProvider(req.headers);
  const signatureValid = verifyWebhookSignature(provider, req.headers, req.body);

  let payload;
  try {
    payload = JSON.parse(Buffer.from(req.body).toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON payload.");
  }

  const parsed = parseWebhookPayload(provider, payload);
  const invoice = parsed.invoiceNumber ? store.getInvoiceByNumber(parsed.invoiceNumber) : null;

  store.recordPaymentTransaction({
    invoiceNumber: parsed.invoiceNumber,
    userId: invoice ? invoice.userId : null,
    provider,
    eventType: parsed.eventType,
    gatewayStatus: store.normalizeGatewayStatus(parsed.gatewayStatus),
    gatewayReference: parsed.gatewayReference,
    amount: parsed.amount,
    currency: parsed.currency,
    signatureValid,
    payload,
    processingNote: signatureValid ? "Webhook signature verified." : "Webhook signature verification failed.",
    processedAt: new Date().toISOString(),
  });

  if (!signatureValid) {
    return res.status(401).send("Invalid webhook signature.");
  }

  if (!invoice) {
    return res.status(202).send("Webhook accepted. Invoice not matched.");
  }

  if (store.isSuccessGatewayStatus(parsed.gatewayStatus)) {
    store.markInvoicePaid(invoice.invoiceNumber, parsed.gatewayReference || invoice.paymentReference || null, {
      paymentProvider: provider,
      actorType: "webhook",
      actorId: provider,
      action: "gateway_webhook_success",
      note: `Gateway webhook marked invoice as paid (${provider}).`,
      metadata: {
        eventType: parsed.eventType,
      },
    });
  }

  return res.status(200).send("Webhook accepted.");
});

app.get("/payments/callback", (req, res) => {
  return res
    .status(410)
    .send("Deprecated endpoint. Use signed POST webhook at /webhooks/payments.");
});

app.get("/admin/login", (req, res) => {
  return serveReactApp(req, res, () => {
    return res.status(503).send("React build not found. Run npm run unified:build.");
  });
});

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;

  const admin = store.getAdminByUsername(username);
  if (!admin) {
    req.session.message = "Invalid admin credentials.";
    return res.redirect("/admin/login");
  }

  const ok = bcrypt.compareSync(String(password || ""), admin.passwordHash);
  if (!ok) {
    req.session.message = "Invalid admin credentials.";
    return res.redirect("/admin/login");
  }

  req.session.admin = buildAdminSession(admin);

  if (req.session.admin.mustChangePassword) {
    req.session.message = "Password update required before you can access admin tools.";
    return res.redirect("/admin/change-password");
  }

  req.session.message = "Admin login successful.";
  return res.redirect("/admin/payments");
});

app.get("/admin/change-password", requireAdminSession, (req, res) => {
  return serveReactApp(req, res, () => {
    return res.status(503).send("React build not found. Run npm run unified:build.");
  });
});

app.post("/admin/change-password", requireAdminSession, (req, res) => {
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

  const result = store.changeOwnAdminPassword({
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

app.post("/admin/logout", (req, res) => {
  delete req.session.admin;
  req.session.message = "Admin logged out.";
  return res.redirect("/admin/login");
});

app.get("/admin/users", requireAdminPermission("admin-users:manage"), (req, res) => {
  return serveReactApp(req, res, () => {
    return res.status(503).send("React build not found. Run npm run unified:build.");
  });
});

app.post("/admin/users", requireAdminPermission("admin-users:manage"), (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "").trim();

  if (!ROLE_PERMISSIONS[role]) {
    req.session.message = "Invalid admin role selected.";
    return res.redirect("/admin/users");
  }

  const result = store.createAdminUser({ username, password, role });
  if (result.error) {
    req.session.message = result.error;
    return res.redirect("/admin/users");
  }

  req.session.message = `Admin account '${username}' created.`;
  return res.redirect("/admin/users");
});

app.post("/admin/users/:adminId/toggle-active", requireAdminPermission("admin-users:manage"), (req, res) => {
  const adminId = req.params.adminId;
  const makeActive = String(req.body.makeActive || "").trim() === "1";

  if (req.session.admin.id === adminId && !makeActive) {
    req.session.message = "You cannot deactivate your own account while logged in.";
    return res.redirect("/admin/users");
  }

  const updated = store.setAdminActive(adminId, makeActive);
  if (!updated) {
    req.session.message = "Admin account not found.";
    return res.redirect("/admin/users");
  }

  req.session.message = `Admin account '${updated.username}' is now ${updated.isActive ? "active" : "inactive"}.`;
  return res.redirect("/admin/users");
});

app.post("/admin/users/:adminId/role", requireAdminPermission("admin-users:manage"), (req, res) => {
  const adminId = req.params.adminId;
  const role = String(req.body.role || "").trim();

  if (!ROLE_PERMISSIONS[role]) {
    req.session.message = "Invalid role value.";
    return res.redirect("/admin/users");
  }

  const updated = store.updateAdminRole(adminId, role);
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

app.post("/admin/users/:adminId/password", requireAdminPermission("admin-users:manage"), (req, res) => {
  const adminId = req.params.adminId;
  const password = String(req.body.password || "");

  const result = store.resetAdminPassword(adminId, password);
  if (result.error) {
    req.session.message = result.error;
    return res.redirect("/admin/users");
  }

  req.session.message = `Password reset for '${result.admin.username}'.`;
  return res.redirect("/admin/users");
});

app.get("/admin/payments", requireAdmin, (req, res) => {
  if (!hasPermission(req.session.admin, "payments:view")) {
    req.session.message = "You do not have permission to view payments.";
    return res.redirect("/");
  }

  return serveReactApp(req, res, () => {
    return res.status(503).send("React build not found. Run npm run unified:build.");
  });
});

app.get("/admin/payments/export.csv", requireAdminPermission("payments:view"), (req, res) => {
  const status = String(req.query.status || "").trim();
  const q = String(req.query.q || "").trim();
  const rows = store.listReconciliationRows({ status, q });

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

app.post("/admin/invoices/:invoiceNumber/override", requireAdminPermission("payments:write"), (req, res) => {
  const invoiceNumber = req.params.invoiceNumber;
  const status = String(req.body.status || "").trim();
  const paymentReference = String(req.body.paymentReference || "").trim() || null;
  const paymentProvider = String(req.body.paymentProvider || "").trim() || null;
  const note = String(req.body.note || "").trim() || null;
  const allowed = ["Paid", "Unpaid", "Pending", "Failed"];

  if (!allowed.includes(status)) {
    req.session.message = "Invalid status selection for manual override.";
    return res.redirect("/admin/payments");
  }

  const updated = store.manualOverrideInvoice({
    invoiceNumber,
    status,
    paymentReference,
    paymentProvider,
    actorId: req.session.admin.username,
    note,
  });

  if (!updated) {
    req.session.message = "Invoice not found for manual override.";
    return res.redirect("/admin/payments");
  }

  req.session.message = `Manual override completed for ${invoiceNumber}.`;
  return res.redirect("/admin/payments");
});

app.post("/admin/reconcile", requireAdmin, (req, res) => {
  if (!hasPermission(req.session.admin, "payments:reconcile")) {
    req.session.message = "You do not have permission to reconcile payments.";
    return res.redirect("/admin/payments");
  }

  const result = store.autoReconcileInvoices(req.session.admin.username);
  req.session.message = `Reconciliation complete: ${result.updated} updated, ${result.mismatches} mismatch(es) detected, ${result.paidWithoutTx} paid-without-tx.`;
  return res.redirect("/admin/payments");
});

app.get("/dashboard", requireAuth, (req, res) => {
  return serveReactApp(req, res, () => {
    return res.status(503).send("React build not found. Run npm run unified:build.");
  });
});

app.use(express.static(REACT_DIST_DIR));

app.get(/.*/, (req, res, next) => {
  if (REACT_PUBLIC_ROUTES.has(req.path)) {
    return serveReactApp(req, res, next);
  }
  return next();
});

app.listen(PORT, () => {
  const mode = reactBuildExists() ? "Unified mode (React + admissions backend)" : "Backend-only mode";
  console.log(`${mode} running on http://127.0.0.1:${PORT}`);
});
