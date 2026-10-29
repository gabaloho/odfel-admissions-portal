const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = path.resolve(__dirname, "../../data/app.db");
const db = new DatabaseSync(DB_PATH);

const DEFAULT_PROGRAMS = [
  { id: "sample-program", name: "Sample Program (configure before launch)" }
];

function getConfiguredPrograms() {
  const configuredPrograms = process.env.PROGRAMS_JSON;
  if (!configuredPrograms) {
    return DEFAULT_PROGRAMS;
  }

  let programs;
  try {
    programs = JSON.parse(configuredPrograms);
  } catch {
    throw new Error("PROGRAMS_JSON must be a valid JSON array of program objects.");
  }

  if (
    !Array.isArray(programs) ||
    programs.length === 0 ||
    programs.some(
      (program) =>
        !program ||
        typeof program.id !== "string" ||
        !/^[a-z0-9][a-z0-9_-]*$/i.test(program.id) ||
        typeof program.name !== "string" ||
        !program.name.trim()
    ) ||
    new Set(programs.map((program) => program.id)).size !== programs.length
  ) {
    throw new Error(
      "PROGRAMS_JSON must contain unique program IDs and non-empty program names."
    );
  }

  return programs.map((program) => ({
    id: program.id.trim(),
    name: program.name.trim(),
  }));
}

const CONFIGURED_PROGRAMS = getConfiguredPrograms();

const SUCCESS_STATUSES = ["success", "successful", "completed", "paid"];
const ADMIN_PASSWORD_EXPIRY_DAYS = 90;

function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function validateAdminPasswordPolicy(password) {
  const value = String(password || "");
  if (value.length < 10) {
    return "Password must be at least 10 characters.";
  }
  if (!/[a-z]/.test(value)) {
    return "Password must include at least one lowercase letter.";
  }
  if (!/[A-Z]/.test(value)) {
    return "Password must include at least one uppercase letter.";
  }
  if (!/[0-9]/.test(value)) {
    return "Password must include at least one number.";
  }
  if (!/[^A-Za-z0-9]/.test(value)) {
    return "Password must include at least one special character.";
  }
  return null;
}

