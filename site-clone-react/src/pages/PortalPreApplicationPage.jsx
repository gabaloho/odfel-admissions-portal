import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRequest } from "../lib/api";

const MODES = ["Full-Time", "Part-Time", "Distance Learning"];

export function PortalPreApplicationPage() {
  const navigate = useNavigate();
  const [programs, setPrograms] = useState([]);
  const [form, setForm] = useState({
    programId: "",
    modeOfStudy: "",
    previousInstitution: "",
    notes: "",
  });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;

    async function loadData() {
      try {
        const result = await apiRequest("/api/pre-application");
        if (!mounted) return;
        setPrograms(result.programs || []);
        if (result.previous) {
          setForm({
            programId: result.previous.programId || "",
            modeOfStudy: result.previous.modeOfStudy || "",
            previousInstitution: result.previous.previousInstitution || "",
            notes: result.previous.notes || "",
          });
        }
      } catch (err) {
        if (err.status === 302 || err.status === 401) {
          navigate("/login");
          return;
        }
        if (mounted) {
          setError(err.message || "Failed to load pre-application details.");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    loadData();
    return () => {
      mounted = false;
    };
  }, [navigate]);

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const saveResult = await apiRequest("/api/pre-application", {
        method: "POST",
        body: form,
      });

      if (!saveResult.ok) {
        throw new Error(saveResult.message || "Unable to save pre-application.");
      }

      const invoiceResult = await apiRequest("/api/invoice/create", {
        method: "POST",
      });
      navigate(invoiceResult.next || "/dashboard");
    } catch (err) {
      setError(err.message || "Failed to save pre-application.");
    } finally {
      setSubmitting(false);
    }
  }

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  if (loading) {
    return (
      <div className="portal-page">
        <div className="portal-card">
          <h1>Pre-Application</h1>
          <p className="portal-sub">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="portal-page">
      <div className="portal-card">
        <h1>Pre-Application Form</h1>
        <p className="portal-sub">Complete this step to generate your invoice.</p>
        {error ? <div className="portal-alert">{error}</div> : null}

        <form onSubmit={handleSubmit} className="portal-form">
          <label htmlFor="programId">Program</label>
          <select
            id="programId"
            value={form.programId}
            onChange={(e) => updateField("programId", e.target.value)}
            required
          >
            <option value="">Select Program</option>
            {programs.map((program) => (
              <option key={program.id} value={program.id}>
                {program.name}
              </option>
            ))}
          </select>

          <label htmlFor="modeOfStudy">Mode of Study</label>
          <select
            id="modeOfStudy"
            value={form.modeOfStudy}
            onChange={(e) => updateField("modeOfStudy", e.target.value)}
            required
          >
            <option value="">Select Mode</option>
            {MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>

          <label htmlFor="previousInstitution">Previous Institution</label>
          <input
            id="previousInstitution"
            value={form.previousInstitution}
            onChange={(e) => updateField("previousInstitution", e.target.value)}
            required
          />

          <label htmlFor="notes">Additional Notes</label>
          <textarea
            id="notes"
            rows={4}
            value={form.notes}
            onChange={(e) => updateField("notes", e.target.value)}
          />

          <button type="submit" disabled={submitting}>
            {submitting ? "Saving..." : "Save and Generate Invoice"}
          </button>
        </form>
      </div>
    </div>
  );
}
