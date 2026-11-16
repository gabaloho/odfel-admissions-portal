import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiRequest } from "../lib/api";
import { PortalBrand } from "../components/PortalBrand";
import { ShareReceiptDialog } from "../components/ShareReceiptDialog";

const EMPTY_CARD = { cardholderName: "", cardNumber: "", expiry: "", cvc: "" };

function formatDateTime(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function buildShareText(doc) {
  return [
    `Payment receipt ${doc.receiptNumber}`,
    doc.institutionName,
    `${doc.feeDescription}: ${doc.amountFormatted} paid`,
    `Applicant: ${doc.applicantName}`,
    `Paid on: ${formatDateTime(doc.payment?.paidAt)}`,
    `Reference: ${doc.payment?.reference || "-"}`,
    `Confirmed by: ${doc.payment?.confirmedBy || "-"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatCardNumber(value) {
  return value.replace(/\D/g, "").slice(0, 19).replace(/(\d{4})(?=\d)/g, "$1 ");
}

function formatExpiry(value) {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

export function PortalInvoicePage() {
  const { invoiceNumber } = useParams();
  const navigate = useNavigate();
  const [payload, setPayload] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);

  const [showCheckout, setShowCheckout] = useState(false);
  const [card, setCard] = useState(EMPTY_CARD);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState("");
  const [notice, setNotice] = useState("");
  const [receiptFile, setReceiptFile] = useState(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function loadInvoice() {
      try {
        const result = await apiRequest(`/api/invoice/${invoiceNumber}`);
        if (mounted) {
          setPayload(result);
        }
      } catch (err) {
        if (err.status === 302 || err.status === 401) {
          navigate("/login");
          return;
        }
        if (mounted) {
          setLoadError(err.message || "Failed to load invoice.");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    loadInvoice();
    return () => {
      mounted = false;
    };
  }, [invoiceNumber, navigate]);

  const pdfUrl = `/api/invoice/${encodeURIComponent(invoiceNumber)}/pdf`;
  const receiptKind = payload?.document?.kind;
  const receiptNumber = payload?.document?.receiptNumber;
  const receiptFileName = receiptNumber ? `payment-receipt-${receiptNumber}.pdf` : "payment-receipt.pdf";

  // Phones only open the share sheet if navigator.share() is called directly in
  // the tap handler (Safari drops the "user gesture" across an await). So the
  // PDF is fetched ahead of time and the Share button never waits on the network.
  useEffect(() => {
    if (receiptKind !== "receipt" || !navigator.canShare) return undefined;
    let cancelled = false;
    fetch(pdfUrl, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!cancelled && blob) {
          setReceiptFile(new File([blob], receiptFileName, { type: "application/pdf" }));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [receiptKind, pdfUrl, receiptFileName]);

  async function handleCheckout(event) {
    event.preventDefault();
    setPaying(true);
    setPayError("");
    setNotice("");
    try {
      // Only card details are sent. The server charges the stored invoice
      // amount and the invoice becomes Paid when the gateway confirms it.
      const result = await apiRequest(`/api/invoice/${invoiceNumber}/checkout`, {
        method: "POST",
        body: checkout.mode === "test" ? card : {},
      });
      if (result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
        return;
      }
      setPayload((prev) => ({
        ...prev,
        invoice: result.invoice,
        document: result.document,
        checkout: { ...(prev?.checkout || {}), enabled: false },
      }));
      setCard(EMPTY_CARD);
      setShowCheckout(false);
      setNotice(result.message || "Payment successful.");
    } catch (err) {
      if (err.status === 401) {
        navigate("/login");
        return;
      }
      if (err.status === 409) {
        // Already paid (e.g. in another tab or confirmed by the finance office): show the receipt.
        const fresh = await apiRequest(`/api/invoice/${invoiceNumber}`).catch(() => null);
        if (fresh) {
          setPayload(fresh);
          setShowCheckout(false);
          setNotice("This invoice has already been paid.");
          return;
        }
      }
      setPayError(err.message || "Payment failed.");
    } finally {
      setPaying(false);
    }
  }

  // Must stay synchronous up to navigator.share() (see the prefetch above).
  function handleShare() {
    setNotice("");
    const doc = payload?.document;
    const shareData = { title: `Payment receipt ${doc.receiptNumber}`, text: buildShareText(doc) };

    if (receiptFile && navigator.canShare?.({ files: [receiptFile] })) {
      shareData.files = [receiptFile];
    }

    if (navigator.share) {
      navigator.share(shareData).catch((err) => {
        if (err?.name === "AbortError") return; // the user closed the share sheet
        setShareDialogOpen(true); // share sheet refused: offer the in-app options instead
      });
      return;
    }

    // No native share sheet (most desktop browsers, or a phone on plain http://).
    setShareDialogOpen(true);
  }

  if (loading || loadError) {
    return (
      <div className="portal-page">
        <div className="portal-card">
          <PortalBrand />
          <h1>Invoice</h1>
          {loading ? <p className="portal-sub">Loading...</p> : <div className="portal-alert">{loadError}</div>}
          {!loading ? (
            <p className="portal-link-row">
              <Link to="/dashboard">Back to Dashboard</Link>
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const doc = payload?.document;
  const isReceipt = doc?.kind === "receipt";
  const checkout = payload?.checkout || {};

  return (
    <div className="portal-page">
      <div className={`portal-card portal-wide invoice-card${isReceipt ? " is-paid" : ""}`}>
        {isReceipt ? (
          <div className="paid-stamp" aria-hidden="true">
            <i className="bi bi-check-lg" />
            <span>PAID</span>
          </div>
        ) : null}

        <PortalBrand />
        <h1>{doc?.title}</h1>

        {isReceipt ? (
          <div className="portal-success invoice-paid-banner" role="status">
            <i className="bi bi-check-circle-fill" aria-hidden="true" /> Payment received. This invoice is now your
            payment receipt.
          </div>
        ) : null}
        {!isReceipt && new URLSearchParams(window.location.search).get("payment") === "success" ? (
          <div className="portal-success" role="status">Paystack verified your payment. Your receipt is ready.</div>
        ) : null}
        {!isReceipt && new URLSearchParams(window.location.search).get("payment") === "pending" ? (
          <div className="portal-alert" role="status">Payment is not confirmed yet. Refresh this page shortly; do not pay again while it is processing.</div>
        ) : null}
        {notice ? <div className="portal-success">{notice}</div> : null}

        <table className="portal-table">
          <tbody>
            {isReceipt ? (
              <tr>
                <th>Receipt Number</th>
                <td>{doc.receiptNumber}</td>
              </tr>
            ) : null}
            <tr>
              <th>Invoice Number</th>
              <td>{doc?.invoiceNumber}</td>
            </tr>
            <tr>
              <th>Applicant</th>
              <td>{doc?.applicantName}</td>
            </tr>
            <tr>
              <th>Program</th>
              <td>{doc?.programName}</td>
            </tr>
            <tr>
              <th>Fee</th>
              <td>{doc?.feeDescription}</td>
            </tr>
            <tr>
              <th>{isReceipt ? "Amount Paid" : "Amount Due"}</th>
              <td>
                <strong>{doc?.amountFormatted}</strong>
              </td>
            </tr>
            <tr>
              <th>Status</th>
              <td>
                {isReceipt ? (
                  <span className="status-paid">
                    <i className="bi bi-check-circle-fill" aria-hidden="true" /> Paid
                  </span>
                ) : (
                  doc?.paymentStatus
                )}
              </td>
            </tr>
            {isReceipt ? (
              <>
                <tr>
                  <th>Paid On</th>
                  <td>{formatDateTime(doc.payment?.paidAt)}</td>
                </tr>
                {doc.payment?.reference ? (
                  <tr>
                    <th>Payment Reference</th>
                    <td>{doc.payment.reference}</td>
                  </tr>
                ) : null}
                {doc.payment?.method ? (
                  <tr>
                    <th>Payment Method</th>
                    <td>{doc.payment.method}</td>
                  </tr>
                ) : null}
                <tr>
                  <th>Confirmed By</th>
                  <td>{doc.payment?.confirmedBy}</td>
                </tr>
              </>
            ) : null}
          </tbody>
        </table>

        <div className="invoice-actions">
          <a className="portal-link-btn" href={pdfUrl} download>
            <i className="bi bi-download" aria-hidden="true" /> {isReceipt ? "Download Receipt (PDF)" : "Download Invoice (PDF)"}
          </a>
          {isReceipt ? (
            <button type="button" className="portal-secondary-btn" onClick={handleShare}>
              <i className="bi bi-share" aria-hidden="true" /> Share Receipt
            </button>
          ) : null}
          {!isReceipt && checkout.enabled && !showCheckout ? (
            <button type="button" onClick={() => setShowCheckout(true)}>
              <i className="bi bi-credit-card" aria-hidden="true" /> Pay {doc?.amountFormatted}{checkout.mode === "paystack" ? " with Paystack" : " by Card"}
            </button>
          ) : null}
        </div>

        {!isReceipt && checkout.noAmountDue ? (
          <p className="portal-sub">There is no amount due on this invoice. Contact the admissions office if you have questions.</p>
        ) : null}
        {!isReceipt && !checkout.enabled && !checkout.noAmountDue ? (
          <p className="portal-sub">
            Online card payment is not available. Contact the finance office; your invoice will be marked as paid once
            they verify your payment.
          </p>
        ) : null}

        {!isReceipt && checkout.enabled && showCheckout && checkout.mode === "test" ? (
          <form className="portal-form checkout-form" onSubmit={handleCheckout}>
            <h2>Card Payment</h2>
            <div className="checkout-test-note">
              <strong>Test mode - no real money is charged.</strong> Use a dummy card with any future expiry date and any
              3-digit CVC:
              <ul>
                {(checkout.testCards || []).map((testCard) => (
                  <li key={testCard.number}>
                    <code>{testCard.number}</code> ({testCard.brand}) - {testCard.result}
                  </li>
                ))}
              </ul>
            </div>
            {payError ? <div className="portal-alert">{payError}</div> : null}

            <label htmlFor="cardholderName">Cardholder name</label>
            <input
              id="cardholderName"
              autoComplete="cc-name"
              value={card.cardholderName}
              onChange={(e) => setCard({ ...card, cardholderName: e.target.value })}
              required
            />

            <label htmlFor="cardNumber">Card number</label>
            <input
              id="cardNumber"
              inputMode="numeric"
              autoComplete="cc-number"
              placeholder="4242 4242 4242 4242"
              value={card.cardNumber}
              onChange={(e) => setCard({ ...card, cardNumber: formatCardNumber(e.target.value) })}
              required
            />

            <div className="checkout-row">
              <div>
                <label htmlFor="cardExpiry">Expiry (MM/YY)</label>
                <input
                  id="cardExpiry"
                  inputMode="numeric"
                  autoComplete="cc-exp"
                  placeholder="12/30"
                  value={card.expiry}
                  onChange={(e) => setCard({ ...card, expiry: formatExpiry(e.target.value) })}
                  required
                />
              </div>
              <div>
                <label htmlFor="cardCvc">CVC</label>
                <input
                  id="cardCvc"
                  inputMode="numeric"
                  autoComplete="cc-csc"
                  placeholder="123"
                  maxLength={4}
                  value={card.cvc}
                  onChange={(e) => setCard({ ...card, cvc: e.target.value.replace(/\D/g, "") })}
                  required
                />
              </div>
            </div>

            <div className="invoice-actions">
              <button type="submit" disabled={paying}>
                {paying ? "Processing payment..." : `Pay ${doc?.amountFormatted}`}
              </button>
              <button
                type="button"
                className="portal-secondary-btn"
                disabled={paying}
                onClick={() => {
                  setShowCheckout(false);
                  setPayError("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}
        {!isReceipt && checkout.enabled && showCheckout && checkout.mode === "paystack" ? (
          <form className="portal-form checkout-form" onSubmit={handleCheckout}>
            <h2>Secure Payment</h2>
            <p>You will be redirected to Paystack to complete your payment securely. Your invoice updates after Paystack confirms the transaction.</p>
            {payError ? <div className="portal-alert">{payError}</div> : null}
            <div className="invoice-actions">
              <button type="submit" disabled={paying}>
                {paying ? "Connecting to Paystack..." : "Continue to Paystack"}
              </button>
              <button
                type="button"
                className="portal-secondary-btn"
                disabled={paying}
                onClick={() => {
                  setShowCheckout(false);
                  setPayError("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        <p className="portal-link-row">
          <Link to="/dashboard">Back to Dashboard</Link>
        </p>
      </div>

      {isReceipt && shareDialogOpen ? (
        <ShareReceiptDialog
          title={`Payment receipt ${doc.receiptNumber}`}
          text={buildShareText(doc)}
          pdfUrl={pdfUrl}
          pdfFileName={receiptFileName}
          onClose={() => setShareDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
