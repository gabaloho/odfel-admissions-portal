import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiRequest } from "../lib/api";
import { PortalBrand } from "../components/PortalBrand";
import { siteConfig } from "../lib/siteConfig";

export function PortalRegisterPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    surname: "",
    otherNames: "",
    email: "",
    phone: "",
    password: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await apiRequest("/api/auth/register", {
        method: "POST",
        body: form,
      });
      navigate(result.next || "/pre-application");
    } catch (err) {
      setError(err.message || "Registration failed.");
    } finally {
      setLoading(false);
    }
  }

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  return (
    <div className="portal-page">
      <div className="portal-card">
        <PortalBrand />
        <h1>Create Applicant Account</h1>
        <p className="portal-sub">Start your admission process with {siteConfig.institutionName} using {siteConfig.brandName}.</p>
        {error ? <div className="portal-alert">{error}</div> : null}

        <form onSubmit={handleSubmit} className="portal-form">
          <label htmlFor="surname">Surname</label>
          <input
            id="surname"
            value={form.surname}
            onChange={(e) => updateField("surname", e.target.value)}
            required
          />

          <label htmlFor="otherNames">Other Names</label>
          <input
            id="otherNames"
            value={form.otherNames}
            onChange={(e) => updateField("otherNames", e.target.value)}
            required
          />

          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={form.email}
            onChange={(e) => updateField("email", e.target.value)}
            required
          />

          <label htmlFor="phone">Phone</label>
          <input
            id="phone"
            value={form.phone}
            onChange={(e) => updateField("phone", e.target.value)}
            required
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={form.password}
            onChange={(e) => updateField("password", e.target.value)}
            required
          />

          <button type="submit" disabled={loading}>
            {loading ? "Creating account..." : "Create Account"}
          </button>
        </form>

        <p className="portal-link-row">
          Already registered? <Link to="/login">Login</Link>
        </p>
      </div>
    </div>
  );
}
