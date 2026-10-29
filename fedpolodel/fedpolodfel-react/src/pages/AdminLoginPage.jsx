import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiRequest } from "../lib/api";
import { PortalBrand } from "../components/PortalBrand";

export function AdminLoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await apiRequest("/api/admin/login", {
        method: "POST",
        body: { username, password },
      });
      navigate(result.next || "/admin/payments");
    } catch (err) {
      setError(err.message || "Admin login failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="portal-page">
      <div className="portal-card">
        <PortalBrand />
        <h1>Admin Login</h1>
        <p className="portal-sub">Access payment verification, overrides, and reconciliation tools.</p>
        {error ? <div className="portal-alert">{error}</div> : null}

        <form onSubmit={handleSubmit} className="portal-form">
          <label htmlFor="admin-username">Username</label>
          <input
            id="admin-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />

          <label htmlFor="admin-password">Password</label>
          <input
            id="admin-password"
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
          <Link to="/">Back to main site</Link>
        </p>
      </div>
    </div>
  );
}
