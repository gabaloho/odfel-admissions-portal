import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AdminShell } from "../components/AdminShell";
import { apiRequest } from "../lib/api";

const pendingKey = "pending-student-fee";
const empty = { userId: "", feeDescription: "", currency: "", amount: "" };

export function AdminStudentFeesPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(empty);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  function showError(err) {
    if (err.status === 401) navigate("/admin/login");
    else if (err.status === 403 && err.payload?.next) navigate(err.payload.next);
    else setError(err.message);
  }
  async function load() {
    const result = await apiRequest("/api/admin/student-fees");
    setData(result);
    return result;
  }
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(pendingKey);
      if (saved) {
        const request = JSON.parse(saved);
        setPending(request);
        setForm({ userId: request.userId, feeDescription: request.feeDescription, currency: request.currency, amount: request.amount });
      }
      load().then((result) => {
        if (!saved) setForm((current) => ({ ...current, currency: result.currency }));
      }).catch(showError);
    } catch (err) {
      setError(`Unable to restore the pending fee request: ${err.message}`);
    }
  }, []);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const request = pending || { ...form, requestId: crypto.randomUUID() };
      if (!pending) {
        sessionStorage.setItem(pendingKey, JSON.stringify(request));
        setPending(request);
      }
      const result = await apiRequest("/api/admin/student-fees", { method: "POST", body: request });
      sessionStorage.removeItem(pendingKey);
      setPending(null);
      setForm({ ...empty, currency: data.currency });
      setMessage(`Student fee assigned: ${result.invoice.invoiceNumber}.`);
      await load();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }
  function forgetPending() {
    if (!window.confirm("The previous request may already have created an invoice. Check the list before starting a new assignment. Forget this retry?")) return;
    try {
      sessionStorage.removeItem(pendingKey);
      setPending(null);
    } catch (err) {
      setError(`Unable to clear the pending request: ${err.message}`);
    }
  }
  const change = (event) => setForm({ ...form, [event.target.name]: event.target.value });

  return <AdminShell title="Student Fees" subtitle="Assign individual invoices to matriculated students.">
    {error ? <div className="portal-alert" role="alert">{error}</div> : null}
    {message ? <div className="portal-success" role="status">{message}</div> : null}
    {!data ? <p>{error ? "Fees could not be loaded." : "Loading fees..."}</p> : <>
      <p>Check existing invoices before assigning a fee. Each new assignment creates a separate invoice; amounts are paid in full.</p>
      {pending ? <div className="portal-alert" role="status">A request is awaiting confirmation. Retry it without changing its details, or check the invoice list before forgetting it. <button type="button" disabled={busy} onClick={forgetPending}>Forget pending retry</button></div> : null}
      <form className="portal-inline-grid" onSubmit={submit}>
        <label htmlFor="fee-student">Student</label>
        <select id="fee-student" name="userId" value={form.userId} onChange={change} disabled={Boolean(pending)} required><option value="">Select student</option>{data.students.map((student) => <option key={student.userId} value={student.userId}>{student.matriculationNumber} - {student.surname} {student.otherNames}</option>)}</select>
        <label htmlFor="fee-description">Fee description</label>
        <input id="fee-description" name="feeDescription" value={form.feeDescription} onChange={change} maxLength={190} disabled={Boolean(pending)} required />
        <label htmlFor="fee-currency">Currency</label>
        <input id="fee-currency" name="currency" value={form.currency} onChange={change} pattern="[A-Za-z]{3}" maxLength={3} disabled={Boolean(pending)} required />
        <label htmlFor="fee-amount">Amount</label>
        <input id="fee-amount" name="amount" value={form.amount} onChange={change} inputMode="decimal" pattern="[0-9]{1,12}(\.[0-9]{1,2})?" disabled={Boolean(pending)} required />
        <button disabled={busy}>{busy ? "Saving..." : pending ? "Retry assignment" : "Assign fee"}</button>
      </form>
      <h2>Student fee invoices</h2>
      {data.invoices.length ? <div className="portal-overflow"><table className="portal-table"><thead><tr><th>Student</th><th>Invoice</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead><tbody>
        {data.invoices.map((invoice) => <tr key={invoice.invoiceNumber}><td>{invoice.surname} {invoice.otherNames}</td><td><a href={`/api/admin/invoices/${encodeURIComponent(invoice.invoiceNumber)}/pdf`} target="_blank" rel="noreferrer">{invoice.invoiceNumber}</a></td><td>{invoice.feeDescription}</td><td>{invoice.currency} {Number(invoice.amount).toFixed(2)}</td><td>{invoice.paymentStatus}</td></tr>)}
      </tbody></table></div> : <p>No student fees assigned yet.</p>}
    </>}
  </AdminShell>;
}
