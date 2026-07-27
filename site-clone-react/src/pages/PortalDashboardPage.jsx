import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiRequest } from "../lib/api";

export function PortalDashboardPage() {
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function loadDashboard() {
      try {
        const result = await apiRequest("/api/dashboard");
        if (mounted) {
          setSnapshot(result.snapshot || null);
        }
      } catch (err) {
        if (err.status === 302 || err.status === 401) {
          navigate("/login");
          return;
        }
        if (mounted) {
          setError(err.message || "Failed to load dashboard.");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    loadDashboard();
    return () => {
      mounted = false;
    };
  }, [navigate]);

  async function logout() {
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
    } finally {
      navigate("/login");
    }
  }

  if (loading) {
    return (
      <div className="portal-page">
        <div className="portal-card">
          <h1>Applicant Dashboard</h1>
          <p className="portal-sub">Loading...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="portal-page">
        <div className="portal-card">
          <h1>Applicant Dashboard</h1>
          <div className="portal-alert">{error}</div>
          <p className="portal-link-row">
            <Link to="/login">Back to Login</Link>
          </p>
        </div>
      </div>
    );
  }

  const latestInvoice = snapshot?.latestInvoice;

  return (
    <div className="portal-page">
      <div className="portal-card portal-wide">
        <div className="portal-row">
          <div>
            <h1>Applicant Dashboard</h1>
            <p className="portal-sub">
              Welcome, {snapshot?.user?.surname} {snapshot?.user?.otherNames}
            </p>
          </div>
          <button type="button" onClick={logout} className="portal-secondary-btn">
            Logout
          </button>
        </div>

        <section>
          <h2>Application</h2>
          {snapshot?.application ? (
            <table className="portal-table">
              <tbody>
                <tr>
                  <th>Program</th>
                  <td>{snapshot?.program?.name || "N/A"}</td>
                </tr>
                <tr>
                  <th>Mode</th>
                  <td>{snapshot.application.modeOfStudy}</td>
                </tr>
                <tr>
                  <th>Status</th>
                  <td>{snapshot.application.status}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p>No pre-application found yet.</p>
          )}
          <p className="portal-link-row">
            <Link to="/pre-application">Update Pre-Application</Link>
          </p>
        </section>

        <section>
          <h2>Invoice</h2>
          {latestInvoice ? (
            <table className="portal-table">
              <tbody>
                <tr>
                  <th>Invoice Number</th>
                  <td>{latestInvoice.invoiceNumber}</td>
                </tr>
                <tr>
                  <th>Amount</th>
                  <td>
                    {latestInvoice.currency} {Number(latestInvoice.amount).toLocaleString()}
                  </td>
                </tr>
                <tr>
                  <th>Status</th>
                  <td>{latestInvoice.paymentStatus}</td>
                </tr>
                {latestInvoice.paymentReference ? (
                  <tr>
                    <th>Reference</th>
                    <td>{latestInvoice.paymentReference}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          ) : (
            <p>No invoice generated yet.</p>
          )}

          {latestInvoice ? (
            <p className="portal-link-row">
              <Link to={`/invoice/${latestInvoice.invoiceNumber}`}>Open Invoice</Link>
            </p>
          ) : (
            <p className="portal-link-row">
              <Link to="/pre-application">Generate Invoice</Link>
            </p>
          )}
        </section>

        <section>
          <h2>Payment History</h2>
          {snapshot?.paymentHistory?.length ? (
            <table className="portal-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Reference</th>
                  <th>Signature</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.paymentHistory.map((tx) => (
                  <tr key={tx.id}>
                    <td>{tx.receivedAt}</td>
                    <td>{tx.provider}</td>
                    <td>{tx.gatewayStatus || "-"}</td>
                    <td>{tx.gatewayReference || "-"}</td>
                    <td>{tx.signatureValid ? "Valid" : "Invalid"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No payment events recorded yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}
