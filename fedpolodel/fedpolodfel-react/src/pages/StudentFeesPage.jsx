import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PortalBrand } from "../components/PortalBrand";
import { apiRequest } from "../lib/api";

export function StudentFeesPage() {
  const navigate = useNavigate();
  const [invoices, setInvoices] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    apiRequest("/api/student/fees").then((result) => setInvoices(result.invoices)).catch((err) => {
      if (err.status === 401) navigate("/login");
      else setError(err.message);
    });
  }, []);

  return <div className="portal-page"><div className="portal-card portal-wide">
    <PortalBrand />
    <h1>Student Fees</h1>
    <p className="portal-sub">View your assigned fees and pay each invoice in full.</p>
    {error ? <div className="portal-alert" role="alert">{error}</div> : null}
    {!invoices ? <p>{error ? "Fees could not be loaded." : "Loading fees..."}</p> : invoices.length ? <div className="portal-overflow"><table className="portal-table">
      <thead><tr><th>Invoice</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>{invoices.map((invoice) => <tr key={invoice.invoiceNumber}><td><Link to={`/invoice/${encodeURIComponent(invoice.invoiceNumber)}`}>{invoice.invoiceNumber}</Link></td><td>{invoice.feeDescription}</td><td>{invoice.currency} {Number(invoice.amount).toFixed(2)}</td><td>{invoice.paymentStatus}</td></tr>)}</tbody>
    </table></div> : <p>No student fees assigned yet.</p>}
    <p className="portal-link-row"><Link to="/dashboard">Back to dashboard</Link></p>
  </div></div>;
}