function ensureSeed(options = {}) {
  const defaultAdminUsername = String(options.defaultAdminUsername || "admin").trim();
  const defaultAdminPassword = String(options.defaultAdminPassword || "admin123");

  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      surname TEXT NOT NULL,
      other_names TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS programs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      program_id TEXT NOT NULL,
      mode_of_study TEXT NOT NULL,
      previous_institution TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (program_id) REFERENCES programs(id)
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      invoice_number TEXT NOT NULL UNIQUE,
      amount REAL NOT NULL,
      fee_description TEXT NOT NULL,
      currency TEXT NOT NULL,
      payment_status TEXT NOT NULL,
      payment_reference TEXT,
      payment_provider TEXT,
      paid_at TEXT,
      updated_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS payment_transactions (
      id TEXT PRIMARY KEY,
      invoice_number TEXT,
      user_id TEXT,
      provider TEXT NOT NULL,
      event_type TEXT,
      gateway_status TEXT,
      gateway_reference TEXT,
      amount REAL,
      currency TEXT,
      signature_valid INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      processing_note TEXT,
      received_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS payment_audit_logs (
      id TEXT PRIMARY KEY,
      invoice_number TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      before_status TEXT,
      after_status TEXT,
      note TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      password_changed_at TEXT,
      password_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Backward-compatible migration for earlier local DB versions.
  const invoiceCols = db.prepare("PRAGMA table_info(invoices)").all();
  const hasPaymentReference = invoiceCols.some((c) => c.name === "payment_reference");
  const hasPaymentProvider = invoiceCols.some((c) => c.name === "payment_provider");
  const hasPaidAt = invoiceCols.some((c) => c.name === "paid_at");
  const hasUpdatedAt = invoiceCols.some((c) => c.name === "updated_at");

  if (!hasPaymentReference) {
    db.exec("ALTER TABLE invoices ADD COLUMN payment_reference TEXT");
  }

  if (!hasPaidAt) {
    db.exec("ALTER TABLE invoices ADD COLUMN paid_at TEXT");
  }

  if (!hasPaymentProvider) {
    db.exec("ALTER TABLE invoices ADD COLUMN payment_provider TEXT");
  }

  if (!hasUpdatedAt) {
    db.exec("ALTER TABLE invoices ADD COLUMN updated_at TEXT");
  }

  const adminCols = db.prepare("PRAGMA table_info(admin_users)").all();
  const hasAdminActive = adminCols.some((c) => c.name === "is_active");
  const hasAdminMustChange = adminCols.some((c) => c.name === "must_change_password");
  const hasAdminPwdChangedAt = adminCols.some((c) => c.name === "password_changed_at");
  const hasAdminPwdExpiresAt = adminCols.some((c) => c.name === "password_expires_at");
  const hasAdminUpdatedAt = adminCols.some((c) => c.name === "updated_at");

  if (!hasAdminActive) {
    db.exec("ALTER TABLE admin_users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1");
  }

  if (!hasAdminMustChange) {
    db.exec("ALTER TABLE admin_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
  }

  if (!hasAdminPwdChangedAt) {
    db.exec("ALTER TABLE admin_users ADD COLUMN password_changed_at TEXT");
  }

  if (!hasAdminPwdExpiresAt) {
    db.exec("ALTER TABLE admin_users ADD COLUMN password_expires_at TEXT");
  }

  if (!hasAdminUpdatedAt) {
    db.exec("ALTER TABLE admin_users ADD COLUMN updated_at TEXT");
  }

  const row = db.prepare("SELECT COUNT(*) AS count FROM programs").get();
  if (!row || row.count === 0) {
    const insertProgram = db.prepare("INSERT INTO programs (id, name) VALUES (?, ?)");
    for (const program of CONFIGURED_PROGRAMS) {
      insertProgram.run(program.id, program.name);
    }
  }

  ensureDefaultAdmin(defaultAdminUsername, defaultAdminPassword);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    surname: row.surname,
    otherNames: row.other_names,
    email: row.email,
    phone: row.phone,
    passwordHash: row.password_hash,
    createdAt: row.created_at
  };
}

function toProgram(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name
  };
}

function toApplication(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    programId: row.program_id,
    modeOfStudy: row.mode_of_study,
    previousInstitution: row.previous_institution,
    notes: row.notes || "",
    status: row.status,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at
  };
}

function toInvoice(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    invoiceNumber: row.invoice_number,
    amount: Number(row.amount),
    feeDescription: row.fee_description,
    currency: row.currency,
    paymentStatus: row.payment_status,
    paymentReference: row.payment_reference || null,
    paymentProvider: row.payment_provider || null,
    paidAt: row.paid_at || null,
    updatedAt: row.updated_at || row.created_at,
    createdAt: row.created_at
  };
}

function toPaymentTransaction(row) {
  if (!row) return null;
  return {
    id: row.id,
    invoiceNumber: row.invoice_number || null,
    userId: row.user_id || null,
    provider: row.provider,
    eventType: row.event_type || null,
    gatewayStatus: row.gateway_status || null,
    gatewayReference: row.gateway_reference || null,
    amount: row.amount == null ? null : Number(row.amount),
    currency: row.currency || null,
    signatureValid: Boolean(row.signature_valid),
    payloadJson: row.payload_json,
    processingNote: row.processing_note || null,
    receivedAt: row.received_at,
    processedAt: row.processed_at || null
  };
}

