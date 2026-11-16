import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AdminShell } from "../components/AdminShell";
import { apiRequest } from "../lib/api";

function parseBands(text) {
  const lines = String(text).split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length !== 3 || !parts[0] || !/^\d+(?:\.\d{1,2})?$/.test(parts[1]) || !/^\d+(?:\.\d{1,2})?$/.test(parts[2])) {
      throw new Error("Enter each grade band as label, minimum score, grade points.");
    }
    return { label: parts[0], minimumScore: Number(parts[1]), gradePoints: Number(parts[2]) };
  });
}

export function AdminResultsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [history, setHistory] = useState({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() { setData(await apiRequest("/api/admin/sis/results")); }
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
      setHistory({});
      await load();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }
  function submitScale(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      send("/api/admin/sis/grading-scales", { programId: values.get("programId"), name: values.get("name"), bands: parseBands(values.get("bands")) }, form);
    } catch (err) {
      setError(err.message);
    }
  }
  function submitDraft(event, row) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    send("/api/admin/sis/results/draft", { userId: row.userId, offeringId: row.offeringId, score: Number(values.get("score")), reason: values.get("reason") }, form);
  }
  async function showHistory(row) {
    setError("");
    try {
      const result = await apiRequest(`/api/admin/sis/results/${row.userId}/${row.offeringId}/history`);
      setHistory((previous) => ({ ...previous, [`${row.userId}:${row.offeringId}`]: result.publications }));
    } catch (err) {
      showError(err);
    }
  }

  return (
    <AdminShell title="Results and Grading" subtitle="Configure approved programme grading scales, review drafts, and publish results.">
      {error ? <div className="portal-alert" role="alert">{error}</div> : null}
      {message ? <div className="portal-success" role="status">{message}</div> : null}
      {!data ? <p>{error ? "Records could not be loaded." : "Loading results..."}</p> : <>
        <section>
          <h2>Programme grading scales</h2>
          <p>Enter only your institution-approved scale. Each line is label, minimum score, grade points. The lowest minimum must be 0; each band applies up to the next minimum. Saving a new scale does not change published results.</p>
          <form className="portal-form" onSubmit={submitScale}>
            <label htmlFor="scale-program">Programme</label>
            <select id="scale-program" name="programId" defaultValue="" required><option value="">Select programme</option>{data.programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}</select>
            <label htmlFor="scale-name">Scale name</label>
            <input id="scale-name" name="name" maxLength={100} required />
            <label htmlFor="scale-bands">Grade bands (one per line)</label>
            <textarea id="scale-bands" name="bands" rows={5} placeholder="Label, minimum score, grade points" required />
            <button disabled={busy}>Save grading scale</button>
          </form>
          {data.scales.map((scale) => <div key={scale.id}>
            <h3>{data.programs.find((program) => program.id === scale.programId)?.name}: {scale.name}</h3>
            <ul>{scale.bands.map((band) => <li key={band.minimumScore}>{band.label}: {band.minimumScore} and above, {band.gradePoints} points</li>)}</ul>
          </div>)}
        </section>
        <section>
          <h2>Registered students and results</h2>
          <p>Close term registration before entering results. Save a draft with a reason, review its grade, then publish. A correction is saved as another draft; the previous published result remains visible until the correction is published.</p>
          {data.roster.length ? data.roster.map((row) => {
            const key = `${row.userId}:${row.offeringId}`;
            return <article key={key}>
              <h3>{row.matriculationNumber} - {row.surname} {row.otherNames}</h3>
              <p>{row.sessionName} / {row.termName}: {row.code} - {row.title} ({row.creditUnits} units) {row.registrationOpen ? "(registration open)" : "(registration closed)"}</p>
              <p>Published: {row.published ? `${row.published.score} - ${row.published.grade} (${row.published.gradePoints} points), version ${row.published.version}` : "None"}</p>
              {row.draftScore != null ? <p>Draft: {row.draftScore} - {row.draftPreview ? `${row.draftPreview.label} (${row.draftPreview.gradePoints} points)` : "No active grading scale"}; reason: {row.draftReason}</p> : null}
              <form className="portal-inline-grid" onSubmit={(event) => submitDraft(event, row)}>
                <label htmlFor={`score-${key}`}>Score (0-100)</label>
                <input id={`score-${key}`} name="score" type="number" min="0" max="100" step="0.01" required />
                <label htmlFor={`reason-${key}`}>Draft or correction reason</label>
                <input id={`reason-${key}`} name="reason" maxLength={1000} required />
                <button disabled={busy || row.registrationOpen}>Save draft</button>
              </form>
              {row.draftId && row.activeScaleId ? <button type="button" disabled={busy || row.registrationOpen} onClick={() => send("/api/admin/sis/results/publish", { userId: row.userId, offeringId: row.offeringId, draftId: row.draftId, scaleId: row.activeScaleId })}>Publish reviewed draft</button> : null}{" "}
              {row.published ? <button type="button" disabled={busy} onClick={() => showHistory(row)}>View publication history</button> : null}
              {history[key] ? <ul>{history[key].map((item) => <li key={item.id}>Version {item.version}: {item.score}, {item.grade}, {item.gradePoints} points; scale {item.scale.name} ({item.scale.bands.map((band) => `${band.label}: ${band.minimumScore}+ / ${band.gradePoints}`).join("; ")}); reason: {item.reason}; {item.publishedAt}</li>)}</ul> : null}
            </article>;
          }) : <p>No registered students yet.</p>}
        </section>
      </>}
    </AdminShell>
  );
}
