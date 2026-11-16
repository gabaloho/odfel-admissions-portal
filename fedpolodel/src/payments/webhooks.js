const crypto = require("crypto");

// Signature headers per provider. "mock" is the local dummy-card gateway in
// src/payments/mockGateway.js; it uses the legacy Paystack raw-body HMAC format
// so local payments exercise the same validation path without accepting real cards.
const MOCK_SIGNATURE_HEADER = "x-mock-gateway-signature";

function safeCompareHex(signatureA, signatureB) {
  try {
    if (!/^[0-9a-f]{128}$/i.test(String(signatureA || ""))) return false;
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

function safeCompareText(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length === 0 || bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function hmacSha512Hex(secret, rawBody) {
  return crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
}

function detectWebhookProvider(headers) {
  if (headers["paystack-signature"] || headers["x-paystack-signature"]) return "paystack";
  if (headers["verif-hash"] || headers["x-flutterwave-signature"]) return "flutterwave";
  if (headers[MOCK_SIGNATURE_HEADER]) return "mock";
  return "unknown";
}

function verifyPaystackTimestampSignature(rawBody, header, secrets, now = Math.floor(Date.now() / 1000)) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== "string") return false;

  let timestamp = null;
  const signatures = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === "t") {
      if (timestamp !== null || !/^\d+$/.test(value)) return false;
      timestamp = Number(value);
    } else if (name === "v1") {
      const colon = value.indexOf(":");
      if (colon !== -1) signatures.push(value.slice(colon + 1));
    }
  }

  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300 || !signatures.length) return false;
  for (const secret of secrets) {
    if (typeof secret !== "string" || !secret) continue;
    const expected = crypto.createHmac("sha512", secret).update(`${timestamp}.`).update(rawBody).digest();
    for (const signature of signatures) {
      if (!/^[0-9a-f]{128}$/.test(signature)) continue;
      if (crypto.timingSafeEqual(expected, Buffer.from(signature, "hex"))) return true;
    }
  }
  return false;
}

function getPaystackMetadata(data) {
  if (data?.metadata && typeof data.metadata === "object") return data.metadata;
  if (typeof data?.metadata === "string") {
    try {
      const metadata = JSON.parse(data.metadata);
      return metadata && typeof metadata === "object" ? metadata : {};
    } catch {
      return {};
    }
  }
  return {};
}

function parseWebhookPayload(provider, payload) {
  const data = payload && payload.data ? payload.data : {};
  const eventType = payload?.event || payload?.type || "unknown";
  let invoiceNumber = null;
  let gatewayStatus = "unknown";
  let gatewayReference = null;
  let amount = null;
  let currency = null;

  if (provider === "paystack" || provider === "mock") {
    const metadata = getPaystackMetadata(data);
    invoiceNumber =
      metadata.invoiceNumber ||
      metadata.invoice_number ||
      data?.invoice_number ||
      null;
    gatewayStatus = data?.status || payload?.status || (eventType === "charge.success" ? "success" : "unknown");
    gatewayReference = data?.reference || data?.tx_ref || null;
    if (typeof data?.amount === "number") {
      // Paystack sends minor units (kobo/cents); the mock gateway sends major units.
      amount = provider === "paystack" ? data.amount / 100 : data.amount;
    }
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
    invoiceNumber: invoiceNumber == null ? null : String(invoiceNumber),
    gatewayStatus,
    gatewayReference: gatewayReference == null ? null : String(gatewayReference),
    amount: Number.isFinite(amount) ? amount : null,
    currency: currency ? String(currency).toUpperCase() : null,
  };
}

function toMinorUnits(value) {
  return Math.round(Number(value) * 100);
}

/**
 * Creates the single code path allowed to mark an invoice Paid on behalf of a
 * payment provider. Both the public POST /webhooks/payments route and the
 * in-process mock gateway call `processWebhook`.
 */
