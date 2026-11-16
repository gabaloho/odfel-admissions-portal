import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import "bootstrap-icons/font/bootstrap-icons.css";
import "./styles.css";
import { HomePage } from "./pages/HomePage";
import { AdmissionRequirementPage } from "./pages/AdmissionRequirementPage";
import { CheckStatusPage } from "./pages/CheckStatusPage";
import { PrintDocumentPage } from "./pages/PrintDocumentPage";
import { ContinueApplicationPage } from "./pages/ContinueApplicationPage";
import { PortalLoginPage } from "./pages/PortalLoginPage";
import { PortalRegisterPage } from "./pages/PortalRegisterPage";
import { PortalPreApplicationPage } from "./pages/PortalPreApplicationPage";
import { PortalDashboardPage } from "./pages/PortalDashboardPage";
import { PortalInvoicePage } from "./pages/PortalInvoicePage";
import { AdminLoginPage } from "./pages/AdminLoginPage";
import { AdminPaymentsPage } from "./pages/AdminPaymentsPage";
import { AdminUsersPage } from "./pages/AdminUsersPage";
import { AdminChangePasswordPage } from "./pages/AdminChangePasswordPage";
import { AdminInstitutionPage } from "./pages/AdminInstitutionPage";
import { AdminSisPage } from "./pages/AdminSisPage";
import { AdminCoursesPage } from "./pages/AdminCoursesPage";
import { StudentCoursesPage } from "./pages/StudentCoursesPage";
import { AdminResultsPage } from "./pages/AdminResultsPage";
import { StudentResultsPage } from "./pages/StudentResultsPage";
import { AdminStudentFeesPage } from "./pages/AdminStudentFeesPage";
import { StudentFeesPage } from "./pages/StudentFeesPage";
import { AdminAttendancePage } from "./pages/AdminAttendancePage";
import { StudentAttendancePage } from "./pages/StudentAttendancePage";
import { AdminReportsPage } from "./pages/AdminReportsPage";
import { apiRequest } from "./lib/api";
import { applyInstitutionSettings } from "./lib/siteConfig";

function AppRoutes({ configured }) {
  const location = useLocation();
  if (!configured && !["/admin/login", "/admin/change-password", "/admin/institution"].includes(location.pathname)) {
    return <Navigate to="/admin/institution" replace />;
  }
  return (
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/admission-requirement" element={<AdmissionRequirementPage />} />
        <Route path="/start-application" element={<Navigate to="/register" replace />} />
        <Route path="/check-status" element={<CheckStatusPage />} />
        <Route path="/print-document" element={<PrintDocumentPage />} />
        <Route path="/login" element={<PortalLoginPage />} />
        <Route path="/register" element={<PortalRegisterPage />} />
        <Route path="/pre-application" element={<PortalPreApplicationPage />} />
        <Route path="/dashboard" element={<PortalDashboardPage />} />
        <Route path="/invoice/:invoiceNumber" element={<PortalInvoicePage />} />
        <Route path="/admin/login" element={<AdminLoginPage />} />
        <Route path="/admin/payments" element={<AdminPaymentsPage />} />
        <Route path="/admin/users" element={<AdminUsersPage />} />
        <Route path="/admin/change-password" element={<AdminChangePasswordPage />} />
        <Route path="/admin/institution" element={<AdminInstitutionPage />} />
        <Route path="/admin/sis" element={<AdminSisPage />} />
        <Route path="/admin/courses" element={<AdminCoursesPage />} />
        <Route path="/courses" element={<StudentCoursesPage />} />
        <Route path="/admin/results" element={<AdminResultsPage />} />
        <Route path="/results" element={<StudentResultsPage />} />
        <Route path="/admin/student-fees" element={<AdminStudentFeesPage />} />
        <Route path="/fees" element={<StudentFeesPage />} />
        <Route path="/admin/attendance" element={<AdminAttendancePage />} />
        <Route path="/attendance" element={<StudentAttendancePage />} />
        <Route path="/admin/reports" element={<AdminReportsPage />} />
        <Route path="/continue-application" element={<ContinueApplicationPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
  );
}

function AppRouter() {
  const [state, setState] = useState({ loading: true, configured: false, error: "" });
  useEffect(() => {
    let active = true;
    apiRequest("/api/institution").then((result) => {
      if (!active) return;
      applyInstitutionSettings(result.settings);
      setState({ loading: false, configured: result.configured, error: "" });
    }).catch((error) => {
      if (active) setState({ loading: false, configured: false, error: error.message });
    });
    return () => { active = false; };
  }, []);

  if (state.loading) return <div className="portal-page"><div className="portal-card">Loading institution settings...</div></div>;
  if (state.error) return <div className="portal-page"><div className="portal-card"><div className="portal-alert">{state.error}</div><button onClick={() => window.location.reload()}>Retry</button></div></div>;
  return (
    <BrowserRouter>
      <AppRoutes configured={state.configured} />
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>
);
