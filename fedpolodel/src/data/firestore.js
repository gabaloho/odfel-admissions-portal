const crypto = require("crypto");
const bcrypt = require("bcryptjs");

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
      const application = { ...existing, programId, modeOfStudy, previousInstitution, notes: notes || "", updatedAt: timestamp };
      tx.set(target, application);
      return application;
    });
  }
  const getApplicationByUserId = (userId) => get("applications", userId);
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
  return { ensureSeed, getAdminByUsername, getAdminById, listAdminUsers, createAdminUser, setAdminActive, resetAdminPassword, updateAdminRole, isAdminPasswordExpired, changeOwnAdminPassword, createUser, getUserByEmail, getUserById, listPrograms, getProgramById, createOrUpdateApplication, getApplicationByUserId, createInvoice, createAuditLog, recordPaymentTransaction, manualOverrideInvoice, updateInvoicePayment, listInvoicesForAdmin, listReconciliationRows, listRecentPaymentTransactions, listRecentAuditLogs, listPaymentHistoryByInvoice, listAuditLogsByInvoice, getPaymentConfirmation, getSuccessfulTransactionByReference, getReconciliationReport, autoReconcileInvoices, isSuccessGatewayStatus, normalizeGatewayStatus, markInvoicePaid, getInvoiceByNumber, getLatestInvoiceByUserId, getDashboardByUserId };
}

module.exports = { createFirestoreStore };
