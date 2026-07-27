import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiRequest } from "../lib/api";
import { AdminShell } from "../components/AdminShell";

const STATUSES = ["", "Paid", "Unpaid", "Pending", "Failed"];

export function AdminPaymentsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const status = searchParams.get("status") || "";
  const q = searchParams.get("q") || "";

  useEffect(() => {
    let mounted = true;

    async function loadPayments() {
      setLoading(true);
      setError("");
      try {
        const result = await apiRequest(`/api/admin/payments?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`);
        if (mounted) {
          setData(result);
        }
      } catch (err) {
        if (err.status === 401) {
          navigate("/admin/login");
          return;
        }
        if (mounted) {
          setError(err.message || "Failed to load admin payments.");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    loadPayments();
    return () => {
      mounted = false;
    };
  }, [navigate, q, status]);

  const exportHref = useMemo(() => {
    return `/admin/payments/export.csv?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`;
  }, [q, status]);

  function applyFilter(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const nextStatus = String(formData.get("status") || "");
    const nextQ = String(formData.get("q") || "");

    const params = new URLSearchParams();
    if (nextStatus) params.set("status", nextStatus);
    if (nextQ) params.set("q", nextQ);
    setSearchParams(params);
  }

  async function handleReconcile() {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await apiRequest("/api/admin/reconcile", { method: "POST" });
      setSuccess(result.message || "Reconciliation completed.");
      const refreshed = await apiRequest(`/api/admin/payments?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`);
      setData(refreshed);
    } catch (err) {
      setError(err.message || "Reconciliation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleOverride(invoiceNumber, formData) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await apiRequest(`/api/admin/invoices/${invoiceNumber}/override`, {
        method: "POST",
        body: {
          status: String(formData.get("status") || ""),
          paymentReference: String(formData.get("paymentReference") || ""),
          paymentProvider: String(formData.get("paymentProvider") || ""),
          note: String(formData.get("note") || ""),
        },
      });
      setSuccess(result.message || "Manual override completed.");

      const refreshed = await apiRequest(`/api/admin/payments?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`);
      setData(refreshed);
    } catch (err) {
      setError(err.message || "Manual override failed.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <AdminShell title="Payment Verification and Reconciliation" subtitle="Loading admin payment data...">
        <p className="portal-sub">Loading...</p>
      </AdminShell>
    );
  }

  return (
    <AdminShell
      title="Payment Verification and Reconciliation"
      subtitle={`Signed in as ${data?.currentAdmin?.username || ""} (${data?.currentAdmin?.role || ""})`}
    >
        {error ? <div className="portal-alert">{error}</div> : null}
        {success ? <div className="portal-success">{success}</div> : null}

        <form onSubmit={applyFilter} className="portal-inline-grid">
          <label htmlFor="admin-status">Status</label>
          <select id="admin-status" name="status" defaultValue={status}>
            {STATUSES.map((item) => (
              <option key={item || "all"} value={item}>
                {item || "All"}
              </option>
            ))}
          </select>

          <label htmlFor="admin-q">Search</label>
          <input id="admin-q" name="q" defaultValue={q} placeholder="Invoice, reference, email" />

          <button type="submit" disabled={busy}>Apply Filter</button>
          <a className="portal-link-btn" href={exportHref}>Download Reconciliation CSV</a>
          {data?.canManageAdmins ? (
            <a className="portal-link-btn" href="/admin/users">Manage Admin Users</a>
          ) : null}
        </form>

        <section>
          <h2>Reconciliation Summary</h2>
          <p>
            Mismatch (success tx but invoice not paid): <strong>{data?.reconciliation?.payableMismatch?.length || 0}</strong>
          </p>
          <p>
            Paid invoice without success tx: <strong>{data?.reconciliation?.paidWithoutTx?.length || 0}</strong>
          </p>
          {data?.canReconcile ? (
            <button type="button" onClick={handleReconcile} disabled={busy}>
              Auto Reconcile Mismatches
            </button>
          ) : (
            <p>Read-only role: reconciliation is disabled.</p>
          )}
        </section>

        <section>
          <h2>Invoices</h2>
          <div className="portal-overflow">
            <table className="portal-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Applicant</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Reference</th>
                  <th>Provider</th>
                  <th>Manual Override</th>
                </tr>
              </thead>
              <tbody>
                {data?.invoices?.length ? (
                  data.invoices.map((invoice) => (
                    <tr key={invoice.invoiceNumber}>
                      <td>{invoice.invoiceNumber}</td>
                      <td>
                        {invoice.applicantSurname} {invoice.applicantOtherNames}
                        <br />
                        <small>{invoice.applicantEmail}</small>
                      </td>
                      <td>
                        {invoice.currency} {Number(invoice.amount).toLocaleString()}
                      </td>
                      <td>{invoice.paymentStatus}</td>
                      <td>{invoice.paymentReference || "-"}</td>
                      <td>{invoice.paymentProvider || "-"}</td>
                      <td>
                        {data.canWrite ? (
                          <form
                            className="portal-override-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              handleOverride(invoice.invoiceNumber, new FormData(event.currentTarget));
                            }}
                          >
                            <select name="status" defaultValue={invoice.paymentStatus} required>
                              {STATUSES.filter(Boolean).map((item) => (
                                <option key={item} value={item}>
                                  {item}
                                </option>
                              ))}
                            </select>
                            <input name="paymentReference" defaultValue={invoice.paymentReference || ""} placeholder="Reference" />
                            <input name="paymentProvider" defaultValue={invoice.paymentProvider || ""} placeholder="Provider" />
                            <input name="note" placeholder="Reason / note" required />
                            <button type="submit" disabled={busy}>Save</button>
                          </form>
                        ) : (
                          <span>Read-only role</span>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="7">No invoices found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2>Recent Payment Transactions</h2>
          <div className="portal-overflow">
            <table className="portal-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Invoice</th>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Reference</th>
                  <th>Signature</th>
                </tr>
              </thead>
              <tbody>
                {data?.transactions?.length ? (
                  data.transactions.map((tx) => (
                    <tr key={tx.id}>
                      <td>{tx.receivedAt}</td>
                      <td>{tx.invoiceNumber || "-"}</td>
                      <td>{tx.provider}</td>
                      <td>{tx.gatewayStatus || "-"}</td>
                      <td>{tx.gatewayReference || "-"}</td>
                      <td>{tx.signatureValid ? "Valid" : "Invalid"}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="6">No transactions yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2>Audit Trail</h2>
          <div className="portal-overflow">
            <table className="portal-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Invoice</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Before</th>
                  <th>After</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {data?.audits?.length ? (
                  data.audits.map((a) => (
                    <tr key={a.id}>
                      <td>{a.createdAt}</td>
                      <td>{a.invoiceNumber || "-"}</td>
                      <td>
                        {a.actorType}
                        {a.actorId ? ` (${a.actorId})` : ""}
                      </td>
                      <td>{a.action}</td>
                      <td>{a.beforeStatus || "-"}</td>
                      <td>{a.afterStatus || "-"}</td>
                      <td>{a.note || "-"}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="7">No audit logs yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
    </AdminShell>
  );
}
