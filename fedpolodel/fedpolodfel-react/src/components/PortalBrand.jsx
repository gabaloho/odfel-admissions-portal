import React from "react";
import { Link } from "react-router-dom";
import { siteConfig } from "../lib/siteConfig";

export function PortalBrand() {
  return (
    <div className="portal-brand">
      {siteConfig.institutionLogo ? (
        <img src={siteConfig.institutionLogo} alt={`${siteConfig.institutionName} logo`} />
      ) : null}
      <Link to="/" aria-label={`${siteConfig.brandName} admissions portal home`}>
        {siteConfig.brandName}
      </Link>
      <span>{siteConfig.institutionName}</span>
    </div>
  );
}
