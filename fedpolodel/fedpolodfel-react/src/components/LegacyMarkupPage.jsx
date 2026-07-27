import React, { useEffect } from "react";

export function LegacyMarkupPage({ title, bodyClassName, html }) {
  const renderedHtml = html.replaceAll("__CURRENT_YEAR__", String(new Date().getFullYear()));

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
      footerPanel.innerHTML = `
        <div class="fpw-footer-grid kingster-container">
          <section class="fpw-footer-section fpw-footer-brand">
            <p class="fpw-footer-kicker">Official Admissions Portal</p>
            <h3>Federal Polytechnic Wannune</h3>
            <p>
              We are committed to academic excellence, practical skill development,
              and accessible digital services for applicants and students.
            </p>
            <a class="fpw-footer-cta" href="https://www.fedpolywannune.edu.ng/" target="_blank" rel="noopener noreferrer">Visit Main Website</a>
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
              <li><a href="https://www.fedpolywannune.edu.ng/admission_requirement/" target="_blank" rel="noopener noreferrer">Programmes</a></li>
              <li><a href="https://www.fedpolywannune.edu.ng/key_institutional_data/" target="_blank" rel="noopener noreferrer">Key Institutional Data</a></li>
              <li><a href="https://www.fedpolywannune.edu.ng/login/" target="_blank" rel="noopener noreferrer">Portal Login</a></li>
              <li><a href="https://em1.host-ww.net:2096/" target="_blank" rel="noopener noreferrer">Staff Mail</a></li>
            </ul>
          </section>
          <section class="fpw-footer-section fpw-footer-contact">
            <h3>Contact Us</h3>
            <p><span aria-hidden="true">&#128205;</span> KM 55, Makurdi - Gboko Road, Wannune. Benue State. Nigeria. PMB 102355</p>
            <p><span aria-hidden="true">&#9993;</span> <a href="mailto:info@fedpolywannune.edu.ng">info@fedpolywannune.edu.ng</a></p>
            <p><span aria-hidden="true">&#9742;</span> (+234)8020953504, (+234)8024093579</p>
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

  return <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />;
}
