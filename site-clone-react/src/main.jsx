import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
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

function AppRouter() {
  return (
    <BrowserRouter>
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
        <Route path="/continue-application" element={<ContinueApplicationPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>
);
