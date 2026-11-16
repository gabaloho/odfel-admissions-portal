import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AdminShell } from "../components/AdminShell";
import { apiRequest } from "../lib/api";

export function AdminCoursesPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setData(await apiRequest("/api/admin/sis/courses"));
  }
  function showError(err) {
    if (err.status === 401) navigate("/admin/login");
    else if (err.status === 403 && err.payload?.next) navigate(err.payload.next);
    else setError(err.message);
  }
  useEffect(() => { load().catch(showError); }, []);

  async function send(path, body, form) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await apiRequest(path, { method: "POST", body });
      if (form) form.reset();
      setMessage(result.message);
      await load();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }
  function submit(event, path, makeBody) {
    event.preventDefault();
    const form = event.currentTarget;
    send(path, makeBody(new FormData(form)), form);
  }

  return (
    <AdminShell title="Course Administration" subtitle="Create terms and courses, offer courses, and control registration windows.">
      {error ? <div className="portal-alert" role="alert">{error}</div> : null}
      {message ? <div className="portal-success" role="status">{message}</div> : null}
      {!data ? <p>{error ? "Records could not be loaded." : "Loading courses..."}</p> : <>
        <section>
          <h2>Academic sessions and terms</h2>
          <p>New terms start closed. Open or close registration manually; changes are audited.</p>
          <form className="portal-inline-grid" onSubmit={(event) => submit(event, "/api/admin/sis/terms", (form) => ({ sessionName: form.get("sessionName"), termName: form.get("termName") }))}>
            <label htmlFor="sessionName">Academic session</label>
            <input id="sessionName" name="sessionName" maxLength={100} placeholder="2026/2027" required />
            <label htmlFor="termName">Term or semester</label>
            <input id="termName" name="termName" maxLength={100} placeholder="First semester" required />
            <button disabled={busy}>Create term</button>
          </form>
          {data.terms.map((term) => <p key={term.id}>
            {term.sessionName} - {term.termName}: <strong>{term.registrationOpen ? "Open" : "Closed"}</strong>{" "}
            <button type="button" disabled={busy} onClick={() => send(`/api/admin/sis/terms/${term.id}/registration`, { open: !term.registrationOpen })}>
              {term.registrationOpen ? "Close registration" : "Open registration"}
            </button>
          </p>)}
        </section>
        <section>
          <h2>Programme courses</h2>
          <p>Courses belong to a programme and cannot currently be edited after creation. Check details before saving.</p>
          <form className="portal-inline-grid" onSubmit={(event) => submit(event, "/api/admin/sis/courses", (form) => ({ programId: form.get("programId"), code: form.get("code"), title: form.get("title"), creditUnits: Number(form.get("creditUnits")) }))}>
            <label htmlFor="course-program">Programme</label>
            <select id="course-program" name="programId" defaultValue="" required><option value="">Select programme</option>{data.programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}</select>
            <label htmlFor="course-code">Course code</label>
            <input id="course-code" name="code" maxLength={30} pattern="[A-Za-z0-9](?:[A-Za-z0-9_]|-)*" required />
            <label htmlFor="course-title">Course title</label>
            <input id="course-title" name="title" maxLength={190} required />
            <label htmlFor="course-credits">Credit units</label>
            <input id="course-credits" name="creditUnits" type="number" min="1" max="30" step="1" required />
            <button disabled={busy}>Create course</button>
          </form>
          <ul>{data.courses.map((course) => <li key={course.id}>{course.code}: {course.title} ({course.creditUnits} units) - {data.programs.find((program) => program.id === course.programId)?.name}</li>)}</ul>
        </section>
        <section>
          <h2>Course offerings</h2>
          <form className="portal-inline-grid" onSubmit={(event) => submit(event, "/api/admin/sis/offerings", (form) => ({ termId: form.get("termId"), courseId: form.get("courseId") }))}>
            <label htmlFor="offering-term">Term</label>
            <select id="offering-term" name="termId" defaultValue="" required><option value="">Select term</option>{data.terms.map((term) => <option key={term.id} value={term.id}>{term.sessionName} - {term.termName}</option>)}</select>
            <label htmlFor="offering-course">Course</label>
            <select id="offering-course" name="courseId" defaultValue="" required><option value="">Select course</option>{data.courses.map((course) => <option key={course.id} value={course.id}>{course.code}: {course.title} - {data.programs.find((program) => program.id === course.programId)?.name}</option>)}</select>
            <button disabled={busy}>Offer course</button>
          </form>
          <ul>{data.offerings.map((offering) => {
            const term = data.terms.find((value) => value.id === offering.termId);
            const course = data.courses.find((value) => value.id === offering.courseId);
            return <li key={offering.id}>{term?.sessionName} - {term?.termName}: {course?.code} - {course?.title}</li>;
          })}</ul>
        </section>
      </>}
    </AdminShell>
  );
}