function createWebhookProcessor({
  store,
  secret,
  paystackSecretKey = secret,
  paystackWebhookSecrets = secret ? [secret] : [],
  expectedPaystackDomain = null,
  mockGatewayEnabled,
}) {
  function verifyWebhookSignature(provider, headers, rawBody) {
    if (provider === "paystack") {
      if (headers["paystack-signature"]) {
        return verifyPaystackTimestampSignature(rawBody, headers["paystack-signature"], paystackWebhookSecrets);
      }
      return Boolean(paystackSecretKey) && safeCompareHex(headers["x-paystack-signature"], hmacSha512Hex(paystackSecretKey, rawBody));
    }

    if (provider === "flutterwave") {
      const signature = headers["verif-hash"] || headers["x-flutterwave-signature"];
      return safeCompareText(signature, secret);
    }

    if (provider === "mock") {
      // Never accept mock-gateway events where the mock gateway is disabled.
      return Boolean(secret) && mockGatewayEnabled && safeCompareHex(headers[MOCK_SIGNATURE_HEADER], hmacSha512Hex(secret, rawBody));
    }

    return false;
  }

  function webhookActorLabel(provider, source) {
    if (source === "server_verification") {
      return `Paystack transaction verification (${provider}, server verified)`;
    }
    return `Payment gateway webhook (${provider}, signature verified)`;
  }

  /**
   * @returns {{ httpStatus: number, message: string, outcome: string, invoice?: object, parsed?: object }}
   */
  async function processWebhook({ headers = {}, rawBody, verificationSource = "webhook" }) {
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.alloc(0);
    const provider = detectWebhookProvider(headers);
    const signatureValid = verifyWebhookSignature(provider, headers, body);

    let payload = null;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      payload = null;
    }

    if (!signatureValid) {
      // Keep a record of rejected attempts for the admin console, but never act on them.
      const parsed = payload ? parseWebhookPayload(provider, payload) : {};
      await store.recordPaymentTransaction({
        invoiceNumber: parsed.invoiceNumber || null,
        userId: null,
        provider,
        eventType: parsed.eventType || null,
        gatewayStatus: parsed.gatewayStatus ? store.normalizeGatewayStatus(parsed.gatewayStatus) : null,
        gatewayReference: parsed.gatewayReference || null,
        amount: parsed.amount ?? null,
        currency: parsed.currency || null,
        signatureValid: false,
        payload: payload || { unparseableBody: true },
        processingNote: "Webhook signature verification failed. Rejected with 401.",
        processedAt: new Date().toISOString(),
      });
      return { httpStatus: 401, outcome: "invalid_signature", message: "Invalid webhook signature." };
    }

    if (!payload || typeof payload !== "object") {
      return { httpStatus: 400, outcome: "invalid_payload", message: "Invalid JSON payload." };
    }

    const parsed = parseWebhookPayload(provider, payload);
    const invoice = parsed.invoiceNumber ? await store.getInvoiceByNumber(parsed.invoiceNumber) : null;
    const isSuccess = store.isSuccessGatewayStatus(parsed.gatewayStatus);

    let processingNote = "Webhook signature verified.";
    let problem = null;
    if (invoice && isSuccess) {
      const domain = String(payload.data?.domain || "").toLowerCase();
      if (provider === "paystack" && expectedPaystackDomain && domain !== expectedPaystackDomain) {
        problem = `Paystack domain mismatch: expected ${expectedPaystackDomain}, received ${domain || "none"}.`;
      } else if (parsed.amount == null || toMinorUnits(parsed.amount) !== toMinorUnits(invoice.amount)) {
        problem = `Amount mismatch: gateway reported ${parsed.amount ?? "none"}, invoice is ${invoice.amount}.`;
      } else if (!parsed.currency || parsed.currency !== String(invoice.currency).toUpperCase()) {
        problem = `Currency mismatch: gateway reported ${parsed.currency || "none"}, invoice is ${invoice.currency}.`;
      }
      if (problem) {
        processingNote = `Webhook signature verified. Not applied: ${problem}`;
      }
    }

    await store.recordPaymentTransaction({
      invoiceNumber: parsed.invoiceNumber,
      userId: invoice ? invoice.userId : null,
      provider,
      eventType: parsed.eventType,
      gatewayStatus: store.normalizeGatewayStatus(parsed.gatewayStatus),
      gatewayReference: parsed.gatewayReference,
      amount: parsed.amount,
      currency: parsed.currency,
      signatureValid: true,
      payload,
      processingNote,
      processedAt: new Date().toISOString(),
    });

    if (!invoice) {
      return { httpStatus: 202, outcome: "invoice_not_found", message: "Webhook accepted. Invoice not matched.", parsed };
    }

    if (!isSuccess) {
      return {
        httpStatus: 200,
        outcome: "not_successful",
        message: `Webhook accepted. Gateway status '${store.normalizeGatewayStatus(parsed.gatewayStatus)}' does not change the invoice.`,
        invoice,
        parsed,
      };
    }

    if (problem) {
      await store.createAuditLog({
        invoiceNumber: invoice.invoiceNumber,
        actorType: verificationSource === "server_verification" ? "gateway" : "webhook",
        actorId: provider,
        actorLabel: webhookActorLabel(provider, verificationSource),
        action: "gateway_webhook_rejected",
        beforeStatus: invoice.paymentStatus,
        afterStatus: invoice.paymentStatus,
        note: problem,
        metadata: { eventType: parsed.eventType, reference: parsed.gatewayReference },
      });
      // 2xx so the provider does not retry a payload that will never be valid.
      return { httpStatus: 202, outcome: "validation_failed", message: `Webhook accepted but not applied. ${problem}`, invoice, parsed };
    }

    if (invoice.paymentStatus === "Paid") {
      // Idempotent: providers retry deliveries. Flag a *different* reference as a
      // possible duplicate charge for finance to refund.
      if (parsed.gatewayReference && parsed.gatewayReference !== invoice.paymentReference) {
        await store.createAuditLog({
          invoiceNumber: invoice.invoiceNumber,
          actorType: verificationSource === "server_verification" ? "gateway" : "webhook",
          actorId: provider,
          actorLabel: webhookActorLabel(provider, verificationSource),
          action: "duplicate_payment_received",
          beforeStatus: "Paid",
          afterStatus: "Paid",
          note: `Invoice already paid (${invoice.paymentReference || "no reference"}); received another successful payment ${parsed.gatewayReference}. Review for refund.`,
          metadata: { eventType: parsed.eventType },
        });
      }
      return { httpStatus: 200, outcome: "already_paid", message: "Webhook accepted. Invoice already paid.", invoice, parsed };
    }

    const updated = await store.markInvoicePaid(invoice.invoiceNumber, parsed.gatewayReference || null, {
      paymentProvider: provider,
      actorType: verificationSource === "server_verification" ? "gateway" : "webhook",
      actorId: provider,
      actorLabel: webhookActorLabel(provider, verificationSource),
      action: "gateway_webhook_success",
      note: `Gateway webhook verified payment of ${invoice.currency} ${invoice.amount} (${provider}).`,
      metadata: { eventType: parsed.eventType },
    });

    return { httpStatus: 200, outcome: "marked_paid", message: "Webhook accepted. Invoice marked as paid.", invoice: updated, parsed };
  }

  async function processVerifiedPaystackTransaction(transaction) {
    if (!paystackSecretKey) {
      throw new Error("Paystack secret key is not configured for server-side verification.");
    }
    const payload = {
      event: transaction?.status === "success" ? "charge.success" : "charge.failed",
      data: transaction,
    };
    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
    return processWebhook({
      headers: { "x-paystack-signature": hmacSha512Hex(paystackSecretKey, rawBody) },
      rawBody,
      verificationSource: "server_verification",
    });
  }

  return { processWebhook, processVerifiedPaystackTransaction };
}

module.exports = {
  MOCK_SIGNATURE_HEADER,
  createWebhookProcessor,
  detectWebhookProvider,
  hmacSha512Hex,
  parseWebhookPayload,
  verifyPaystackTimestampSignature,
};