function toAuditLog(row) {
  if (!row) return null;
  return {
    id: row.id,
    invoiceNumber: row.invoice_number || null,
    actorType: row.actor_type,
    actorId: row.actor_id || null,
    action: row.action,
    beforeStatus: row.before_status || null,
    afterStatus: row.after_status || null,
    note: row.note || null,
    metadataJson: row.metadata_json || null,
    createdAt: row.created_at
  };
}

function toAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    isActive: Boolean(row.is_active),
    mustChangePassword: Boolean(row.must_change_password),
    passwordChangedAt: row.password_changed_at || null,
    passwordExpiresAt: row.password_expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function ensureDefaultAdmin(username, password) {
  const existing = db.prepare("SELECT * FROM admin_users WHERE username = ?").get(username);
  const now = new Date().toISOString();

  if (!existing) {
    const policyError = validateAdminPasswordPolicy(password);
    if (policyError) {
      throw new Error(`Default admin password is invalid: ${policyError}`);
    }

    const created = {
      id: crypto.randomUUID(),
      username,
      passwordHash: bcrypt.hashSync(password, 10),
      role: "super_admin",
      isActive: 1,
      mustChangePassword: 0,
      passwordChangedAt: now,
      passwordExpiresAt: addDaysIso(ADMIN_PASSWORD_EXPIRY_DAYS),
      createdAt: now,
      updatedAt: now,
    };

    db.prepare(
      `
      INSERT INTO admin_users (
        id, username, password_hash, role, is_active, must_change_password,
        password_changed_at, password_expires_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      created.id,
      created.username,
      created.passwordHash,
      created.role,
      created.isActive,
      created.mustChangePassword,
      created.passwordChangedAt,
      created.passwordExpiresAt,
      created.createdAt,
      created.updatedAt
    );

    return getAdminByUsername(username);
  }

  if (!existing.updated_at) {
    db.prepare("UPDATE admin_users SET updated_at = ? WHERE id = ?").run(now, existing.id);
  }

  return toAdmin(existing);
}

function getAdminByUsername(username) {
  const row = db
    .prepare("SELECT * FROM admin_users WHERE username = ? AND is_active = 1")
    .get(String(username || "").trim());
  return toAdmin(row);
}

function getAnyAdminByUsername(username) {
  const row = db
    .prepare("SELECT * FROM admin_users WHERE username = ?")
    .get(String(username || "").trim());
  return toAdmin(row);
}

function getAdminById(adminId) {
  const row = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(adminId);
  return toAdmin(row);
}

function listAdminUsers() {
  const rows = db
    .prepare("SELECT * FROM admin_users ORDER BY created_at DESC")
    .all();
  return rows.map(toAdmin);
}

function createAdminUser({ username, password, role }) {
  const cleanUsername = String(username || "").trim();
  const cleanRole = String(role || "").trim();
  if (!cleanUsername) {
    return { error: "Username is required." };
  }
  const policyError = validateAdminPasswordPolicy(password);
  if (policyError) {
    return { error: policyError };
  }
  if (!cleanRole) {
    return { error: "Role is required." };
  }

  const existing = getAnyAdminByUsername(cleanUsername);
  if (existing) {
    return { error: "Username already exists." };
  }

  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    username: cleanUsername,
    passwordHash: bcrypt.hashSync(String(password), 10),
    role: cleanRole,
    isActive: 1,
    mustChangePassword: 1,
    passwordChangedAt: null,
    passwordExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `
    INSERT INTO admin_users (
      id, username, password_hash, role, is_active, must_change_password,
      password_changed_at, password_expires_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    created.id,
    created.username,
    created.passwordHash,
    created.role,
    created.isActive,
    created.mustChangePassword,
    created.passwordChangedAt,
    created.passwordExpiresAt,
    created.createdAt,
    created.updatedAt
  );

  return { admin: getAdminById(created.id) };
}

function setAdminActive(adminId, isActive) {
  const target = getAdminById(adminId);
  if (!target) {
    return null;
  }

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE admin_users SET is_active = ?, updated_at = ? WHERE id = ?"
  ).run(isActive ? 1 : 0, now, adminId);

  return getAdminById(adminId);
}

function resetAdminPassword(adminId, newPassword) {
  const policyError = validateAdminPasswordPolicy(newPassword);
  if (policyError) {
    return { error: policyError };
  }

  const target = getAdminById(adminId);
  if (!target) {
    return { error: "Admin account not found." };
  }

  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(String(newPassword), 10);
  db.prepare(
    `
    UPDATE admin_users
    SET password_hash = ?, must_change_password = 1, password_changed_at = NULL,
        password_expires_at = NULL, updated_at = ?
    WHERE id = ?
  `
  ).run(hash, now, adminId);

  return { admin: getAdminById(adminId) };
}

function isAdminPasswordExpired(admin) {
  if (!admin || !admin.passwordExpiresAt) {
    return false;
  }
  return new Date(admin.passwordExpiresAt).getTime() < Date.now();
}

function changeOwnAdminPassword({ adminId, currentPassword, newPassword }) {
  const admin = getAdminById(adminId);
  if (!admin || !admin.isActive) {
    return { error: "Admin account not found." };
  }

  const currentOk = bcrypt.compareSync(String(currentPassword || ""), admin.passwordHash);
  if (!currentOk) {
    return { error: "Current password is incorrect." };
  }

  const policyError = validateAdminPasswordPolicy(newPassword);
  if (policyError) {
    return { error: policyError };
  }

  if (bcrypt.compareSync(String(newPassword), admin.passwordHash)) {
    return { error: "New password must be different from current password." };
  }

  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(String(newPassword), 10);
  db.prepare(
    `
    UPDATE admin_users
    SET password_hash = ?, must_change_password = 0, password_changed_at = ?,
        password_expires_at = ?, updated_at = ?
    WHERE id = ?
  `
  ).run(hash, now, addDaysIso(ADMIN_PASSWORD_EXPIRY_DAYS), now, adminId);

  return { admin: getAdminById(adminId) };
}

function updateAdminRole(adminId, role) {
  const target = getAdminById(adminId);
  if (!target) {
    return null;
  }

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE admin_users SET role = ?, updated_at = ? WHERE id = ?"
  ).run(String(role || "").trim(), now, adminId);

  return getAdminById(adminId);
}

