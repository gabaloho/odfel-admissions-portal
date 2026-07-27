import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRequest } from "../lib/api";
import { AdminShell } from "../components/AdminShell";

export function AdminUsersPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const result = await apiRequest("/api/admin/users");
      setData(result);
    } catch (err) {
      if (err.status === 401) {
        navigate("/admin/login");
        return;
      }
      if (err.status === 403 && err.payload?.next) {
        navigate(err.payload.next);
        return;
      }
      setError(err.message || "Failed to load admin users.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitAction(action) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await action();
      setSuccess(result?.message || "Action completed successfully.");
      await loadData();
    } catch (err) {
      setError(err.message || "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <AdminShell title="Admin User Management" subtitle="Loading admin user records...">
        <p className="portal-sub">Loading...</p>
      </AdminShell>
    );
  }

  return (
    <AdminShell
      title="Admin User Management"
      subtitle={`Signed in as ${data?.currentAdmin?.username || ""} (${data?.currentAdmin?.role || ""})`}
    >

        {error ? <div className="portal-alert">{error}</div> : null}
        {success ? <div className="portal-success">{success}</div> : null}

        <section>
          <h2>Create Admin Account</h2>
          <form
            className="portal-inline-grid"
            onSubmit={(event) => {
              event.preventDefault();
              const formData = new FormData(event.currentTarget);
              submitAction(() =>
                apiRequest("/api/admin/users", {
                  method: "POST",
                  body: {
                    username: String(formData.get("username") || ""),
                    password: String(formData.get("password") || ""),
                    role: String(formData.get("role") || ""),
                  },
                })
              );
            }}
          >
            <label htmlFor="create-username">Username</label>
            <input id="create-username" name="username" required />
            <label htmlFor="create-password">Temporary Password</label>
            <input id="create-password" name="password" type="password" minLength={10} required />
            <label htmlFor="create-role">Role</label>
            <select id="create-role" name="role" required>
              {(data?.roles || []).map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <button type="submit" disabled={busy}>Create Admin</button>
          </form>
        </section>

        <section>
          <h2>Existing Admin Accounts</h2>
          <div className="portal-overflow">
            <table className="portal-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Role Change</th>
                  <th>Activate/Deactivate</th>
                  <th>Password Reset</th>
                </tr>
              </thead>
              <tbody>
                {data?.admins?.length ? (
                  data.admins.map((admin) => (
                    <tr key={admin.id}>
                      <td>{admin.username}</td>
                      <td>{admin.role}</td>
                      <td>{admin.isActive ? "Active" : "Inactive"}</td>
                      <td>{admin.createdAt}</td>
                      <td>
                        <form
                          className="portal-override-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const formData = new FormData(event.currentTarget);
                            submitAction(() =>
                              apiRequest(`/api/admin/users/${admin.id}/role`, {
                                method: "POST",
                                body: { role: String(formData.get("role") || "") },
                              })
                            );
                          }}
                        >
                          <select name="role" defaultValue={admin.role} required>
                            {(data?.roles || []).map((role) => (
                              <option key={role} value={role}>
                                {role}
                              </option>
                            ))}
                          </select>
                          <button type="submit" disabled={busy}>Update Role</button>
                        </form>
                      </td>
                      <td>
                        <form
                          className="portal-override-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            submitAction(() =>
                              apiRequest(`/api/admin/users/${admin.id}/toggle-active`, {
                                method: "POST",
                                body: { makeActive: admin.isActive ? "0" : "1" },
                              })
                            );
                          }}
                        >
                          <button type="submit" disabled={busy}>
                            {admin.isActive ? "Deactivate" : "Activate"}
                          </button>
                        </form>
                      </td>
                      <td>
                        <form
                          className="portal-override-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const formData = new FormData(event.currentTarget);
                            submitAction(() =>
                              apiRequest(`/api/admin/users/${admin.id}/password`, {
                                method: "POST",
                                body: { password: String(formData.get("password") || "") },
                              })
                            );
                          }}
                        >
                          <input name="password" type="password" minLength={10} placeholder="New password" required />
                          <button type="submit" disabled={busy}>Reset Password</button>
                        </form>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="7">No admin accounts found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
    </AdminShell>
  );
}
