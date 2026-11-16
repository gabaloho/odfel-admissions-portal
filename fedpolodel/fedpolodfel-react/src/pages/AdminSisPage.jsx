import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AdminShell } from "../components/AdminShell";
import { apiRequest } from "../lib/api";

export function AdminSisPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [structure, admissions, students] = await Promise.all([
      apiRequest("/api/admin/sis/structure"),
      apiRequest("/api/admin/sis/admissions"),
      apiRequest("/api/admin/sis/students"),
    ]);
    setData({ ...structure, applications: admissions.applications, students: students.students });
  }

  function showError(err) {
    if (err.status === 401) navigate("/admin/login");
    else if (err.status === 403 && err.payload?.next) navigate(err.payload.next);
    else setError(err.message);
  }

  useEffect(() => { load().catch(showError); }, []);

  async function submit(event, path, makeBody) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = makeBody(new FormData(form));
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await apiRequest(path, { method: "POST", body });
      form.reset();
      setMessage(result.message);
      await load();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminShell title="Student Information" subtitle="Manage academic structure, admission decisions and matriculation. Super-admin access required.">
      {error ? <div className="portal-alert" role="alert">{error}</div> : null}
      {message ? <div className="portal-success" role="status">{message}</div> : null}
      {!data ? <p>{error ? "Records could not be loaded." : "Loading records..."}</p> : <>
        <section>
          <h2>Academic structure</h2>
          <p>Create schools and departments, then assign each admissions programme to a department before matriculation.</p>
          <form className="portal-inline-grid" onSubmit={(event) => submit(event, "/api/admin/sis/schools", (form) => ({ name: form.get("name") }))}>
            <label htmlFor="school-name">New school name</label>
            <input id="school-name" name="name" maxLength={190} required />
            <button disabled={busy}>Add school</button>
          </form>
          <form className="portal-inline-grid" onSubmit={(event) => submit(event, "/api/admin/sis/departments", (form) => ({ schoolId: form.get("schoolId"), name: form.get("name") }))}>
            <label htmlFor="department-school">School</label>
            <select id="department-school" name="schoolId" defaultValue="" required>
              <option value="">Select school</option>
              {data.schools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}
            </select>
            <label htmlFor="department-name">New department name</label>
            <input id="department-name" name="name" maxLength={190} required />
            <button disabled={busy}>Add department</button>
          </form>
          <form className="portal-inline-grid" onSubmit={(event) => submit(event, "/api/admin/sis/programme-department", (form) => ({ programId: form.get("programId"), departmentId: form.get("departmentId") }))}>
            <label htmlFor="assignment-programme">Programme</label>
            <select id="assignment-programme" name="programId" defaultValue="" required>
              <option value="">Select programme</option>
              {data.programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
            </select>
            <label htmlFor="assignment-department">Department</label>
            <select id="assignment-department" name="departmentId" defaultValue="" required>
              <option value="">Select department</option>
              {data.departments.map((department) => <option key={department.id} value={department.id}>{data.schools.find((school) => school.id === department.schoolId)?.name} / {department.name}</option>)}
            </select>
            <button disabled={busy}>Assign programme</button>
          </form>
          <ul>
            {data.schools.map((school) => <li key={school.id}>{school.name}
              <ul>{data.departments.filter((department) => department.schoolId === school.id).map((department) => <li key={department.id}>{department.name}
                <ul>{data.assignments.filter((assignment) => assignment.departmentId === department.id).map((assignment) => <li key={assignment.programId}>{data.programs.find((program) => program.id === assignment.programId)?.name}</li>)}</ul>
              </li>)}</ul>
            </li>)}
          </ul>
          <p>Reassigning a programme does not change students already matriculated.</p>
        </section>
        <section>
          <h2>Admissions</h2>
          <p>Review applications independently of payment. Decisions can be corrected before matriculation; applicants cannot edit a decided application. Matriculation is a separate, final step.</p>
          {data.applications.length ? data.applications.map((application) => (
            <article key={application.userId}>
              <h3>{application.surname} {application.otherNames}</h3>
              <p>{application.email} | {application.programName} | {application.modeOfStudy} | {application.status}</p>
              <p>Previous institution: {application.previousInstitution} | Payment: {application.paymentStatus || "No invoice"}</p>
              {application.notes ? <p>Applicant notes: {application.notes}</p> : null}
              {application.status !== "Matriculated" ? <form className="portal-inline-grid" onSubmit={(event) => submit(event, `/api/admin/sis/admissions/${application.userId}/decision`, (form) => ({ decision: form.get("decision"), note: form.get("note") }))}>
                <label htmlFor={`decision-${application.userId}`}>Decision</label>
                <select id={`decision-${application.userId}`} name="decision" defaultValue="" required>
                  <option value="">Select decision</option><option value="Admitted">Admit</option><option value="Rejected">Reject</option>
                </select>
                <label htmlFor={`reason-${application.userId}`}>Decision reason (staff audit)</label>
                <input id={`reason-${application.userId}`} name="note" maxLength={1000} required />
                <button disabled={busy}>Save decision</button>
              </form> : null}
              {application.status === "Admitted" ? <form className="portal-inline-grid" onSubmit={(event) => submit(event, `/api/admin/sis/admissions/${application.userId}/matriculate`, (form) => ({ matriculationNumber: form.get("matriculationNumber") }))}>
                <label htmlFor={`number-${application.userId}`}>Institution-issued matriculation number</label>
                <input id={`number-${application.userId}`} name="matriculationNumber" maxLength={60} pattern="[A-Za-z0-9](?:[A-Za-z0-9_]|/|-)*" required />
                <button disabled={busy}>Matriculate student</button>
              </form> : null}
            </article>
          )) : <p>No applications yet.</p>}
        </section>
        <section>
          <h2>Students</h2>
          <div className="portal-overflow"><table className="portal-table">
            <thead><tr><th>Matriculation number</th><th>Name</th><th>Programme</th><th>Department</th><th>School</th></tr></thead>
            <tbody>{data.students.map((student) => <tr key={student.userId}><td>{student.matriculationNumber}</td><td>{student.surname} {student.otherNames}</td><td>{student.programName}</td><td>{student.departmentName}</td><td>{student.schoolName}</td></tr>)}</tbody>
          </table></div>
          {!data.students.length ? <p>No matriculated students yet.</p> : null}
        </section>
      </>}
    </AdminShell>
  );
}
