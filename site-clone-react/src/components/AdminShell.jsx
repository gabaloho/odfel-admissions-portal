import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiRequest } from "../lib/api";

export function AdminShell({ title, subtitle, children }) {
  const navigate = useNavigate();

  async function handleLogout() {
    try {
      await apiRequest("/api/admin/logout", { method: "POST" });
    } finally {
      navigate("/admin/login");
    }
  }

  return (
    <div className="portal-page">
      <div className="portal-card portal-wide">
        <div className="portal-row">
          <div>
            <h1>{title}</h1>
            {subtitle ? <p className="portal-sub">{subtitle}</p> : null}
          </div>
          <button type="button" className="portal-secondary-btn" onClick={handleLogout}>
            Logout
          </button>
        </div>

        <nav className="admin-nav">
          <Link to="/admin/payments">Payments</Link>
          <Link to="/admin/users">Admin Users</Link>
          <Link to="/admin/change-password">Password</Link>
          <Link to="/">Main Site</Link>
        </nav>

        {children}
      </div>
    </div>
  );
}
