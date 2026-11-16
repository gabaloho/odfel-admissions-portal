import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PortalBrand } from "../components/PortalBrand";
import { apiRequest } from "../lib/api";

export function StudentAttendancePage() {
  const navigate = useNavigate();
  const [records, setRecords] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    apiRequest("/api/student/attendance").then((result) => setRecords(result.records)).catch((err) => {
      if (err.status === 401) navigate("/login");
      else setError(err.message);
    });
  }, []);
  return <div className="portal-page"><div className="portal-card portal-wide">
    <PortalBrand />
    <h1>Attendance</h1>
    <p className="portal-sub">Only attendance recorded by staff is shown. Unmarked meetings are not counted as absences.</p>
    {error ? <div className="portal-alert" role="alert">{error}</div> : null}
    {!records ? <p>{error ? "Attendance could not be loaded." : "Loading attendance..."}</p> : records.length ? <div className="portal-overflow"><table className="portal-table">
      <thead><tr><th>Date</th><th>Session / term</th><th>Course</th><th>Meeting</th><th>Status</th></tr></thead>
      <tbody>{records.map((record) => <tr key={record.meetingId}><td>{record.meetingDate}</td><td>{record.sessionName} / {record.termName}</td><td>{record.code}: {record.title}</td><td>{record.label}</td><td>{record.status}</td></tr>)}</tbody>
    </table></div> : <p>No attendance recorded yet.</p>}
    <p className="portal-link-row"><Link to="/dashboard">Back to dashboard</Link></p>
  </div></div>;
}
