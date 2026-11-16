import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AdminShell } from "../components/AdminShell";
import { apiRequest } from "../lib/api";

export function AdminInstitutionPage() {
  const [form, setForm] = useState(null);
  const [choices, setChoices] = useState([]);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    apiRequest("/api/admin/institution").then((result) => {
      if (!active) return;
      const existing = result.existingPrograms.map((p) => p.name).filter((name) => name !== "Sample Program (configure before launch)");
      const settings = result.settings || {
        ...result.defaults,
        institutionName: result.defaults.institutionName === "Your Institution" ? "" : result.defaults.institutionName,
        programmeNames: existing,
      };
      setChoices([...new Set([...settings.programmeNames, ...existing, ...result.presets])].sort((a, b) => a.localeCompare(b)));
      setForm({ ...settings, modesText: settings.modesOfStudy.join("\n") });
    }).catch((err) => {
      if (!active) return;
      if (err.payload?.next === "/admin/change-password") window.location.assign("/admin/change-password");
      else if (err.status === 401) setAuthRequired(true);
      else setError(err.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  function update(field, value) {
    setForm((previous) => ({ ...previous, [field]: value }));
  }

  function addProgramme() {
    const name = custom.trim();
    if (!name) return;
    const existing = choices.find((choice) => choice.toLowerCase() === name.toLowerCase());
    const selected = existing || name;
    if (!existing) setChoices((previous) => [...previous, name].sort((a, b) => a.localeCompare(b)));
    if (!form.programmeNames.includes(selected)) update("programmeNames", [...form.programmeNames, selected]);
    setCustom("");
  }

  async function save(event) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await apiRequest("/api/admin/institution", {
        method: "POST",
        body: {
          ...form,
          feeAmount: Number(form.feeAmount),
          modesOfStudy: form.modesText.split("\n").map((mode) => mode.trim()).filter(Boolean),
        },
      });
      window.location.assign("/");
    } catch (err) {
      setError(err.message || "Unable to save settings.");
      setSaving(false);
    }
  }

  if (loading) return <div className="portal-page"><div className="portal-card">Loading institution setup...</div></div>;
  if (authRequired) return (
    <div className="portal-page"><div className="portal-card">
      <h1>Set up your institution</h1>
      <p>Sign in as the super administrator to configure the portal. Use the administrator credentials set by your deployment operator.</p>
      <Link className="portal-link-btn" to="/admin/login">Administrator sign in</Link>
    </div></div>
  );
  if (!form) return <div className="portal-page"><div className="portal-card"><div className="portal-alert">{error}</div><Link to="/admin/login">Administrator sign in</Link></div></div>;

  return (
    <AdminShell title="Institution Setup" subtitle="Configure your portal without editing code. Existing applications and invoices are preserved.">
      {error ? <div className="portal-alert" role="alert">{error}</div> : null}
      <form className="portal-form" onSubmit={save}>
        <h2>Institution</h2>
        <label htmlFor="institutionName">Institution name</label>
        <input id="institutionName" value={form.institutionName} onChange={(e) => update("institutionName", e.target.value)} maxLength={190} required />
        <label htmlFor="institutionWebsite">Website URL (optional)</label>
        <input id="institutionWebsite" type="url" value={form.institutionWebsite || ""} onChange={(e) => update("institutionWebsite", e.target.value)} />
        <label htmlFor="institutionLogo">Logo URL or root-relative path (optional)</label>
        <input id="institutionLogo" value={form.institutionLogo || ""} onChange={(e) => update("institutionLogo", e.target.value)} />
        <label htmlFor="institutionEmail">Contact email (optional)</label>
        <input id="institutionEmail" type="email" value={form.institutionEmail || ""} onChange={(e) => update("institutionEmail", e.target.value)} />
        <label htmlFor="institutionPhone">Contact phone (optional)</label>
        <input id="institutionPhone" value={form.institutionPhone || ""} onChange={(e) => update("institutionPhone", e.target.value)} maxLength={30} />
        <label htmlFor="institutionAddress">Address (optional)</label>
        <textarea id="institutionAddress" value={form.institutionAddress || ""} onChange={(e) => update("institutionAddress", e.target.value)} maxLength={500} />
        <label htmlFor="language">Operating language</label>
        <select id="language" value={form.language} onChange={(e) => update("language", e.target.value)}>
          <option value="en">English</option>
        </select>
        <p>Additional languages will be available once their translations are complete.</p>

        <h2>Application fee</h2>
        <label htmlFor="feeAmount">Amount</label>
        <input id="feeAmount" type="number" min="0" max="100000000" step="0.01" value={form.feeAmount} onChange={(e) => update("feeAmount", e.target.value)} required />
        <label htmlFor="currency">Currency code (e.g. NGN, USD, EUR)</label>
        <input id="currency" value={form.currency} onChange={(e) => update("currency", e.target.value.toUpperCase())} pattern="[A-Z]{3}" required />
        <label htmlFor="feeDescription">Fee description</label>
        <input id="feeDescription" value={form.feeDescription} onChange={(e) => update("feeDescription", e.target.value)} maxLength={190} required />
        <p>Fee changes apply only to new invoices.</p>

        <h2>Study modes</h2>
        <label htmlFor="modes">Enter one mode per line</label>
        <textarea id="modes" rows={4} value={form.modesText} onChange={(e) => update("modesText", e.target.value)} required />

        <h2>Admissions programmes</h2>
        <p>Select the programmes you offer, or add your own. Removing a selection does not delete existing applications.</p>
        <fieldset className="programme-choices">
          <legend>Available programmes</legend>
          {choices.map((name) => (
            <label key={name}>
              <input type="checkbox" checked={form.programmeNames.includes(name)} onChange={(e) => update("programmeNames", e.target.checked ? [...form.programmeNames, name] : form.programmeNames.filter((value) => value !== name))} /> {name}
            </label>
          ))}
        </fieldset>
        <label htmlFor="customProgramme">Add a custom programme</label>
        <input id="customProgramme" value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={190} />
        <button type="button" className="portal-secondary-btn" onClick={addProgramme}>Add programme</button>
        <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save institution settings"}</button>
      </form>
    </AdminShell>
  );
}