function createUser({ surname, otherNames, email, phone, passwordHash }) {
  const user = {
    id: crypto.randomUUID(),
    surname: String(surname).trim(),
    otherNames: String(otherNames).trim(),
    email: normalizeEmail(email),
    phone: String(phone).trim(),
    passwordHash,
    createdAt: new Date().toISOString()
  };

  db.prepare(
    `
    INSERT INTO users (id, surname, other_names, email, phone, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    user.id,
    user.surname,
    user.otherNames,
    user.email,
    user.phone,
    user.passwordHash,
    user.createdAt
  );

  return user;
}

function getUserByEmail(email) {
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email));
  return toUser(row);
}

function getUserById(userId) {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  return toUser(row);
}

function listPrograms() {
  const rows = db.prepare("SELECT * FROM programs ORDER BY name ASC").all();
  return rows.map(toProgram);
}

function getProgramById(programId) {
  const row = db.prepare("SELECT * FROM programs WHERE id = ?").get(programId);
  return toProgram(row);
}

function createOrUpdateApplication({ userId, programId, modeOfStudy, previousInstitution, notes }) {
  const existing = db.prepare("SELECT * FROM applications WHERE user_id = ?").get(userId);

  if (!existing) {
    const created = {
      id: crypto.randomUUID(),
      userId,
      programId,
      modeOfStudy,
      previousInstitution,
      notes,
      status: "Pending Screening",
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.prepare(
      `
      INSERT INTO applications (
        id, user_id, program_id, mode_of_study, previous_institution,
        notes, status, submitted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      created.id,
      created.userId,
      created.programId,
      created.modeOfStudy,
      created.previousInstitution,
      created.notes,
      created.status,
      created.submittedAt,
      created.updatedAt
    );

    return created;
  } else {
    const updatedAt = new Date().toISOString();
    db.prepare(
      `
      UPDATE applications
      SET program_id = ?, mode_of_study = ?, previous_institution = ?, notes = ?, updated_at = ?
      WHERE user_id = ?
    `
    ).run(programId, modeOfStudy, previousInstitution, notes, updatedAt, userId);

    return {
      id: existing.id,
      userId,
      programId,
      modeOfStudy,
      previousInstitution,
      notes,
      status: existing.status,
      submittedAt: existing.submitted_at,
      updatedAt
    };
  }
}

