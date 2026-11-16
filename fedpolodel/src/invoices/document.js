const PDFDocument = require("pdfkit");

function receiptNumberFor(invoiceNumber) {
  return String(invoiceNumber).replace(/^INV-/, "RCT-");
}

function formatMoney(amount, currency) {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// Applicant-facing description of who confirmed the payment. Admin usernames
// stay in the admin audit trail; applicants see the office.
function describeConfirmation(confirmation) {
  if (!confirmation) return null;
  if (confirmation.actorType === "webhook") {
    return {
      method: "gateway",
      label: "Payment gateway (verified)",
      at: confirmation.createdAt,
    };
  }
  if (confirmation.actorType === "admin") {
    return {
      method: "manual",
      label: "Finance office (manually verified)",
      at: confirmation.createdAt,
    };
  }
  return {
    method: "unverified",
    label: "Not verified (recorded before payment verification was enforced)",
    at: confirmation.createdAt,
  };
}

/**
 * Data model for the invoice page and PDF. Once an invoice is Paid it is
 * presented as a payment receipt.
 */
async function buildInvoiceDocument({ store, invoice, user, program, institutionName }) {
  const isPaid = invoice.paymentStatus === "Paid";
  const doc = {
    kind: isPaid ? "receipt" : "invoice",
    invoiceKind: invoice.invoiceKind || "application",
    title: isPaid ? "Payment Receipt" : invoice.invoiceKind === "student_fee" ? "Student Fee Invoice" : "Application Fee Invoice",
    institutionName,
    invoiceNumber: invoice.invoiceNumber,
    receiptNumber: isPaid ? receiptNumberFor(invoice.invoiceNumber) : null,
    issuedAt: invoice.createdAt,
    applicantName: user ? `${user.surname} ${user.otherNames}`.trim() : "",
    applicantEmail: user ? user.email : "",
    programName: program ? program.name : "N/A",
    feeDescription: invoice.feeDescription,
    amount: invoice.amount,
    currency: invoice.currency,
    amountFormatted: formatMoney(invoice.amount, invoice.currency),
    paymentStatus: invoice.paymentStatus,
    payment: null,
  };

  if (isPaid) {
    const confirmation = describeConfirmation(await store.getPaymentConfirmation(invoice.invoiceNumber));
    const tx = await store.getSuccessfulTransactionByReference(invoice.invoiceNumber, invoice.paymentReference);
    let cardSummary = null;
    if (tx) {
      try {
        const auth = JSON.parse(tx.payloadJson)?.data?.authorization;
        if (auth && auth.last4) {
          cardSummary = `${auth.brand || "Card"} ending ${String(auth.last4).slice(-4)}`;
        }
      } catch {
        cardSummary = null;
      }
    }
    doc.payment = {
      paidAt: invoice.paidAt,
      reference: invoice.paymentReference,
      provider: invoice.paymentProvider,
      method: cardSummary || (confirmation?.method === "manual" ? "Verified by finance office" : invoice.paymentProvider || ""),
      confirmedBy: confirmation ? confirmation.label : "Payment gateway / finance office",
      confirmedAt: confirmation ? confirmation.at : invoice.paidAt,
    };
  }

  return doc;
}

function drawCheckMark(pdf, x, y, size, color) {
  pdf
    .save()
    .lineWidth(size * 0.14)
    .lineCap("round")
    .lineJoin("round")
    .strokeColor(color)
    .moveTo(x, y + size * 0.55)
    .lineTo(x + size * 0.38, y + size * 0.9)
    .lineTo(x + size, y + size * 0.1)
    .stroke()
    .restore();
}

function drawPaidStamp(pdf) {
  const green = "#1f8a3b";
  const centerX = pdf.page.width / 2;
  const centerY = pdf.page.height / 2 - 40;

  pdf.save();
  pdf.rotate(-28, { origin: [centerX, centerY] });
  pdf.opacity(0.18);
  pdf.lineWidth(6).strokeColor(green).roundedRect(centerX - 190, centerY - 70, 380, 140, 18).stroke();
  drawCheckMark(pdf, centerX - 170, centerY - 45, 90, green);
  pdf
    .fillColor(green)
    .font("Helvetica-Bold")
    .fontSize(96)
    .text("PAID", centerX - 60, centerY - 48, { width: 240, align: "center", lineBreak: false });
  pdf.restore();
}

/** Streams the invoice/receipt PDF to a writable stream (e.g. an Express response). */
function renderInvoicePdf(document, output) {
  const pdf = new PDFDocument({ size: "A4", margin: 56, info: { Title: `${document.title} ${document.receiptNumber || document.invoiceNumber}` } });
  pdf.pipe(output);

  const isReceipt = document.kind === "receipt";
  const left = pdf.page.margins.left;
  const width = pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;

  if (isReceipt) {
    drawPaidStamp(pdf);
  }

  pdf.fillColor("#0d2a3a").font("Helvetica-Bold").fontSize(18).text(document.institutionName, left, 56, { width });
  pdf.fillColor("#476172").font("Helvetica").fontSize(10).text("ODFel Admissions Portal", { width });
  pdf.moveDown(1.2);

  pdf.fillColor(isReceipt ? "#1f6a2a" : "#0d2a3a").font("Helvetica-Bold").fontSize(22).text(document.title.toUpperCase(), { width });
  if (isReceipt) {
    const y = pdf.y + 4;
    drawCheckMark(pdf, left, y, 16, "#1f8a3b");
    pdf.fillColor("#1f6a2a").font("Helvetica-Bold").fontSize(12).text("Payment received - thank you", left + 24, y + 2, { width: width - 24 });
  }
  pdf.moveDown(1);

  const rows = [];
  if (isReceipt) rows.push(["Receipt Number", document.receiptNumber]);
  rows.push(["Invoice Number", document.invoiceNumber]);
  rows.push(["Issued", formatDateTime(document.issuedAt)]);
  rows.push([document.invoiceKind === "student_fee" ? "Student" : "Applicant", document.applicantName]);
  if (document.applicantEmail) rows.push(["Email", document.applicantEmail]);
  rows.push(["Programme", document.programName]);
  rows.push(["Description", document.feeDescription]);
  rows.push([isReceipt ? "Amount Paid" : "Amount Due", document.amountFormatted]);
  rows.push(["Status", document.paymentStatus]);
  if (isReceipt && document.payment) {
    rows.push(["Paid On", formatDateTime(document.payment.paidAt)]);
    if (document.payment.reference) rows.push(["Payment Reference", document.payment.reference]);
    if (document.payment.method) rows.push(["Payment Method", document.payment.method]);
    rows.push(["Confirmed By", document.payment.confirmedBy]);
  }

  const labelWidth = 150;
  let y = pdf.y;
  for (const [label, value] of rows) {
    const valueText = String(value == null || value === "" ? "-" : value);
    const rowHeight = Math.max(
      22,
      pdf.font("Helvetica").fontSize(11).heightOfString(valueText, { width: width - labelWidth - 16 }) + 10
    );
    pdf.lineWidth(0.5).strokeColor("#dde4ea").rect(left, y, width, rowHeight).stroke();
    pdf.fillColor("#476172").font("Helvetica-Bold").fontSize(10).text(label, left + 8, y + 6, { width: labelWidth - 8 });
    pdf.fillColor("#0d2a3a").font("Helvetica").fontSize(11).text(valueText, left + labelWidth, y + 6, { width: width - labelWidth - 16 });
    y += rowHeight;
  }

  pdf.y = y + 18;
  pdf.x = left;
  pdf.fillColor("#476172").font("Helvetica").fontSize(9);
  if (isReceipt) {
    pdf.text(`This receipt confirms payment of the ${document.invoiceKind === "student_fee" ? "student" : "application"} fee shown above. Payment status is set only by a verified payment gateway notification or by the finance office.`, { width });
  } else {
    pdf.text(`Pay this invoice online from your ${document.invoiceKind === "student_fee" ? "student fees page" : "applicant dashboard"}. Your invoice becomes a payment receipt once the payment is verified.`, { width });
  }
  pdf.moveDown(0.5).text(`Generated ${formatDateTime(new Date().toISOString())}`, { width });

  pdf.end();
}

module.exports = {
  buildInvoiceDocument,
  renderInvoicePdf,
  receiptNumberFor,
};
