import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiRequest } from "../lib/api";
import { PortalBrand } from "../components/PortalBrand";

export function PortalInvoicePage() {
  const { invoiceNumber } = useParams();
  const navigate = useNavigate();
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);

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
          setError(err.message || "Failed to load invoice.");
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

  async function handlePayNow() {
    setPaying(true);
    setError("");
    try {
      await apiRequest(`/api/invoice/${invoiceNumber}/pay`, {
        method: "POST",
      });
      navigate("/dashboard");
    } catch (err) {
      setError(err.message || "Payment failed.");
    } finally {
      setPaying(false);
    }
  }

  if (loading) {
    return (
      <div className="portal-page">
        <div className="portal-card">
          <PortalBrand />
          <h1>Invoice</h1>
          <p className="portal-sub">Loading...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="portal-page">
        <div className="portal-card">
          <PortalBrand />
          <h1>Invoice</h1>
          <div className="portal-alert">{error}</div>
          <p className="portal-link-row">
            <Link to="/dashboard">Back to Dashboard</Link>
          </p>
        </div>
      </div>
    );
  }

  const invoice = payload?.invoice;

  return (
    <div className="portal-page">
      <div className="portal-card portal-wide">
        <PortalBrand />
        <h1>Application Invoice</h1>
        {error ? <div className="portal-alert">{error}</div> : null}
        <table className="portal-table">
          <tbody>
            <tr>
              <th>Invoice Number</th>
              <td>{invoice?.invoiceNumber}</td>
            </tr>
            <tr>
              <th>Applicant</th>
              <td>
                {payload?.user?.surname} {payload?.user?.otherNames}
              </td>
            </tr>
            <tr>
              <th>Program</th>
              <td>{payload?.program?.name || "N/A"}</td>
            </tr>
            <tr>
              <th>Fee</th>
              <td>{invoice?.feeDescription}</td>
            </tr>
            <tr>
              <th>Amount</th>
              <td>
                {invoice?.currency} {Number(invoice?.amount || 0).toLocaleString()}
              </td>
            </tr>
            <tr>
              <th>Status</th>
              <td>{invoice?.paymentStatus}</td>
            </tr>
            {invoice?.paymentReference ? (
              <tr>
                <th>Payment Reference</th>
                <td>{invoice.paymentReference}</td>
              </tr>
            ) : null}
          </tbody>
        </table>

        {invoice?.paymentStatus !== "Paid" ? (
          <button type="button" onClick={handlePayNow} disabled={paying}>
            {paying ? "Processing..." : "Pay Now (Mock)"}
          </button>
        ) : null}

        <p className="portal-link-row">
          <Link to="/dashboard">Back to Dashboard</Link>
        </p>
      </div>
    </div>
  );
}
