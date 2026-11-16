const PAYSTACK_API_URL = "https://api.paystack.co";
const CHECKOUT_HOST = "checkout.paystack.com";
const REFERENCE_PATTERN = /^[A-Za-z0-9._=-]{1,100}$/;

function createPaystackClient({ secretKey, fetchImpl = globalThis.fetch }) {
  async function request(path, options = {}) {
    if (!secretKey) throw new Error("Paystack secret key is not configured.");
    if (typeof fetchImpl !== "function") throw new Error("Fetch is not available for Paystack requests.");

    const response = await fetchImpl(`${PAYSTACK_API_URL}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(10000),
    });

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`Paystack returned an invalid response (${response.status}).`);
    }
    if (!response.ok || result?.status !== true || !result.data || typeof result.data !== "object") {
      throw new Error(`Paystack request failed (${response.status}).`);
    }
    return result.data;
  }

  async function initializeTransaction({ email, amount, currency, reference, callbackUrl, metadata }) {
    if (!REFERENCE_PATTERN.test(String(reference || ""))) throw new Error("Invalid Paystack transaction reference.");
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Paystack amount must be a positive integer in minor units.");

    const data = await request("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email,
        amount: String(amount),
        currency,
        reference,
        callback_url: callbackUrl,
        metadata,
      }),
    });
    let checkoutUrl;
    try {
      checkoutUrl = new URL(data.authorization_url);
    } catch {
      throw new Error("Paystack returned an invalid checkout URL.");
    }
    if (
      checkoutUrl.protocol !== "https:" ||
      checkoutUrl.hostname !== CHECKOUT_HOST ||
      checkoutUrl.username ||
      checkoutUrl.password ||
      data.reference !== reference
    ) {
      throw new Error("Paystack returned an unexpected checkout response.");
    }
    return { checkoutUrl: checkoutUrl.toString(), reference: data.reference };
  }

  async function verifyTransaction(reference) {
    if (!REFERENCE_PATTERN.test(String(reference || ""))) throw new Error("Invalid Paystack transaction reference.");
    return request(`/transaction/verify/${encodeURIComponent(reference)}`, { method: "GET" });
  }

  return { initializeTransaction, verifyTransaction };
}

module.exports = { createPaystackClient };
