import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiRequest } from "../lib/api";
import { PortalBrand } from "../components/PortalBrand";

export function PortalLoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await apiRequest("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });
      navigate(result.next || "/dashboard");
    } catch (err) {
      setError(err.message || "Login failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="portal-page">
      <div className="portal-card">
        <PortalBrand />
        <h1>Applicant Login</h1>
        <p className="portal-sub">Access your admission dashboard and payment invoice.</p>
        {error ? <div className="portal-alert">{error}</div> : null}

        <form onSubmit={handleSubmit} className="portal-form">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          <button type="submit" disabled={loading}>
            {loading ? "Signing in..." : "Login"}
          </button>
        </form>

        <p className="portal-link-row">
          New applicant? <Link to="/register">Create Account</Link>
        </p>
        <p className="portal-link-row">
          <Link to="/">Back to main site</Link>
        </p>
      </div>
    </div>
  );
}
