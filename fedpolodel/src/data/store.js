const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { DatabaseSync } = require("node:sqlite");
const { programmeId } = require("../config/institution");
const { gradeScore } = require("../config/grading");

const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.resolve(__dirname, "../../data/app.db");
// data/ is gitignored, so it does not exist on a fresh clone and SQLite will
// not create missing directories.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
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

// A transaction only proves an invoice was paid if it is a signature-verified
// success for the invoice's exact amount and currency. Reconciliation uses this,
// so a signed-but-underpaid event can never be turned into "Paid" by
// "Auto Reconcile". (Used inside subqueries where `i` is the invoice row.)
const VALID_SUCCESS_TX = `
  pt.invoice_number = i.invoice_number
  AND pt.signature_valid = 1
  AND LOWER(IFNULL(pt.gateway_status, '')) IN (${SUCCESS_STATUSES.map((st) => `'${st}'`).join(", ")})
  AND pt.amount IS NOT NULL
  AND CAST(ROUND(pt.amount * 100) AS INTEGER) = CAST(ROUND(i.amount * 100) AS INTEGER)
  AND UPPER(IFNULL(pt.currency, '')) = UPPER(i.currency)
`;
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

    CREATE TABLE IF NOT EXISTS institution_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS schools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE
    );
    CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY,
      school_id TEXT NOT NULL REFERENCES schools(id),
      name TEXT NOT NULL COLLATE NOCASE,
      UNIQUE (school_id, name)
    );
    CREATE TABLE IF NOT EXISTS programme_departments (
      program_id TEXT PRIMARY KEY REFERENCES programs(id),
      department_id TEXT NOT NULL REFERENCES departments(id)
    );
    CREATE TABLE IF NOT EXISTS students (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      application_id TEXT NOT NULL UNIQUE,
      matriculation_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
      program_id TEXT NOT NULL REFERENCES programs(id),
      department_id TEXT NOT NULL REFERENCES departments(id),
      school_id TEXT NOT NULL REFERENCES schools(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS academic_terms (
      id TEXT PRIMARY KEY,
      session_name TEXT NOT NULL COLLATE NOCASE,
      term_name TEXT NOT NULL COLLATE NOCASE,
      registration_open INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (session_name, term_name)
    );
    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL REFERENCES programs(id),
      code TEXT NOT NULL COLLATE NOCASE,
      title TEXT NOT NULL,
      credit_units INTEGER NOT NULL,
      UNIQUE (program_id, code)
    );
    CREATE TABLE IF NOT EXISTS course_offerings (
      id TEXT PRIMARY KEY,
      term_id TEXT NOT NULL REFERENCES academic_terms(id),
      course_id TEXT NOT NULL REFERENCES courses(id),
      UNIQUE (term_id, course_id)
    );
    CREATE TABLE IF NOT EXISTS course_registrations (
      user_id TEXT NOT NULL REFERENCES students(user_id),
      offering_id TEXT NOT NULL REFERENCES course_offerings(id),
      status TEXT NOT NULL CHECK (status IN ('registered', 'dropped')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, offering_id)
    );
    CREATE TABLE IF NOT EXISTS attendance_meetings (
      id TEXT PRIMARY KEY,
      offering_id TEXT NOT NULL REFERENCES course_offerings(id),
      meeting_date TEXT NOT NULL,
      label TEXT NOT NULL COLLATE NOCASE,
      created_at TEXT NOT NULL,
      UNIQUE (offering_id, meeting_date, label)
    );
    CREATE TABLE IF NOT EXISTS attendance_records (
      meeting_id TEXT NOT NULL REFERENCES attendance_meetings(id),
      user_id TEXT NOT NULL REFERENCES students(user_id),
      status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late', 'excused')),
      revision TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (meeting_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS grading_scales (
      id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL REFERENCES programs(id),
      name TEXT NOT NULL,
      bands_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS programme_grading_scales (
      program_id TEXT PRIMARY KEY REFERENCES programs(id),
      scale_id TEXT NOT NULL REFERENCES grading_scales(id)
    );
    CREATE TABLE IF NOT EXISTS academic_results (
      user_id TEXT NOT NULL REFERENCES students(user_id),
      offering_id TEXT NOT NULL REFERENCES course_offerings(id),
      draft_score REAL,
      draft_reason TEXT,
      draft_id TEXT,
      draft_updated_at TEXT,
      published_json TEXT,
      PRIMARY KEY (user_id, offering_id)
    );
    CREATE TABLE IF NOT EXISTS result_publications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES students(user_id),
      offering_id TEXT NOT NULL REFERENCES course_offerings(id),
      publication_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      invoice_number TEXT NOT NULL UNIQUE,
      amount REAL NOT NULL,
      fee_description TEXT NOT NULL,
      currency TEXT NOT NULL,
      invoice_kind TEXT NOT NULL DEFAULT 'application',
      payment_status TEXT NOT NULL,
      payment_reference TEXT,
      payment_provider TEXT,
      paid_at TEXT,
      updated_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS student_fee_requests (
      request_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES students(user_id),
      invoice_number TEXT NOT NULL REFERENCES invoices(invoice_number)
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
      actor_label TEXT,
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
  if (!db.prepare("PRAGMA table_info(attendance_records)").all().some((c) => c.name === "revision")) {
    db.exec("ALTER TABLE attendance_records ADD COLUMN revision TEXT");
    db.exec("UPDATE attendance_records SET revision = lower(hex(randomblob(16))) WHERE revision IS NULL");
  }
  if (!invoiceCols.some((c) => c.name === "invoice_kind")) {
    db.exec("ALTER TABLE invoices ADD COLUMN invoice_kind TEXT NOT NULL DEFAULT 'application'");
  }

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

  const auditCols = db.prepare("PRAGMA table_info(payment_audit_logs)").all();
  if (!auditCols.some((c) => c.name === "actor_label")) {
    db.exec("ALTER TABLE payment_audit_logs ADD COLUMN actor_label TEXT");
  }
  const resultCols = db.prepare("PRAGMA table_info(academic_results)").all();
  if (!resultCols.some((c) => c.name === "draft_id")) {
    db.exec("ALTER TABLE academic_results ADD COLUMN draft_id TEXT");
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

function getInstitutionSettings() {
  const row = db.prepare("SELECT settings_json FROM institution_settings WHERE id = 1").get();
  return row ? JSON.parse(row.settings_json) : null;
}

function saveInstitutionSettings(settings, auditEntry) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = listPrograms();
    const insert = db.prepare("INSERT INTO programs (id, name) VALUES (?, ?)");
    const programmeIds = settings.programmeNames.map((name) => {
      const current = existing.find((program) => program.name.toLowerCase() === name.toLowerCase());
      if (current) return current.id;
      const program = { id: programmeId(name), name };
      insert.run(program.id, program.name);
      existing.push(program);
      return program.id;
    });
    const saved = { ...settings, programmeIds };
    db.prepare("INSERT INTO institution_settings (id, settings_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json").run(JSON.stringify(saved));
    createAuditLog({ invoiceNumber: null, ...auditEntry });
    db.exec("COMMIT");
    return saved;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
    invoiceKind: row.invoice_kind || "application",
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
    actorLabel: row.actor_label || describeActor(row.actor_type, row.actor_id),
    action: row.action,
    beforeStatus: row.before_status || null,
    afterStatus: row.after_status || null,
    note: row.note || null,
    metadataJson: row.metadata_json || null,
    createdAt: row.created_at
  };
}

function describeActor(actorType, actorId) {
  const type = actorType || "system";
  return actorId ? `${type}: ${actorId}` : type;
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
    const result = db.prepare(
      `
      UPDATE applications
      SET program_id = ?, mode_of_study = ?, previous_institution = ?, notes = ?, updated_at = ?
      WHERE user_id = ? AND status = 'Pending Screening'
    `
    ).run(programId, modeOfStudy, previousInstitution, notes, updatedAt, userId);
    if (!result.changes) return { error: "Decided applications cannot be changed." };

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

function sisAudit(actor, action, note, metadata) {
  createAuditLog({ invoiceNumber: null, actorType: "admin", actorId: actor.id, actorLabel: actor.label, action, note, metadata });
}

function sisTransaction(callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function listAcademicStructure() {
  return {
    schools: db.prepare("SELECT id, name FROM schools ORDER BY name").all(),
    departments: db.prepare("SELECT id, school_id AS schoolId, name FROM departments ORDER BY name").all(),
    assignments: db.prepare("SELECT program_id AS programId, department_id AS departmentId FROM programme_departments").all(),
    programs: listPrograms(),
  };
}

function createSchool(name, actor) {
  return sisTransaction(() => {
    if (db.prepare("SELECT id FROM schools WHERE name = ? COLLATE NOCASE").get(name)) return { error: "School already exists." };
    const school = { id: crypto.randomUUID(), name };
    db.prepare("INSERT INTO schools (id, name) VALUES (?, ?)").run(school.id, name);
    sisAudit(actor, "school_created", null, { schoolId: school.id });
    return { school };
  });
}

function createDepartment(schoolId, name, actor) {
  return sisTransaction(() => {
    if (!db.prepare("SELECT id FROM schools WHERE id = ?").get(schoolId)) return { error: "School not found." };
    if (db.prepare("SELECT id FROM departments WHERE school_id = ? AND name = ? COLLATE NOCASE").get(schoolId, name)) return { error: "Department already exists in this school." };
    const department = { id: crypto.randomUUID(), schoolId, name };
    db.prepare("INSERT INTO departments (id, school_id, name) VALUES (?, ?, ?)").run(department.id, schoolId, name);
    sisAudit(actor, "department_created", null, { departmentId: department.id, schoolId });
    return { department };
  });
}

function assignProgrammeDepartment(programId, departmentId, actor) {
  return sisTransaction(() => {
    if (!getProgramById(programId) || !db.prepare("SELECT id FROM departments WHERE id = ?").get(departmentId)) return { error: "Programme or department not found." };
    db.prepare("INSERT INTO programme_departments (program_id, department_id) VALUES (?, ?) ON CONFLICT(program_id) DO UPDATE SET department_id = excluded.department_id").run(programId, departmentId);
    sisAudit(actor, "programme_department_assigned", null, { programId, departmentId });
    return { success: true };
  });
}

function listAdmissions() {
  return db.prepare(`
    SELECT a.user_id AS userId, a.program_id AS programId, a.status, a.mode_of_study AS modeOfStudy,
      a.previous_institution AS previousInstitution, a.notes, a.submitted_at AS submittedAt,
      u.surname, u.other_names AS otherNames, u.email, p.name AS programName,
      (SELECT i.payment_status FROM invoices i WHERE i.user_id = a.user_id AND i.invoice_kind = 'application' ORDER BY i.created_at DESC LIMIT 1) AS paymentStatus
    FROM applications a JOIN users u ON u.id = a.user_id JOIN programs p ON p.id = a.program_id
    ORDER BY a.submitted_at DESC
  `).all();
}

function decideAdmission(userId, decision, note, actor) {
  return sisTransaction(() => {
    const application = getApplicationByUserId(userId);
    if (!application) return { error: "Application not found." };
    if (application.status === "Matriculated") return { error: "A matriculated application cannot be changed." };
    if (!["Pending Screening", "Admitted", "Rejected"].includes(application.status)) return { error: "Application is not eligible for a decision." };
    if (application.status === decision) return { error: "Application already has this decision." };
    db.prepare("UPDATE applications SET status = ?, updated_at = ? WHERE user_id = ?").run(decision, new Date().toISOString(), userId);
    sisAudit(actor, "admission_decision", note, { userId, applicationId: application.id, beforeStatus: application.status, afterStatus: decision });
    return { status: decision };
  });
}

function matriculateStudent(userId, matriculationNumber, actor) {
  return sisTransaction(() => {
    const application = getApplicationByUserId(userId);
    if (!application) return { error: "Application not found." };
    if (application.status !== "Admitted") return { error: "Only an admitted applicant can be matriculated." };
    if (db.prepare("SELECT user_id FROM students WHERE matriculation_number = ? COLLATE NOCASE").get(matriculationNumber)) return { error: "Matriculation number is already in use." };
    const department = db.prepare("SELECT d.id, d.school_id FROM programme_departments pd JOIN departments d ON d.id = pd.department_id WHERE pd.program_id = ?").get(application.programId);
    if (!department) return { error: "Assign the applicant's programme to a department before matriculation." };
    const student = { userId, applicationId: application.id, matriculationNumber, programId: application.programId, departmentId: department.id, schoolId: department.school_id, createdAt: new Date().toISOString() };
    db.prepare("INSERT INTO students (user_id, application_id, matriculation_number, program_id, department_id, school_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(student.userId, student.applicationId, student.matriculationNumber, student.programId, student.departmentId, student.schoolId, student.createdAt);
    db.prepare("UPDATE applications SET status = 'Matriculated', updated_at = ? WHERE user_id = ?").run(student.createdAt, userId);
    sisAudit(actor, "student_matriculated", null, { userId, applicationId: application.id, matriculationNumber });
    return { student };
  });
}

function getStudentByUserId(userId) {
  return db.prepare("SELECT user_id AS userId, application_id AS applicationId, matriculation_number AS matriculationNumber, program_id AS programId, department_id AS departmentId, school_id AS schoolId, created_at AS createdAt FROM students WHERE user_id = ?").get(userId) || null;
}

function listStudents() {
  return db.prepare(`SELECT s.user_id AS userId, s.matriculation_number AS matriculationNumber, s.created_at AS createdAt,
    u.surname, u.other_names AS otherNames, u.email, p.name AS programName, d.name AS departmentName, sc.name AS schoolName
    FROM students s JOIN users u ON u.id = s.user_id JOIN programs p ON p.id = s.program_id
    JOIN departments d ON d.id = s.department_id JOIN schools sc ON sc.id = s.school_id ORDER BY s.created_at DESC`).all();
}

function listCourseCatalog() {
  return {
    terms: db.prepare("SELECT id, session_name AS sessionName, term_name AS termName, registration_open AS registrationOpen, created_at AS createdAt FROM academic_terms ORDER BY created_at DESC").all().map((term) => ({ ...term, registrationOpen: Boolean(term.registrationOpen) })),
    courses: db.prepare("SELECT id, program_id AS programId, code, title, credit_units AS creditUnits FROM courses ORDER BY code").all(),
    offerings: db.prepare("SELECT id, term_id AS termId, course_id AS courseId FROM course_offerings").all(),
    programs: listPrograms(),
  };
}

function createAcademicTerm(sessionName, termName, actor) {
  return sisTransaction(() => {
    if (db.prepare("SELECT id FROM academic_terms WHERE session_name = ? COLLATE NOCASE AND term_name = ? COLLATE NOCASE").get(sessionName, termName)) return { error: "This term already exists in the academic session." };
    const term = { id: crypto.randomUUID(), sessionName, termName, registrationOpen: false, createdAt: new Date().toISOString() };
    db.prepare("INSERT INTO academic_terms (id, session_name, term_name, registration_open, created_at) VALUES (?, ?, ?, 0, ?)").run(term.id, sessionName, termName, term.createdAt);
    sisAudit(actor, "academic_term_created", null, { termId: term.id });
    return { term };
  });
}

function setRegistrationOpen(termId, open, actor) {
  return sisTransaction(() => {
    const term = db.prepare("SELECT registration_open AS registrationOpen FROM academic_terms WHERE id = ?").get(termId);
    if (!term) return { error: "Academic term not found." };
    if (Boolean(term.registrationOpen) === open) return { error: "Registration is already in that state." };
    db.prepare("UPDATE academic_terms SET registration_open = ? WHERE id = ?").run(open ? 1 : 0, termId);
    sisAudit(actor, "registration_window_changed", null, { termId, registrationOpen: open });
    return { success: true };
  });
}

function createCourse(input, actor) {
  return sisTransaction(() => {
    if (!getProgramById(input.programId)) return { error: "Programme not found." };
    if (db.prepare("SELECT id FROM courses WHERE program_id = ? AND code = ? COLLATE NOCASE").get(input.programId, input.code)) return { error: "Course code already exists in this programme." };
    const course = { id: crypto.randomUUID(), ...input };
    db.prepare("INSERT INTO courses (id, program_id, code, title, credit_units) VALUES (?, ?, ?, ?, ?)").run(course.id, course.programId, course.code, course.title, course.creditUnits);
    sisAudit(actor, "course_created", null, { courseId: course.id, programId: course.programId });
    return { course };
  });
}

function createCourseOffering(termId, courseId, actor) {
  return sisTransaction(() => {
    if (!db.prepare("SELECT id FROM academic_terms WHERE id = ?").get(termId) || !db.prepare("SELECT id FROM courses WHERE id = ?").get(courseId)) return { error: "Term or course not found." };
    if (db.prepare("SELECT id FROM course_offerings WHERE term_id = ? AND course_id = ?").get(termId, courseId)) return { error: "Course is already offered in this term." };
    const offering = { id: crypto.randomUUID(), termId, courseId };
    db.prepare("INSERT INTO course_offerings (id, term_id, course_id) VALUES (?, ?, ?)").run(offering.id, termId, courseId);
    sisAudit(actor, "course_offered", null, { termId, courseId, offeringId: offering.id });
    return { offering };
  });
}

function getStudentCourses(userId) {
  const student = getStudentByUserId(userId);
  if (!student) return null;
  return db.prepare(`
    SELECT o.id AS offeringId, t.id AS termId, t.session_name AS sessionName, t.term_name AS termName,
      t.registration_open AS registrationOpen, c.id AS courseId, c.code, c.title, c.credit_units AS creditUnits,
      r.status AS registrationStatus, r.updated_at AS updatedAt
    FROM course_offerings o JOIN academic_terms t ON t.id = o.term_id JOIN courses c ON c.id = o.course_id
    LEFT JOIN course_registrations r ON r.offering_id = o.id AND r.user_id = ?
    WHERE c.program_id = ? AND (t.registration_open = 1 OR r.status IS NOT NULL)
    ORDER BY t.created_at DESC, c.code
  `).all(userId, student.programId).map((row) => ({ ...row, registrationOpen: Boolean(row.registrationOpen) }));
}

function changeCourseRegistration(userId, offeringId, status, actor) {
  return sisTransaction(() => {
    const student = getStudentByUserId(userId);
    if (!student) return { error: "Only matriculated students can register for courses." };
    const offering = db.prepare(`SELECT t.registration_open AS registrationOpen, c.program_id AS programId
      FROM course_offerings o JOIN academic_terms t ON t.id = o.term_id
      JOIN courses c ON c.id = o.course_id WHERE o.id = ?`).get(offeringId);
    if (!offering || offering.programId !== student.programId) return { error: "Course offering is not available for your programme." };
    if (!offering.registrationOpen) return { error: "Course registration is closed for this term." };
    if (status === "dropped" && db.prepare("SELECT 1 FROM academic_results WHERE user_id = ? AND offering_id = ?").get(userId, offeringId)) return { error: "A course with a recorded result cannot be dropped." };
    const existing = db.prepare("SELECT status FROM course_registrations WHERE user_id = ? AND offering_id = ?").get(userId, offeringId);
    if ((!existing && status === "dropped") || existing?.status === status) return { error: status === "registered" ? "Course is already registered." : "Course is not registered." };
    const updatedAt = new Date().toISOString();
    db.prepare("INSERT INTO course_registrations (user_id, offering_id, status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, offering_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at").run(userId, offeringId, status, updatedAt);
    createAuditLog({ invoiceNumber: null, actorType: "student", actorId: userId, actorLabel: actor.label, action: "course_registration_changed", note: null, metadata: { offeringId, status } });
    return { status, updatedAt };
  });
}

function createAttendanceMeeting(offeringId, meetingDate, label, actor) {
  return sisTransaction(() => {
    if (!db.prepare("SELECT 1 FROM course_offerings WHERE id = ?").get(offeringId)) return { error: "Course offering not found." };
    if (db.prepare("SELECT 1 FROM attendance_meetings WHERE offering_id = ? AND meeting_date = ? AND label = ? COLLATE NOCASE").get(offeringId, meetingDate, label)) return { error: "This meeting already exists for the course and date." };
    const meeting = { id: crypto.randomUUID(), offeringId, meetingDate, label, createdAt: new Date().toISOString() };
    db.prepare("INSERT INTO attendance_meetings (id, offering_id, meeting_date, label, created_at) VALUES (?, ?, ?, ?, ?)").run(meeting.id, offeringId, meetingDate, label, meeting.createdAt);
    sisAudit(actor, "attendance_meeting_created", null, { meetingId: meeting.id, offeringId, meetingDate, label });
    return { meeting };
  });
}

function listAttendanceMeetings() {
  return db.prepare(`SELECT m.id, m.offering_id AS offeringId, m.meeting_date AS meetingDate, m.label,
    c.code, c.title, t.session_name AS sessionName, t.term_name AS termName
    FROM attendance_meetings m JOIN course_offerings o ON o.id = m.offering_id JOIN courses c ON c.id = o.course_id
    JOIN academic_terms t ON t.id = o.term_id ORDER BY m.meeting_date DESC, c.code, m.label`).all();
}

function getAttendanceRoster(meetingId) {
  const meeting = db.prepare("SELECT id, offering_id AS offeringId, meeting_date AS meetingDate, label FROM attendance_meetings WHERE id = ?").get(meetingId);
  if (!meeting) return null;
  const roster = db.prepare(`SELECT s.user_id AS userId, s.matriculation_number AS matriculationNumber, u.surname, u.other_names AS otherNames,
    r.status AS registrationStatus, a.status, a.revision, a.updated_at AS updatedAt
    FROM course_registrations r JOIN students s ON s.user_id = r.user_id JOIN users u ON u.id = r.user_id
    LEFT JOIN attendance_records a ON a.user_id = r.user_id AND a.meeting_id = ?
    WHERE r.offering_id = ? AND (r.status = 'registered' OR a.status IS NOT NULL) ORDER BY u.surname, u.other_names`).all(meetingId, meeting.offeringId);
  return { meeting, roster };
}

function saveAttendance(meetingId, userId, status, expectedRevision, actor) {
  return sisTransaction(() => {
    const meeting = db.prepare("SELECT offering_id AS offeringId FROM attendance_meetings WHERE id = ?").get(meetingId);
    if (!meeting) return { error: "Meeting not found." };
    const registration = db.prepare("SELECT status FROM course_registrations WHERE user_id = ? AND offering_id = ?").get(userId, meeting.offeringId);
    if (registration?.status !== "registered") return { error: "Student is not currently registered for this course." };
    const previous = db.prepare("SELECT status, revision FROM attendance_records WHERE meeting_id = ? AND user_id = ?").get(meetingId, userId);
    if ((previous?.revision || null) !== expectedRevision) return { error: "Attendance changed. Refresh and review it before saving." };
    const updatedAt = new Date().toISOString();
    const revision = crypto.randomUUID();
    db.prepare(`INSERT INTO attendance_records (meeting_id, user_id, status, revision, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(meeting_id, user_id) DO UPDATE SET status = excluded.status, revision = excluded.revision, updated_at = excluded.updated_at`).run(meetingId, userId, status, revision, updatedAt);
    sisAudit(actor, "attendance_recorded", null, { meetingId, userId, previousStatus: previous?.status || null, status });
    return { status, revision, updatedAt };
  });
}

function getStudentAttendance(userId) {
  if (!getStudentByUserId(userId)) return null;
  return db.prepare(`SELECT m.id AS meetingId, m.meeting_date AS meetingDate, m.label, c.code, c.title,
    t.session_name AS sessionName, t.term_name AS termName, a.status, a.updated_at AS updatedAt
    FROM attendance_records a JOIN attendance_meetings m ON m.id = a.meeting_id JOIN course_offerings o ON o.id = m.offering_id
    JOIN courses c ON c.id = o.course_id JOIN academic_terms t ON t.id = o.term_id WHERE a.user_id = ?
    ORDER BY m.meeting_date DESC, c.code, m.label`).all(userId);
}

function getOperationalReport() {
  return {
    applications: db.prepare("SELECT status, COUNT(*) AS count FROM applications GROUP BY status ORDER BY status").all(),
    students: db.prepare("SELECT COUNT(*) AS count FROM students").get().count,
    registrations: db.prepare("SELECT status, COUNT(*) AS count FROM course_registrations GROUP BY status ORDER BY status").all(),
    publishedResults: db.prepare("SELECT COUNT(*) AS count FROM academic_results WHERE published_json IS NOT NULL").get().count,
    meetings: db.prepare("SELECT COUNT(*) AS count FROM attendance_meetings").get().count,
    attendance: db.prepare("SELECT status, COUNT(*) AS count FROM attendance_records GROUP BY status ORDER BY status").all(),
    studentFees: db.prepare("SELECT payment_status AS status, COUNT(*) AS count FROM invoices WHERE invoice_kind = 'student_fee' GROUP BY payment_status ORDER BY payment_status").all(),
  };
}

function createGradingScale(programId, name, bands, actor) {
  return sisTransaction(() => {
    if (!getProgramById(programId)) return { error: "Programme not found." };
    const scale = { id: crypto.randomUUID(), programId, name, bands, createdAt: new Date().toISOString() };
    db.prepare("INSERT INTO grading_scales (id, program_id, name, bands_json, created_at) VALUES (?, ?, ?, ?, ?)").run(scale.id, programId, name, JSON.stringify(bands), scale.createdAt);
    db.prepare("INSERT INTO programme_grading_scales (program_id, scale_id) VALUES (?, ?) ON CONFLICT(program_id) DO UPDATE SET scale_id = excluded.scale_id").run(programId, scale.id);
    sisAudit(actor, "grading_scale_created", null, { programId, scaleId: scale.id });
    return { scale };
  });
}

function listResultRoster() {
  const scales = db.prepare(`SELECT s.id, s.program_id AS programId, s.name, s.bands_json AS bandsJson, s.created_at AS createdAt
    FROM programme_grading_scales p JOIN grading_scales s ON s.id = p.scale_id`).all()
    .map(({ bandsJson, ...scale }) => ({ ...scale, bands: JSON.parse(bandsJson) }));
  const roster = db.prepare(`SELECT r.user_id AS userId, r.offering_id AS offeringId, u.surname, u.other_names AS otherNames,
    s.matriculation_number AS matriculationNumber, c.program_id AS programId, c.code, c.title, c.credit_units AS creditUnits,
    t.session_name AS sessionName, t.term_name AS termName, t.registration_open AS registrationOpen,
    ar.draft_score AS draftScore, ar.draft_reason AS draftReason, ar.draft_id AS draftId, ar.published_json AS publishedJson
    FROM course_registrations r JOIN students s ON s.user_id = r.user_id JOIN users u ON u.id = r.user_id
    JOIN course_offerings o ON o.id = r.offering_id JOIN courses c ON c.id = o.course_id
    JOIN academic_terms t ON t.id = o.term_id LEFT JOIN academic_results ar ON ar.user_id = r.user_id AND ar.offering_id = r.offering_id
    WHERE r.status = 'registered' ORDER BY t.created_at DESC, c.code, u.surname`).all()
    .map(({ publishedJson, ...row }) => ({ ...row, registrationOpen: Boolean(row.registrationOpen), published: publishedJson ? JSON.parse(publishedJson) : null }));
  return { scales, roster, programs: listPrograms() };
}

function saveResultDraft(userId, offeringId, score, reason, actor) {
  return sisTransaction(() => {
    const enrollment = db.prepare(`SELECT r.status, t.registration_open AS registrationOpen
      FROM course_registrations r JOIN course_offerings o ON o.id = r.offering_id
      JOIN academic_terms t ON t.id = o.term_id WHERE r.user_id = ? AND r.offering_id = ?`).get(userId, offeringId);
    if (!enrollment || enrollment.status !== "registered") return { error: "Student is not registered for this course." };
    if (enrollment.registrationOpen) return { error: "Close registration for this term before recording results." };
    const updatedAt = new Date().toISOString();
    db.prepare(`INSERT INTO academic_results (user_id, offering_id, draft_score, draft_reason, draft_id, draft_updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, offering_id) DO UPDATE SET draft_score = excluded.draft_score, draft_reason = excluded.draft_reason, draft_id = excluded.draft_id, draft_updated_at = excluded.draft_updated_at`).run(userId, offeringId, score, reason, crypto.randomUUID(), updatedAt);
    sisAudit(actor, "result_draft_saved", reason, { userId, offeringId });
    return { success: true };
  });
}

function publishResult(userId, offeringId, expectedDraftId, expectedScaleId, actor) {
  return sisTransaction(() => {
    const record = db.prepare(`SELECT r.status, t.registration_open AS registrationOpen, c.program_id AS programId,
      c.credit_units AS creditUnits, ar.draft_score AS draftScore, ar.draft_reason AS draftReason, ar.draft_id AS draftId, ar.published_json AS publishedJson
      FROM course_registrations r JOIN course_offerings o ON o.id = r.offering_id JOIN academic_terms t ON t.id = o.term_id
      JOIN courses c ON c.id = o.course_id LEFT JOIN academic_results ar ON ar.user_id = r.user_id AND ar.offering_id = r.offering_id
      WHERE r.user_id = ? AND r.offering_id = ?`).get(userId, offeringId);
    if (!record || record.status !== "registered") return { error: "Student is not registered for this course." };
    if (record.registrationOpen) return { error: "Close registration for this term before publishing results." };
    if (record.draftScore == null) return { error: "Save a draft score before publishing." };
    if (record.draftId !== expectedDraftId) return { error: "The draft changed. Refresh and review it before publishing." };
    const scale = db.prepare("SELECT s.id, s.name, s.bands_json AS bandsJson FROM programme_grading_scales p JOIN grading_scales s ON s.id = p.scale_id WHERE p.program_id = ?").get(record.programId);
    if (!scale) return { error: "Configure a grading scale for this programme before publishing." };
    if (scale.id !== expectedScaleId) return { error: "The grading scale changed. Refresh and review it before publishing." };
    const band = gradeScore(record.draftScore, JSON.parse(scale.bandsJson));
    if (!band) throw new Error("Stored grading scale does not cover the result score.");
    const previous = record.publishedJson ? JSON.parse(record.publishedJson) : null;
    const publication = { id: crypto.randomUUID(), version: (previous?.version || 0) + 1, score: record.draftScore, grade: band.label, gradePoints: band.gradePoints, creditUnits: record.creditUnits, scaleId: scale.id, scaleName: scale.name, reason: record.draftReason, publishedAt: new Date().toISOString() };
    db.prepare("INSERT INTO result_publications (id, user_id, offering_id, publication_json) VALUES (?, ?, ?, ?)").run(publication.id, userId, offeringId, JSON.stringify(publication));
    db.prepare("UPDATE academic_results SET draft_score = NULL, draft_reason = NULL, draft_id = NULL, draft_updated_at = NULL, published_json = ? WHERE user_id = ? AND offering_id = ?").run(JSON.stringify(publication), userId, offeringId);
    sisAudit(actor, "result_published", record.draftReason, { userId, offeringId, publicationId: publication.id, version: publication.version });
    return { publication };
  });
}

function getStudentPublishedResults(userId) {
  if (!getStudentByUserId(userId)) return null;
  return db.prepare(`SELECT ar.published_json AS publishedJson, c.code, c.title,
    t.session_name AS sessionName, t.term_name AS termName
    FROM academic_results ar JOIN course_offerings o ON o.id = ar.offering_id JOIN courses c ON c.id = o.course_id
    JOIN academic_terms t ON t.id = o.term_id WHERE ar.user_id = ? AND ar.published_json IS NOT NULL
    ORDER BY t.created_at DESC, c.code`).all(userId).map(({ publishedJson, ...row }) => {
      const { reason, ...publication } = JSON.parse(publishedJson);
      return { ...row, publication };
    });
}

function getResultHistory(userId, offeringId) {
  return db.prepare("SELECT publication_json AS publicationJson FROM result_publications WHERE user_id = ? AND offering_id = ?").all(userId, offeringId)
    .map((row) => {
      const publication = JSON.parse(row.publicationJson);
      const scale = db.prepare("SELECT name, bands_json AS bandsJson FROM grading_scales WHERE id = ?").get(publication.scaleId);
      if (!scale) throw new Error("Published result references a missing grading scale.");
      return { ...publication, scale: { name: scale.name, bands: JSON.parse(scale.bandsJson) } };
    }).sort((a, b) => b.version - a.version);
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

function buildUniqueInvoiceNumber() {
  // The number is short and human-friendly, so collisions are possible (the
  // timestamp part wraps every ~28 hours). Retry instead of failing the insert.
  const exists = db.prepare("SELECT 1 FROM invoices WHERE invoice_number = ?");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = buildInvoiceNumber();
    if (!exists.get(candidate)) {
      return candidate;
    }
  }
  throw new Error("Could not generate a unique invoice number.");
}

function createInvoice({ userId, amount, feeDescription, currency, invoiceKind = "application" }) {
  const now = new Date().toISOString();
  const invoice = {
    id: crypto.randomUUID(),
    userId,
    invoiceNumber: buildUniqueInvoiceNumber(),
    amount,
    feeDescription,
    invoiceKind,
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
      id, user_id, invoice_number, amount, fee_description, currency, invoice_kind,
      payment_status, payment_reference, payment_provider, paid_at, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    invoice.id,
    invoice.userId,
    invoice.invoiceNumber,
    invoice.amount,
    invoice.feeDescription,
    invoice.currency,
    invoice.invoiceKind,
    invoice.paymentStatus,
    invoice.paymentReference,
    invoice.paymentProvider,
    invoice.paidAt,
    invoice.updatedAt,
    invoice.createdAt
  );

  return invoice;
}

function createStudentFee({ userId, amount, feeDescription, currency, requestId }, actor) {
  return sisTransaction(() => {
    const previous = db.prepare("SELECT invoice_number FROM student_fee_requests WHERE request_id = ?").get(requestId);
    if (previous) {
      const invoice = getInvoiceByNumber(previous.invoice_number);
      if (!invoice) throw new Error("Student fee request references a missing invoice.");
      if (invoice.userId !== userId || invoice.amount !== amount || invoice.currency !== currency || invoice.feeDescription !== feeDescription) return { error: "Request ID was already used for a different student fee." };
      return { invoice };
    }
    if (!getStudentByUserId(userId)) return { error: "Student not found." };
    const invoice = createInvoice({ userId, amount, feeDescription, currency, invoiceKind: "student_fee" });
    db.prepare("INSERT INTO student_fee_requests (request_id, user_id, invoice_number) VALUES (?, ?, ?)").run(requestId, userId, invoice.invoiceNumber);
    createAuditLog({ invoiceNumber: invoice.invoiceNumber, actorType: "admin", actorId: actor.id, actorLabel: actor.label, action: "student_fee_assigned", note: feeDescription, metadata: { userId, amount, currency } });
    return { invoice };
  });
}

function listStudentFees(userId) {
  return db.prepare("SELECT * FROM invoices WHERE user_id = ? AND invoice_kind = 'student_fee' ORDER BY created_at DESC").all(userId).map(toInvoice);
}

function listStudentFeesForAdmin() {
  return db.prepare(`SELECT i.*, u.surname, u.other_names, u.email FROM invoices i JOIN users u ON u.id = i.user_id
    WHERE i.invoice_kind = 'student_fee' ORDER BY i.created_at DESC`).all().map((row) => ({
    ...toInvoice(row), surname: row.surname, otherNames: row.other_names, email: row.email,
  }));
}

function createAuditLog({
  invoiceNumber,
  actorType,
  actorId = null,
  actorLabel = null,
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
    actorLabel: actorLabel || describeActor(actorType, actorId),
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
      id, invoice_number, actor_type, actor_id, actor_label, action, before_status,
      after_status, note, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    log.id,
    log.invoiceNumber,
    log.actorType,
    log.actorId,
    log.actorLabel,
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
  actorLabel = null,
  action,
  note = null,
  metadata = null,
}) {
  const current = getInvoiceByNumber(invoiceNumber);
  if (!current) {
    return null;
  }

  if (["webhook", "gateway"].includes(actorType) && current.paymentStatus === "Paid") {
    if (paymentReference && paymentReference !== current.paymentReference) {
      createAuditLog({
        invoiceNumber,
        actorType,
        actorId,
        actorLabel,
        action: "duplicate_payment_received",
        beforeStatus: "Paid",
        afterStatus: "Paid",
        note: `Invoice already paid (${current.paymentReference || "no reference"}); received another successful payment ${paymentReference}. Review for refund.`,
        metadata,
      });
    }
    return current;
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
    actorLabel,
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
    actorLabel: opts.actorLabel || null,
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
  actorLabel = null,
  note,
  metadata = null,
}) {
  return updateInvoicePayment({
    invoiceNumber,
    status,
    paymentReference,
    paymentProvider,
    actorType: "admin",
    actorId,
    actorLabel,
    action: "manual_override",
    note,
    metadata: {
      source: "admin_console",
      ...(metadata || {}),
    },
  });
}

function getLatestInvoiceByUserId(userId) {
  const row = db
    .prepare("SELECT * FROM invoices WHERE user_id = ? AND invoice_kind = 'application' ORDER BY created_at DESC LIMIT 1")
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
        WHERE ${VALID_SUCCESS_TX}
        ORDER BY pt.received_at DESC
        LIMIT 1
      ) AS latest_success_reference,
      (
        SELECT pt.provider
        FROM payment_transactions pt
        WHERE ${VALID_SUCCESS_TX}
        ORDER BY pt.received_at DESC
        LIMIT 1
      ) AS latest_success_provider,
      (
        SELECT pt.received_at
        FROM payment_transactions pt
        WHERE ${VALID_SUCCESS_TX}
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
          WHERE ${VALID_SUCCESS_TX}
          ORDER BY pt.received_at DESC
          LIMIT 1
        ) AS latest_success_reference,
        (
          SELECT pt.provider
          FROM payment_transactions pt
          WHERE ${VALID_SUCCESS_TX}
          ORDER BY pt.received_at DESC
          LIMIT 1
        ) AS latest_success_provider,
        (
          SELECT pt.received_at
          FROM payment_transactions pt
          WHERE ${VALID_SUCCESS_TX}
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

function autoReconcileInvoices(actorId, actorLabel = null) {
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
      actorLabel: actorLabel || null,
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

function listAuditLogsByInvoice(invoiceNumber) {
  const rows = db
    .prepare("SELECT * FROM payment_audit_logs WHERE invoice_number = ? ORDER BY created_at DESC")
    .all(invoiceNumber);
  return rows.map(toAuditLog);
}

// Who/what moved the invoice into its current Paid state (webhook or admin).
function getPaymentConfirmation(invoiceNumber) {
  const row = db
    .prepare(
      `
      SELECT * FROM payment_audit_logs
      WHERE invoice_number = ? AND after_status = 'Paid' AND IFNULL(before_status, '') <> 'Paid'
      ORDER BY created_at DESC
      LIMIT 1
    `
    )
    .get(invoiceNumber);
  return toAuditLog(row);
}

function getSuccessfulTransactionByReference(invoiceNumber, gatewayReference) {
  if (!gatewayReference) return null;
  const row = db
    .prepare(
      `
      SELECT * FROM payment_transactions
      WHERE invoice_number = ? AND gateway_reference = ? AND signature_valid = 1
        AND LOWER(IFNULL(gateway_status, '')) IN ('success', 'successful', 'completed', 'paid')
      ORDER BY received_at DESC
      LIMIT 1
    `
    )
    .get(invoiceNumber, gatewayReference);
  return toPaymentTransaction(row);
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
  getInstitutionSettings,
  saveInstitutionSettings,
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
  listAcademicStructure,
  createSchool,
  createDepartment,
  assignProgrammeDepartment,
  listAdmissions,
  decideAdmission,
  matriculateStudent,
  getStudentByUserId,
  listStudents,
  listCourseCatalog,
  createAcademicTerm,
  setRegistrationOpen,
  createCourse,
  createCourseOffering,
  getStudentCourses,
  changeCourseRegistration,
  createAttendanceMeeting,
  listAttendanceMeetings,
  getAttendanceRoster,
  saveAttendance,
  getStudentAttendance,
  getOperationalReport,
  createGradingScale,
  listResultRoster,
  saveResultDraft,
  publishResult,
  getStudentPublishedResults,
  getResultHistory,
  createInvoice,
  createStudentFee,
  listStudentFees,
  listStudentFeesForAdmin,
  createAuditLog,
  recordPaymentTransaction,
  manualOverrideInvoice,
  updateInvoicePayment,
  listInvoicesForAdmin,
  listReconciliationRows,
  listRecentPaymentTransactions,
  listRecentAuditLogs,
  listPaymentHistoryByInvoice,
  listAuditLogsByInvoice,
  getPaymentConfirmation,
  getSuccessfulTransactionByReference,
  getReconciliationReport,
  autoReconcileInvoices,
  isSuccessGatewayStatus,
  normalizeGatewayStatus,
  markInvoicePaid,
  getInvoiceByNumber,
  getLatestInvoiceByUserId,
  getDashboardByUserId
};
