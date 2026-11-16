import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PortalBrand } from "../components/PortalBrand";
import { apiRequest } from "../lib/api";

export function StudentCoursesPage() {
  const navigate = useNavigate();
  const [courses, setCourses] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const result = await apiRequest("/api/student/courses");
    setCourses(result.courses);
  }
  function showError(err) {
    if (err.status === 401) navigate("/login");
    else setError(err.message);
  }
  useEffect(() => { load().catch(showError); }, []);

  async function change(offeringId, status) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await apiRequest(`/api/student/courses/${offeringId}`, { method: "POST", body: { status } });
      setMessage(result.message);
      await load();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="portal-page"><div className="portal-card portal-wide">
      <PortalBrand />
      <h1>Course Registration</h1>
      <p className="portal-sub">Add or drop courses for your programme while registration is open.</p>
      {error ? <div className="portal-alert" role="alert">{error}</div> : null}
      {message ? <div className="portal-success" role="status">{message}</div> : null}
      {!courses ? <p>{error ? "Courses could not be loaded." : "Loading courses..."}</p> : courses.length ? (
        <div className="portal-overflow"><table className="portal-table">
          <thead><tr><th>Session / term</th><th>Course</th><th>Units</th><th>Registration</th><th>Action</th></tr></thead>
          <tbody>{courses.map((course) => <tr key={course.offeringId}>
            <td>{course.sessionName} / {course.termName}</td>
            <td>{course.code}: {course.title}</td>
            <td>{course.creditUnits}</td>
            <td>{course.registrationStatus || "Not registered"} ({course.registrationOpen ? "open" : "closed"})</td>
            <td>{course.registrationOpen ? <button type="button" disabled={busy} onClick={() => change(course.offeringId, course.registrationStatus === "registered" ? "dropped" : "registered")}>{course.registrationStatus === "registered" ? "Drop" : "Register"}</button> : "-"}</td>
          </tr>)}</tbody>
        </table></div>
      ) : <p>No courses are currently available.</p>}
      <p className="portal-link-row"><Link to="/dashboard">Back to dashboard</Link></p>
    </div></div>
  );
}
