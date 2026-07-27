import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRequest } from "../lib/api";
import { AdminShell } from "../components/AdminShell";

export function AdminChangePasswordPage() {
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);

    try {
      const result = await apiRequest("/api/admin/change-password", {
        method: "POST",
        body: { currentPassword, newPassword, confirmPassword },
      });
      setSuccess(result.message || "Password changed successfully.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      if (err.status === 401) {
        navigate("/admin/login");
        return;
      }
      setError(err.message || "Password update failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AdminShell
      title="Admin Password Update"
      subtitle="Use a strong password with uppercase, lowercase, number, and special character."
    >
        {error ? <div className="portal-alert">{error}</div> : null}
        {success ? <div className="portal-success">{success}</div> : null}

        <form onSubmit={handleSubmit} className="portal-form">
          <label htmlFor="currentPassword">Current Password</label>
          <input
            id="currentPassword"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />

          <label htmlFor="newPassword">New Password</label>
          <input
            id="newPassword"
            type="password"
            minLength={10}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />

          <label htmlFor="confirmPassword">Confirm New Password</label>
          <input
            id="confirmPassword"
            type="password"
            minLength={10}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />

          <button type="submit" disabled={loading}>
            {loading ? "Updating..." : "Update Password"}
          </button>
        </form>
    </AdminShell>
  );
}
