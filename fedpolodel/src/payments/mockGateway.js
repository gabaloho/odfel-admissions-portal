const crypto = require("crypto");
const { MOCK_SIGNATURE_HEADER, hmacSha512Hex } = require("./webhooks");

// Local stand-in for a hosted card gateway. It only accepts these published
// test numbers so nobody types a real card into a development portal. The full
// card number is never stored or logged; only brand + last four digits.
const TEST_CARDS = {
  "4242424242424242": { brand: "Visa", outcome: "success" },
  "5555555555554444": { brand: "Mastercard", outcome: "success" },
  "4000000000000002": { brand: "Visa", outcome: "declined", reason: "Card declined." },
  "4000000000009995": { brand: "Visa", outcome: "declined", reason: "Insufficient funds." },
};

const PUBLIC_TEST_CARDS = Object.entries(TEST_CARDS).map(([number, card]) => ({
  number: number.replace(/(\d{4})(?=\d)/g, "$1 "),
  brand: card.brand,
  result: card.outcome === "success" ? "Approved" : `Declined: ${card.reason}`,
}));

function validateCard(input = {}) {
  const cardholderName = String(input.cardholderName || "").trim();
  const number = String(input.cardNumber || "").replace(/[\s-]/g, "");
  const expiry = String(input.expiry || "").trim();
  const cvc = String(input.cvc || "").trim();

  if (!cardholderName) {
    return { error: "Enter the cardholder name." };
  }
  if (!/^\d{12,19}$/.test(number)) {
    return { error: "Enter a valid card number." };
  }
  const testCard = TEST_CARDS[number];
  if (!testCard) {
    return { error: "Test mode: only the listed dummy card numbers are accepted (e.g. 4242 4242 4242 4242)." };
  }

  const match = /^(\d{2})\s*\/\s*(\d{2}|\d{4})$/.exec(expiry);
  if (!match) {
    return { error: "Enter the expiry date as MM/YY." };
  }
  const month = Number(match[1]);
  const year = match[2].length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
  if (month < 1 || month > 12) {
    return { error: "Enter a valid expiry month." };
  }
  const now = new Date();
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) {
    return { error: "This card has expired." };
  }
  if (!/^\d{3,4}$/.test(cvc)) {
    return { error: "Enter a valid CVC." };
  }

  return {
    card: {
      brand: testCard.brand,
      last4: number.slice(-4),
      outcome: testCard.outcome,
      reason: testCard.reason || null,
    },
  };
}

function createMockGateway({ secret, webhookProcessor }) {
  /**
   * Charges the invoice amount (taken from the database record, never from the
   * client) and reports the result to the webhook processor as a signed event,
   * exactly as a hosted gateway would. The applicant's request never sets the
   * payment status itself.
   */
  async function charge({ invoice, card }) {
    const success = card.outcome === "success";
    const reference = `MOCKCH-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const payload = {
      event: success ? "charge.success" : "charge.failed",
      data: {
        status: success ? "success" : "failed",
        reference,
        amount: invoice.amount,
        currency: invoice.currency,
        gateway_response: success ? "Approved" : card.reason,
        paid_at: success ? new Date().toISOString() : null,
        metadata: { invoiceNumber: invoice.invoiceNumber },
        authorization: { brand: card.brand, last4: card.last4 },
      },
    };

    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
    const result = await webhookProcessor.processWebhook({
      headers: {
        "content-type": "application/json",
        [MOCK_SIGNATURE_HEADER]: hmacSha512Hex(secret, rawBody),
      },
      rawBody,
    });

    return { success, reference, declineReason: success ? null : card.reason, webhook: result };
  }

  return { charge };
}

module.exports = {
  PUBLIC_TEST_CARDS,
  createMockGateway,
  validateCard,
};
