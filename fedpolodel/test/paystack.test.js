const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createPaystackClient } = require("../src/payments/paystack");
const { createWebhookProcessor } = require("../src/payments/webhooks");

test("Paystack initializes hosted checkout with the server-supplied amount and verifies by reference", async () => {
  const requests = [];
  const client = createPaystackClient({
    secretKey: "sk_test_private",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/transaction/initialize")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: {
              authorization_url: "https://checkout.paystack.com/checkout-id",
              reference: "ODFEL-test-123",
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: true, data: { status: "success" } }) };
    },
  });

  const initialized = await client.initializeTransaction({
    email: "applicant@example.com",
    amount: 2500000,
    currency: "NGN",
    reference: "ODFEL-test-123",
    callbackUrl: "https://portal.example.com/payments/callback",
    metadata: { invoiceNumber: "INV-123" },
  });
  assert.equal(initialized.checkoutUrl, "https://checkout.paystack.com/checkout-id");
  assert.equal(requests[0].options.headers.authorization, "Bearer sk_test_private");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    email: "applicant@example.com",
    amount: "2500000",
    currency: "NGN",
    reference: "ODFEL-test-123",
    callback_url: "https://portal.example.com/payments/callback",
    metadata: { invoiceNumber: "INV-123" },
  });

  await client.verifyTransaction("ODFEL-test-123");
  assert.equal(requests[1].url, "https://api.paystack.co/transaction/verify/ODFEL-test-123");
  assert.equal(requests[1].options.method, "GET");
});

test("Paystack rejects unsafe checkout responses and invalid references", async () => {
  const client = createPaystackClient({
    secretKey: "sk_test_private",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        data: { authorization_url: "https://attacker.example/steal", reference: "ODFEL-test-123" },
      }),
    }),
  });
  await assert.rejects(client.initializeTransaction({
    email: "applicant@example.com",
    amount: 2500000,
    currency: "NGN",
    reference: "ODFEL-test-123",
    callbackUrl: "https://portal.example.com/payments/callback",
    metadata: { invoiceNumber: "INV-123" },
  }), /unexpected checkout response/);
  await assert.rejects(client.verifyTransaction("../other"), /Invalid Paystack transaction reference/);
});

test("timestamped Paystack-Signature validates exact raw body and applies only matching payments", async () => {
  const secret = "whsec_test_secret";
  const invoice = { invoiceNumber: "INV-123", userId: "user-1", amount: 25000, currency: "NGN", paymentStatus: "Unpaid" };
  const recorded = [];
  const audits = [];
  const store = {
    normalizeGatewayStatus: (value) => String(value).toLowerCase(),
    isSuccessGatewayStatus: (value) => ["success", "successful", "completed", "paid"].includes(String(value).toLowerCase()),
    getInvoiceByNumber: async (number) => number === invoice.invoiceNumber ? invoice : null,
    recordPaymentTransaction: async (entry) => recorded.push(entry),
    createAuditLog: async (entry) => audits.push(entry),
    markInvoicePaid: async (number, reference) => Object.assign(invoice, { paymentStatus: "Paid", paymentReference: reference }),
  };
  const processor = createWebhookProcessor({
    store,
    paystackSecretKey: "sk_test_private",
    paystackWebhookSecrets: [secret],
    mockGatewayEnabled: false,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const rawBody = Buffer.from('{"event":"charge.success","data":{"status":"success","reference":"ODFEL-123","amount":2500000,"currency":"NGN","metadata":{"invoiceNumber":"INV-123"}}}');
  const signature = crypto.createHmac("sha512", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  const result = await processor.processWebhook({
    headers: { "paystack-signature": `t=${timestamp},v1=whk_test:${signature}` },
    rawBody,
  });

  assert.equal(result.outcome, "marked_paid");
  assert.equal(result.invoice.paymentStatus, "Paid");
  assert.equal(recorded[0].signatureValid, true);

  const verified = await processor.processVerifiedPaystackTransaction({
    status: "success",
    reference: "ODFEL-verified",
    amount: 2500000,
    currency: "NGN",
    metadata: { invoiceNumber: "INV-123" },
  });
  assert.equal(verified.outcome, "already_paid");
  assert.match(audits.at(-1).actorLabel, /server verified/);

  const staleTimestamp = timestamp - 301;
  const staleSignature = crypto.createHmac("sha512", secret).update(`${staleTimestamp}.`).update(rawBody).digest("hex");
  const rejected = await processor.processWebhook({
    headers: { "paystack-signature": `t=${staleTimestamp},v1=whk_test:${staleSignature}` },
    rawBody,
  });
  assert.equal(rejected.httpStatus, 401);
});

test("production Paystack processing rejects successful test-domain transactions", async () => {
  const invoice = { invoiceNumber: "INV-456", userId: "user-2", amount: 25000, currency: "NGN", paymentStatus: "Unpaid" };
  let markPaidCalls = 0;
  const store = {
    normalizeGatewayStatus: (value) => String(value).toLowerCase(),
    isSuccessGatewayStatus: (value) => String(value).toLowerCase() === "success",
    getInvoiceByNumber: async () => invoice,
    recordPaymentTransaction: async () => {},
    createAuditLog: async () => {},
    markInvoicePaid: async () => { markPaidCalls++; },
  };
  const processor = createWebhookProcessor({
    store,
    paystackSecretKey: "sk_live_private",
    expectedPaystackDomain: "live",
  });
  const result = await processor.processVerifiedPaystackTransaction({
    status: "success",
    domain: "test",
    reference: "ODFEL-test-domain",
    amount: 2500000,
    currency: "NGN",
    metadata: { invoiceNumber: invoice.invoiceNumber },
  });

  assert.equal(result.outcome, "validation_failed");
  assert.equal(markPaidCalls, 0);
});
