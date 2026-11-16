import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PortalBrand } from "../components/PortalBrand";
import { apiRequest } from "../lib/api";

export function StudentResultsPage() {
  const navigate = useNavigate();
  const [results, setResults] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    apiRequest("/api/student/results").then((result) => setResults(result.results)).catch((err) => {
      if (err.status === 401) navigate("/login");
      else setError(err.message);
    });
  }, []);

  return <div className="portal-page"><div className="portal-card portal-wide">
    <PortalBrand />
    <h1>Published Results</h1>
    <p className="portal-sub">Only published results are shown. These are not an official transcript.</p>
    {error ? <div className="portal-alert" role="alert">{error}</div> : null}
    {!results ? <p>{error ? "Results could not be loaded." : "Loading results..."}</p> : results.length ? <div className="portal-overflow"><table className="portal-table">
      <thead><tr><th>Session / term</th><th>Course</th><th>Score</th><th>Grade</th><th>Grade points</th><th>Units</th></tr></thead>
      <tbody>{results.map((result) => <tr key={result.publication.id}><td>{result.sessionName} / {result.termName}</td><td>{result.code}: {result.title}</td><td>{result.publication.score}</td><td>{result.publication.grade}</td><td>{result.publication.gradePoints}</td><td>{result.publication.creditUnits}</td></tr>)}</tbody>
    </table></div> : <p>No published results yet.</p>}
    {results ? <p className="portal-link-row"><a href="/api/student/academic-record.pdf">Download unofficial academic record (PDF)</a></p> : null}
    <p className="portal-link-row"><Link to="/dashboard">Back to dashboard</Link></p>
  </div></div>;
}
