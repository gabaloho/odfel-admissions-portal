import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AdminShell } from "../components/AdminShell";
import { apiRequest } from "../lib/api";

function Counts({ title, rows }) {
  return <section><h2>{title}</h2>{rows.length ? <ul>{rows.map((row) => <li key={row.status}>{row.status}: {row.count}</li>)}</ul> : <p>No records.</p>}</section>;
}

export function AdminReportsPage() {
  const navigate = useNavigate();
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    apiRequest("/api/admin/sis/report").then((result) => setReport(result.report)).catch((err) => {
      if (err.status === 401) navigate("/admin/login");
      else if (err.status === 403 && err.payload?.next) navigate(err.payload.next);
      else setError(err.message);
    });
  }, []);
  return <AdminShell title="Operational Reports" subtitle="Current institution-wide record counts, not a financial or academic certification.">
    {error ? <div className="portal-alert" role="alert">{error}</div> : null}
    {!report ? <p>{error ? "Report could not be loaded." : "Loading report..."}</p> : <>
      <p>Matriculated students: <strong>{report.students}</strong></p>
      <p>Current published results: <strong>{report.publishedResults}</strong></p>
      <p>Course meetings: <strong>{report.meetings}</strong></p>
      <Counts title="Applications by status" rows={report.applications} />
      <Counts title="Course registrations by status" rows={report.registrations} />
      <Counts title="Recorded attendance by status" rows={report.attendance} />
      <Counts title="Student fee invoices by status" rows={report.studentFees} />
    </>}
  </AdminShell>;
}
