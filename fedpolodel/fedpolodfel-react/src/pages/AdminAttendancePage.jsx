import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AdminShell } from "../components/AdminShell";
import { apiRequest } from "../lib/api";

export function AdminAttendancePage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState("");
  const [roster, setRoster] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  function showError(err) {
    if (err.status === 401) navigate("/admin/login");
    else if (err.status === 403 && err.payload?.next) navigate(err.payload.next);
    else setError(err.message);
  }
  async function load() { setData(await apiRequest("/api/admin/sis/attendance")); }
  async function loadRoster(id) {
    setRoster(null);
    if (id) setRoster(await apiRequest(`/api/admin/sis/attendance/meetings/${encodeURIComponent(id)}`));
  }
  useEffect(() => { load().catch(showError); }, []);
  async function createMeeting(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await apiRequest("/api/admin/sis/attendance/meetings", { method: "POST", body: { offeringId: values.get("offeringId"), meetingDate: values.get("meetingDate"), label: values.get("label") } });
      form.reset();
      await load();
      setSelected(result.meeting.id);
      await loadRoster(result.meeting.id);
      setMessage(result.message);
    } catch (err) { showError(err); } finally { setBusy(false); }
  }
  async function chooseMeeting(id) {
    setSelected(id); setError(""); setMessage(""); setBusy(true);
    try { await loadRoster(id); } catch (err) { showError(err); } finally { setBusy(false); }
  }
  async function save(event, row) {
    event.preventDefault();
    const status = new FormData(event.currentTarget).get("status");
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await apiRequest(`/api/admin/sis/attendance/meetings/${encodeURIComponent(selected)}`, { method: "POST", body: { userId: row.userId, status, expectedRevision: row.revision } });
      await loadRoster(selected);
      setMessage(result.message);
    } catch (err) { showError(err); } finally { setBusy(false); }
  }

  return <AdminShell title="Attendance" subtitle="Record attendance for individual course meetings.">
    {error ? <div className="portal-alert" role="alert">{error}</div> : null}
    {message ? <div className="portal-success" role="status">{message}</div> : null}
    {!data ? <p>{error ? "Attendance could not be loaded." : "Loading attendance..."}</p> : <>
      <p>Each meeting has a date and label. Only currently registered students can be marked. Dropped students' previous records are retained.</p>
      <form className="portal-inline-grid" onSubmit={createMeeting}>
        <label htmlFor="meeting-offering">Course offering</label>
        <select id="meeting-offering" name="offeringId" defaultValue="" required><option value="">Select offering</option>{data.offerings.map((offering) => {
          const course = data.courses.find((item) => item.id === offering.courseId);
          const term = data.terms.find((item) => item.id === offering.termId);
          return <option key={offering.id} value={offering.id}>{term?.sessionName} / {term?.termName}: {course?.code} - {course?.title}</option>;
        })}</select>
        <label htmlFor="meeting-date">Meeting date</label>
        <input id="meeting-date" name="meetingDate" type="date" required />
        <label htmlFor="meeting-label">Meeting label</label>
        <input id="meeting-label" name="label" maxLength={100} placeholder="Lecture 1" required />
        <button disabled={busy}>Create meeting</button>
      </form>
      <h2>Meeting roster</h2>
      <label htmlFor="meeting-select">Meeting</label>{" "}
      <select id="meeting-select" value={selected} onChange={(event) => chooseMeeting(event.target.value)} disabled={busy}><option value="">Select meeting</option>{data.meetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.meetingDate} - {meeting.code}: {meeting.label} ({meeting.sessionName} / {meeting.termName})</option>)}</select>{" "}
      <button type="button" disabled={!selected || busy} onClick={() => chooseMeeting(selected)}>Reload roster</button>
      {selected && !roster ? <p>{error ? "Roster could not be loaded." : "Loading roster..."}</p> : null}
      {roster && !roster.roster.length ? <p>No registered students for this meeting.</p> : null}
      {roster?.roster.map((row) => <form key={`${row.userId}:${row.updatedAt}`} className="portal-inline-grid" onSubmit={(event) => save(event, row)}>
        <span>{row.matriculationNumber} - {row.surname} {row.otherNames}{row.registrationStatus === "dropped" ? " (dropped)" : ""}</span>
        <label htmlFor={`attendance-${row.userId}`}>Status</label>
        <select id={`attendance-${row.userId}`} name="status" defaultValue={row.status || ""} disabled={busy || row.registrationStatus !== "registered"} required>
          <option value="">Not marked</option><option value="present">Present</option><option value="absent">Absent</option><option value="late">Late</option><option value="excused">Excused</option>
        </select>
        <button disabled={busy || row.registrationStatus !== "registered"}>Save attendance</button>
      </form>)}
    </>}
  </AdminShell>;
}
