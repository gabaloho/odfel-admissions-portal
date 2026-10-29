import React from "react";
import { Link } from "react-router-dom";
import { siteConfig } from "../lib/siteConfig";
import { PortalBrand } from "../components/PortalBrand";

export function AdmissionRequirementPage() {
  return (
    <div className="portal-page">
      <div className="portal-card portal-wide">
        <PortalBrand />
        <p className="portal-sub">Admission information for {siteConfig.institutionName}.</p>
        <h1>Admission information</h1>
        <p>
          Admission requirements and available programmes vary by institution.
          Applicants should confirm the current criteria with {siteConfig.institutionName}
          before applying.
        </p>
        <p>
          This {siteConfig.brandName} starter does not include institution-specific admission criteria.
          Configure your approved programmes and publish your requirements before
          accepting applications.
        </p>
        <p className="portal-link-row">
          Ready to continue? <Link to="/register">Create an applicant account</Link>
        </p>
        {siteConfig.institutionWebsite ? (
          <p className="portal-link-row">
            <a href={siteConfig.institutionWebsite} target="_blank" rel="noreferrer">
              Visit {siteConfig.institutionName}
            </a>
          </p>
        ) : null}
        <p className="portal-link-row">
          <Link to="/">Back to {siteConfig.brandName}</Link>
        </p>
      </div>
    </div>
  );
}
