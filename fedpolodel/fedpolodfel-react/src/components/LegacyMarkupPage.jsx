import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { siteConfig } from "../lib/siteConfig";
import { signInAndGetDestination } from "../lib/portalSignIn";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function renderInstitutionMarkup(markup) {
  const escapedName = escapeHtml(siteConfig.institutionName);
  const escapedEmail = escapeHtml(siteConfig.institutionEmail);
  const escapedPhone = escapeHtml(siteConfig.institutionPhone);
  const escapedAddress = escapeHtml(siteConfig.institutionAddress);
  const escapedWebsite = escapeHtml(siteConfig.institutionWebsite || "/");
  const escapedLogo = escapeHtml(siteConfig.institutionLogo);
  const phoneLink = escapeHtml(siteConfig.institutionPhone.replace(/[^\d+]/g, ""));
  const contactItems = [
    siteConfig.institutionAddress ? `<span>${escapedAddress}</span>` : "",
    siteConfig.institutionEmail
      ? `<a href="mailto:${escapedEmail}">${escapedEmail}</a>`
      : "",
    siteConfig.institutionPhone
      ? `<a href="tel:${escapeHtml(siteConfig.institutionPhone.replace(/[^\d+]/g, ""))}">${escapedPhone}</a>`
      : "",
  ].filter(Boolean);
  const contactBar = contactItems.length
    ? `<div class="kingster-top-bar-left kingster-item-pdlr">${contactItems.join(" &nbsp; ")}</div>`
    : '<div class="kingster-top-bar-left kingster-item-pdlr"></div>';
  const contactPrompt = contactItems.length
    ? `<p>For more information, contact your institution: ${contactItems.join(" &nbsp; ")}</p>`
    : "<p>For more information, contact your institution directly.</p>";

  const tokens = {
    __INSTITUTION_NAME_UPPER__: escapeHtml(siteConfig.institutionName.toLocaleUpperCase()),
    __INSTITUTION_NAME__: escapedName,
    __INSTITUTION_EMAIL__: escapedEmail,
    __INSTITUTION_PHONE__: escapedPhone,
    __INSTITUTION_PHONE_LINK__: phoneLink,
    __INSTITUTION_ADDRESS__: escapedAddress,
    __INSTITUTION_WEBSITE__: escapedWebsite,
    __INSTITUTION_LOGO__: escapedLogo,
    __CURRENT_YEAR__: String(new Date().getFullYear()),
  };
  let rendered = markup
    .replace(/__(?:INSTITUTION_(?:NAME_UPPER|NAME|EMAIL|PHONE_LINK|PHONE|ADDRESS|WEBSITE|LOGO)|CURRENT_YEAR)__/g, (token) => tokens[token])
    .replace(/<img class="fpw-brand-image"[^>]*>/gi, () => escapedLogo
      ? `<img class="fpw-brand-image" src="${escapedLogo}" alt="${escapedName} logo" style="width:56px;height:auto;display:block;">`
      : "")
    .replace(/<span class="fpw-brand-text"([^>]*)>[\s\S]*?<\/span>/gi, (_, attributes) => `<span class="fpw-brand-text"${attributes}>${siteConfig.brandName} | ${escapedName}</span>`)
    .replace(/<div class="gdlr-core-social-network-item[\s\S]*?<\/div>/gi, "")
    .replace(/<div class="kingster-top-bar-left kingster-item-pdlr">[\s\S]*?<\/div>/gi, () => contactBar)
    .replace(/For more information, call[\s\S]*?<\/p>/i, () => contactPrompt);

  rendered = rendered
    .replace(/<a\b[^>]*href="mailto:"[^>]*>[\s\S]*?<\/a>/gi, "")
    .replace(/<a\b[^>]*href="tel:"[^>]*>[\s\S]*?<\/a>/gi, "");

  return rendered;
}

function showFormMessage(form, message) {
  let box = form.querySelector(".fpw-form-message");
  if (!box) {
    box = document.createElement("div");
    box.className = "fpw-form-message";
    box.setAttribute("role", "alert");
    form.insertBefore(box, form.firstChild);
  }
  box.textContent = message;
  box.hidden = !message;
}

/**
 * signInIntent: when set ("status" | "continue" | "print"), the page's sign-in
 * form (email + password) logs the applicant in through the portal API and
 * continues to the matching portal page instead of posting to the server.
 */
export function LegacyMarkupPage({ title, bodyClassName, html, signInIntent }) {
  const renderedHtml = renderInstitutionMarkup(html);
  const navigate = useNavigate();

  async function handleSubmit(event) {
    if (!signInIntent) return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();

    const email = String(form.elements.email?.value || "").trim();
    const password = String(form.elements.password?.value || "");
    const button = form.querySelector("button[type=submit]");
    showFormMessage(form, "");
    if (button) button.disabled = true;

    try {
      navigate(await signInAndGetDestination({ email, password }, signInIntent));
    } catch (err) {
      showFormMessage(
        form,
        err.status === 401
          ? "Invalid email or password. Use the email address and password you registered with."
          : err.message || "Sign-in failed. Please try again."
      );
      if (button) button.disabled = false;
    }
  }

  useEffect(() => {
    const footer = document.querySelector("footer");
    const topBarLeft = document.querySelector(".kingster-top-bar-left");
    const topBarRight = document.querySelector(".kingster-top-bar-right");
    const topBarInner = document.querySelector(".kingster-top-bar-container-inner");

    if (!footer || !topBarLeft) {
      return undefined;
    }

    topBarLeft.classList.add("fpw-top-bar-contact-hidden");

    if (topBarInner && topBarRight) {
      topBarInner.classList.add("fpw-top-bar-links-only");
      topBarRight.classList.add("fpw-top-bar-links-wrap");
    }

    const topBarMenu = document.querySelector("#kingster-top-bar-menu");
    let odfelItem = null;
    if (topBarMenu) {
      const existingItem = topBarMenu.querySelector(".fpw-odfel-link-item");
      if (!existingItem) {
        odfelItem = document.createElement("li");
        odfelItem.className = "menu-item kingster-normal-menu fpw-odfel-link-item";
        odfelItem.innerHTML =
          '<a href="/admission-requirement">Open Distance &amp; Flexible Learning (ODFeL)</a>';
        topBarMenu.insertBefore(odfelItem, topBarMenu.firstChild);
      }
    }

    const existingPanel = footer.querySelector(".fpw-footer-panel");
    if (!existingPanel) {
      const footerPanel = document.createElement("div");
      footerPanel.className = "fpw-footer-panel";
      const websiteLink = siteConfig.institutionWebsite
        ? `<a class="fpw-footer-cta" href="${escapeHtml(siteConfig.institutionWebsite)}" target="_blank" rel="noopener noreferrer">Visit institution website</a>`
        : "";
      const contactDetails = [
        siteConfig.institutionAddress
          ? `<p><span aria-hidden="true">&#128205;</span> ${escapeHtml(siteConfig.institutionAddress)}</p>`
          : "",
        siteConfig.institutionEmail
          ? `<p><span aria-hidden="true">&#9993;</span> <a href="mailto:${escapeHtml(siteConfig.institutionEmail)}">${escapeHtml(siteConfig.institutionEmail)}</a></p>`
          : "",
        siteConfig.institutionPhone
          ? `<p><span aria-hidden="true">&#9742;</span> <a href="tel:${escapeHtml(siteConfig.institutionPhone.replace(/[^\d+]/g, ""))}">${escapeHtml(siteConfig.institutionPhone)}</a></p>`
          : "",
      ].filter(Boolean);
      footerPanel.innerHTML = `
        <div class="fpw-footer-grid kingster-container">
          <section class="fpw-footer-section fpw-footer-brand">
            <p class="fpw-footer-kicker">${siteConfig.brandName} Admissions Portal</p>
            <h3>${escapeHtml(siteConfig.institutionName)}</h3>
            <p>
              ${siteConfig.brandName} helps institutions manage flexible learning admissions and applicant services.
            </p>
            ${websiteLink}
          </section>
          <section class="fpw-footer-section">
            <h3>Quick Links</h3>
            <ul>
              <li><a href="/admission-requirement">Admission Requirements</a></li>
              <li><a href="/start-application">Apply for Admission</a></li>
              <li><a href="/check-status">Check Status</a></li>
              <li><a href="/print-document">Print Documents</a></li>
            </ul>
          </section>
          <section class="fpw-footer-section">
            <h3>Resources</h3>
            <ul>
              <li><a href="/register">Applicant registration</a></li>
              <li><a href="/login">Applicant login</a></li>
              <li><a href="/admin/login">Administrator login</a></li>
            </ul>
          </section>
          <section class="fpw-footer-section fpw-footer-contact">
            <h3>Contact Us</h3>
            ${contactDetails.length ? contactDetails.join("\n") : "<p>Contact your institution for assistance.</p>"}
          </section>
        </div>
      `;

      footer.insertBefore(footerPanel, footer.firstChild);
    }

    return () => {
      topBarLeft.classList.remove("fpw-top-bar-contact-hidden");

      if (topBarInner && topBarRight) {
        topBarInner.classList.remove("fpw-top-bar-links-only");
        topBarRight.classList.remove("fpw-top-bar-links-wrap");
      }

      const insertedOdfelItem = document.querySelector("#kingster-top-bar-menu .fpw-odfel-link-item");
      if (insertedOdfelItem) {
        insertedOdfelItem.remove();
      }

      const panel = footer.querySelector(".fpw-footer-panel");
      if (panel) {
        panel.remove();
      }
    };
  }, [renderedHtml]);

  useEffect(() => {
    const normalizePath = (value) => {
      if (!value) return "/";
      const trimmed = value.trim();
      if (trimmed.length > 1 && trimmed.endsWith("/")) {
        return trimmed.slice(0, -1);
      }
      return trimmed;
    };

    const currentPath = normalizePath(window.location.pathname);
    const menuLinks = document.querySelectorAll(
      ".kingster-navigation .sf-menu > li > a, .kingster-mm-menu-wrap .sf-menu > li > a"
    );

    menuLinks.forEach((link) => {
      const hrefValue = link.getAttribute("href");
      if (!hrefValue || hrefValue.startsWith("#")) return;

      const hrefPath = normalizePath(new URL(hrefValue, window.location.origin).pathname);
      if (hrefPath === currentPath) {
        link.classList.add("fpw-active-link");
      } else {
        link.classList.remove("fpw-active-link");
      }
    });
  }, [renderedHtml]);

  useEffect(() => {
    const previousTitle = document.title;
    const previousBodyClass = document.body.className;

    document.title = title;
    document.body.className = bodyClassName;

    return () => {
      document.title = previousTitle;
      document.body.className = previousBodyClass;
    };
  }, [title, bodyClassName]);

  return <div onSubmit={handleSubmit} dangerouslySetInnerHTML={{ __html: renderedHtml }} />;
}
