import { apiRequest } from "./api";

/**
 * Signs an applicant in (same API as the portal login page) and returns the
 * page to continue on, based on where they are in the application/billing flow:
 *
 * - "status":   the dashboard (application + payment status)
 * - "continue": pre-application if not started, the invoice if it is unpaid,
 *               otherwise the dashboard
 * - "print":    the invoice / payment receipt page (PDF download), or the
 *               pre-application if there is nothing to print yet
 */
export async function signInAndGetDestination({ email, password }, intent) {
  await apiRequest("/api/auth/login", { method: "POST", body: { email, password } });

  const { snapshot } = await apiRequest("/api/dashboard");
  const invoice = snapshot?.latestInvoice;

  if (intent === "continue") {
    if (!snapshot?.application) return "/pre-application";
    if (invoice && invoice.paymentStatus !== "Paid") return `/invoice/${invoice.invoiceNumber}`;
    return "/dashboard";
  }

  if (intent === "print") {
    if (invoice) return `/invoice/${invoice.invoiceNumber}`;
    if (!snapshot?.application) return "/pre-application";
    return "/dashboard";
  }

  return "/dashboard";
}