function getApplicationByUserId(userId) {
  const row = db.prepare("SELECT * FROM applications WHERE user_id = ?").get(userId);
  return toApplication(row);
}

function buildInvoiceNumber() {
  const stamp = Date.now().toString().slice(-8);
  const random = Math.floor(Math.random() * 900 + 100);
  return `INV-${stamp}-${random}`;
}

function createInvoice({ userId, amount, feeDescription, currency }) {
  const now = new Date().toISOString();
  const invoice = {
    id: crypto.randomUUID(),
    userId,
    invoiceNumber: buildInvoiceNumber(),
    amount,
    feeDescription,
    currency,
    paymentStatus: "Unpaid",
    paymentReference: null,
    paymentProvider: null,
    paidAt: null,
    updatedAt: now,
    createdAt: now
  };

  db.prepare(
    `
    INSERT INTO invoices (
      id, user_id, invoice_number, amount, fee_description, currency,
      payment_status, payment_reference, payment_provider, paid_at, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    invoice.id,
    invoice.userId,
    invoice.invoiceNumber,
    invoice.amount,
    invoice.feeDescription,
    invoice.currency,
    invoice.paymentStatus,
    invoice.paymentReference,
    invoice.paymentProvider,
    invoice.paidAt,
    invoice.updatedAt,
    invoice.createdAt
  );

  return invoice;
}

function createAuditLog({
  invoiceNumber,
  actorType,
  actorId = null,
  action,
  beforeStatus = null,
  afterStatus = null,
  note = null,
  metadata = null,
}) {
  const log = {
    id: crypto.randomUUID(),
    invoiceNumber,
    actorType,
    actorId,
    action,
    beforeStatus,
    afterStatus,
    note,
    metadataJson: metadata ? JSON.stringify(metadata) : null,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `
    INSERT INTO payment_audit_logs (
      id, invoice_number, actor_type, actor_id, action, before_status,
      after_status, note, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    log.id,
    log.invoiceNumber,
    log.actorType,
    log.actorId,
    log.action,
    log.beforeStatus,
    log.afterStatus,
    log.note,
    log.metadataJson,
    log.createdAt
  );

  return log;
}

function recordPaymentTransaction({
  invoiceNumber = null,
  userId = null,
  provider,
  eventType = null,
  gatewayStatus = null,
  gatewayReference = null,
  amount = null,
  currency = null,
  signatureValid,
  payload,
  processingNote = null,
  processedAt = null,
}) {
  const tx = {
    id: crypto.randomUUID(),
    invoiceNumber,
    userId,
    provider,
    eventType,
    gatewayStatus,
    gatewayReference,
    amount,
    currency,
    signatureValid: signatureValid ? 1 : 0,
    payloadJson: JSON.stringify(payload || {}),
    processingNote,
    receivedAt: new Date().toISOString(),
    processedAt,
  };

  db.prepare(
    `
    INSERT INTO payment_transactions (
      id, invoice_number, user_id, provider, event_type, gateway_status,
      gateway_reference, amount, currency, signature_valid, payload_json,
      processing_note, received_at, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    tx.id,
    tx.invoiceNumber,
    tx.userId,
    tx.provider,
    tx.eventType,
    tx.gatewayStatus,
    tx.gatewayReference,
    tx.amount,
    tx.currency,
    tx.signatureValid,
    tx.payloadJson,
    tx.processingNote,
    tx.receivedAt,
    tx.processedAt
  );

  return tx;
}

function updateInvoicePayment({
  invoiceNumber,
  status,
  paymentReference = null,
  paymentProvider = null,
  paidAt = null,
  actorType,
  actorId = null,
  action,
  note = null,
  metadata = null,
}) {
  const current = getInvoiceByNumber(invoiceNumber);
  if (!current) {
    return null;
  }

  const now = new Date().toISOString();
  const normalizedStatus = String(status || "").trim() || current.paymentStatus;
  const finalPaidAt = normalizedStatus === "Paid" ? (paidAt || current.paidAt || now) : null;
  const finalReference = paymentReference || current.paymentReference || null;
  const finalProvider = paymentProvider || current.paymentProvider || null;

  db.prepare(
    `
    UPDATE invoices
    SET payment_status = ?, payment_reference = ?, payment_provider = ?, paid_at = ?, updated_at = ?
    WHERE invoice_number = ?
  `
  ).run(normalizedStatus, finalReference, finalProvider, finalPaidAt, now, invoiceNumber);

  createAuditLog({
    invoiceNumber,
    actorType,
    actorId,
    action,
    beforeStatus: current.paymentStatus,
    afterStatus: normalizedStatus,
    note,
    metadata,
  });

  return getInvoiceByNumber(invoiceNumber);
}

function markInvoicePaid(invoiceNumber, paymentReference, opts = {}) {
  return updateInvoicePayment({
    invoiceNumber,
    status: "Paid",
    paymentReference,
    paymentProvider: opts.paymentProvider || null,
    paidAt: opts.paidAt || null,
    actorType: opts.actorType || "system",
    actorId: opts.actorId || null,
    action: opts.action || "invoice_mark_paid",
    note: opts.note || null,
    metadata: opts.metadata || null,
  });
}

function manualOverrideInvoice({
  invoiceNumber,
  status,
  paymentReference = null,
  paymentProvider = null,
  actorId,
  note,
}) {
  return updateInvoicePayment({
    invoiceNumber,
    status,
    paymentReference,
    paymentProvider,
    actorType: "admin",
    actorId,
    action: "manual_override",
    note,
    metadata: {
      source: "admin_console",
    },
  });
}

function getLatestInvoiceByUserId(userId) {
  const row = db
    .prepare("SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(userId);
  return toInvoice(row);
}

function getInvoiceByNumber(invoiceNumber) {
  const row = db.prepare("SELECT * FROM invoices WHERE invoice_number = ?").get(invoiceNumber);
  return toInvoice(row);
}

function listInvoicesForAdmin({ status = "", q = "" } = {}) {
  let sql = `
    SELECT
      i.*,
      u.surname,
      u.other_names,
      u.email
    FROM invoices i
    LEFT JOIN users u ON u.id = i.user_id
    WHERE 1 = 1
  `;

  const params = [];

  if (status) {
    sql += " AND i.payment_status = ?";
    params.push(status);
  }

  if (q) {
    sql += " AND (i.invoice_number LIKE ? OR IFNULL(i.payment_reference, '') LIKE ? OR IFNULL(u.email, '') LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  sql += " ORDER BY i.created_at DESC LIMIT 200";

  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => ({
    ...toInvoice(row),
    applicantSurname: row.surname || "",
    applicantOtherNames: row.other_names || "",
    applicantEmail: row.email || "",
  }));
}

function listReconciliationRows({ status = "", q = "" } = {}) {
  let sql = `
    SELECT
      i.*,
      u.surname,
      u.other_names,
      u.email,
      (
        SELECT pt.gateway_reference
        FROM payment_transactions pt
        WHERE pt.invoice_number = i.invoice_number
          AND pt.signature_valid = 1
          AND LOWER(IFNULL(pt.gateway_status, '')) IN ('success', 'successful', 'completed', 'paid')
        ORDER BY pt.received_at DESC
        LIMIT 1
      ) AS latest_success_reference,
      (
        SELECT pt.provider
        FROM payment_transactions pt
        WHERE pt.invoice_number = i.invoice_number
          AND pt.signature_valid = 1
          AND LOWER(IFNULL(pt.gateway_status, '')) IN ('success', 'successful', 'completed', 'paid')
        ORDER BY pt.received_at DESC
        LIMIT 1
      ) AS latest_success_provider,
      (
        SELECT pt.received_at
        FROM payment_transactions pt
        WHERE pt.invoice_number = i.invoice_number
          AND pt.signature_valid = 1
          AND LOWER(IFNULL(pt.gateway_status, '')) IN ('success', 'successful', 'completed', 'paid')
        ORDER BY pt.received_at DESC
        LIMIT 1
      ) AS latest_success_at
    FROM invoices i
    LEFT JOIN users u ON u.id = i.user_id
    WHERE 1 = 1
  `;

  const params = [];
  if (status) {
    sql += " AND i.payment_status = ?";
    params.push(status);
  }

  if (q) {
    sql += " AND (i.invoice_number LIKE ? OR IFNULL(i.payment_reference, '') LIKE ? OR IFNULL(u.email, '') LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  sql += " ORDER BY i.created_at DESC LIMIT 500";

  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => {
    const latestSuccessRef = row.latest_success_reference || null;
    const reconciliationFlag = latestSuccessRef && row.payment_status !== "Paid"
      ? "MISSING_PAID_STATUS"
      : row.payment_status === "Paid" && !latestSuccessRef
        ? "PAID_WITHOUT_SIGNED_SUCCESS_TX"
        : "OK";

    return {
      invoiceNumber: row.invoice_number,
      applicantSurname: row.surname || "",
      applicantOtherNames: row.other_names || "",
      applicantEmail: row.email || "",
      amount: Number(row.amount),
      currency: row.currency,
      paymentStatus: row.payment_status,
      paymentReference: row.payment_reference || "",
      paymentProvider: row.payment_provider || "",
      paidAt: row.paid_at || "",
      latestSuccessReference: latestSuccessRef || "",
      latestSuccessProvider: row.latest_success_provider || "",
      latestSuccessAt: row.latest_success_at || "",
      reconciliationFlag,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    };
  });
}

function listRecentPaymentTransactions(limit = 120) {
  const rows = db
    .prepare("SELECT * FROM payment_transactions ORDER BY received_at DESC LIMIT ?")
    .all(limit);
  return rows.map(toPaymentTransaction);
}

function listPaymentHistoryByInvoice(invoiceNumber) {
  const rows = db
    .prepare("SELECT * FROM payment_transactions WHERE invoice_number = ? ORDER BY received_at DESC")
    .all(invoiceNumber);
  return rows.map(toPaymentTransaction);
}

function listRecentAuditLogs(limit = 120) {
  const rows = db
    .prepare("SELECT * FROM payment_audit_logs ORDER BY created_at DESC LIMIT ?")
    .all(limit);
  return rows.map(toAuditLog);
}

function getReconciliationReport() {
  const rows = db
    .prepare(
      `
      SELECT
        i.invoice_number,
        i.payment_status,
        i.payment_reference,
        i.payment_provider,
        i.amount,
        i.currency,
        (
          SELECT pt.gateway_reference
          FROM payment_transactions pt
          WHERE pt.invoice_number = i.invoice_number
            AND pt.signature_valid = 1
            AND LOWER(IFNULL(pt.gateway_status, '')) IN ('success', 'successful', 'completed', 'paid')
          ORDER BY pt.received_at DESC
          LIMIT 1
        ) AS latest_success_reference,
        (
          SELECT pt.provider
          FROM payment_transactions pt
          WHERE pt.invoice_number = i.invoice_number
            AND pt.signature_valid = 1
            AND LOWER(IFNULL(pt.gateway_status, '')) IN ('success', 'successful', 'completed', 'paid')
          ORDER BY pt.received_at DESC
          LIMIT 1
        ) AS latest_success_provider,
        (
          SELECT pt.received_at
          FROM payment_transactions pt
          WHERE pt.invoice_number = i.invoice_number
            AND pt.signature_valid = 1
            AND LOWER(IFNULL(pt.gateway_status, '')) IN ('success', 'successful', 'completed', 'paid')
          ORDER BY pt.received_at DESC
          LIMIT 1
        ) AS latest_success_at
      FROM invoices i
      ORDER BY i.created_at DESC
      LIMIT 400
    `
    )
    .all();

  const payableMismatch = rows.filter(
    (r) => r.latest_success_reference && r.payment_status !== "Paid"
  );
  const paidWithoutTx = rows.filter(
    (r) => r.payment_status === "Paid" && !r.latest_success_reference
  );

  return {
    payableMismatch,
    paidWithoutTx,
  };
}

function autoReconcileInvoices(actorId) {
  const report = getReconciliationReport();
  let updated = 0;

  for (const row of report.payableMismatch) {
    const updatedInvoice = updateInvoicePayment({
      invoiceNumber: row.invoice_number,
      status: "Paid",
      paymentReference: row.latest_success_reference,
      paymentProvider: row.latest_success_provider || null,
      paidAt: row.latest_success_at || null,
      actorType: "admin",
      actorId,
      action: "reconciliation_auto_fix",
      note: "Auto-reconciled based on successful signed transaction.",
      metadata: {
        previousStatus: row.payment_status,
      },
    });

    if (updatedInvoice) {
      updated += 1;
    }
  }

  return {
    updated,
    mismatches: report.payableMismatch.length,
    paidWithoutTx: report.paidWithoutTx.length,
  };
}

function normalizeGatewayStatus(input) {
  const normalized = String(input || "").trim().toLowerCase();
  return normalized || "unknown";
}

function isSuccessGatewayStatus(input) {
  return SUCCESS_STATUSES.includes(normalizeGatewayStatus(input));
}

function getDashboardByUserId(userId) {
  const user = getUserById(userId);
  const application = getApplicationByUserId(userId);
  const program = application ? getProgramById(application.programId) : null;
  const latestInvoice = getLatestInvoiceByUserId(userId);
  const paymentHistory = latestInvoice ? listPaymentHistoryByInvoice(latestInvoice.invoiceNumber) : [];

  return {
    user,
    application,
    program,
    latestInvoice,
    paymentHistory
  };
}

module.exports = {
  ensureSeed,
  getAdminByUsername,
  getAdminById,
  listAdminUsers,
  createAdminUser,
  setAdminActive,
  resetAdminPassword,
  updateAdminRole,
  isAdminPasswordExpired,
  changeOwnAdminPassword,
  createUser,
  getUserByEmail,
  getUserById,
  listPrograms,
  getProgramById,
  createOrUpdateApplication,
  getApplicationByUserId,
  createInvoice,
  createAuditLog,
  recordPaymentTransaction,
  manualOverrideInvoice,
  updateInvoicePayment,
  listInvoicesForAdmin,
  listReconciliationRows,
  listRecentPaymentTransactions,
  listRecentAuditLogs,
  listPaymentHistoryByInvoice,
  getReconciliationReport,
  autoReconcileInvoices,
  isSuccessGatewayStatus,
  normalizeGatewayStatus,
  markInvoicePaid,
  getInvoiceByNumber,
  getLatestInvoiceByUserId,
  getDashboardByUserId
};
