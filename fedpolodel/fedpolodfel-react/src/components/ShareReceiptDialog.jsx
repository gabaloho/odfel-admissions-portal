import React, { useEffect, useRef, useState } from "react";

// Copies text even where navigator.clipboard is unavailable (e.g. a phone
// opening the dev server over plain http://<computer-ip>:5173).
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission denied or unavailable: fall through to the legacy method.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("copy failed");
}

/**
 * In-app share window, used when the browser has no native share sheet
 * (most desktop browsers, and phones on a non-HTTPS address).
 */
export function ShareReceiptDialog({ title, text, pdfUrl, pdfFileName, onClose }) {
  const [copied, setCopied] = useState("");
  const firstButtonRef = useRef(null);

  useEffect(() => {
    firstButtonRef.current?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const encodedText = encodeURIComponent(text);
  const options = [
    {
      key: "whatsapp",
      label: "WhatsApp",
      icon: "bi-whatsapp",
      href: `https://wa.me/?text=${encodedText}`,
    },
    {
      key: "email",
      label: "Email",
      icon: "bi-envelope",
      href: `mailto:?subject=${encodeURIComponent(title)}&body=${encodedText}`,
    },
    {
      key: "sms",
      label: "Text message",
      icon: "bi-chat-dots",
      href: `sms:?&body=${encodedText}`,
    },
  ];

  async function handleCopy() {
    try {
      await copyText(text);
      setCopied("Receipt details copied.");
    } catch {
      setCopied("Could not copy automatically. Select the text above and copy it.");
    }
  }

  return (
    <div className="share-backdrop" onClick={onClose}>
      <div
        className="share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="share-dialog-head">
          <h2 id="share-dialog-title">Share receipt</h2>
          <button type="button" className="share-close" aria-label="Close" onClick={onClose}>
            <i className="bi bi-x-lg" aria-hidden="true" />
          </button>
        </div>

        <p className="share-preview">{text}</p>

        <div className="share-options">
          {options.map((option, index) => (
            <a
              key={option.key}
              ref={index === 0 ? firstButtonRef : undefined}
              className={`share-option share-${option.key}`}
              href={option.href}
              target={option.key === "whatsapp" ? "_blank" : undefined}
              rel="noopener noreferrer"
            >
              <i className={`bi ${option.icon}`} aria-hidden="true" />
              <span>{option.label}</span>
            </a>
          ))}
          <button type="button" className="share-option share-copy" onClick={handleCopy}>
            <i className="bi bi-clipboard" aria-hidden="true" />
            <span>Copy details</span>
          </button>
          <a className="share-option share-download" href={pdfUrl} download={pdfFileName}>
            <i className="bi bi-file-earmark-pdf" aria-hidden="true" />
            <span>Download PDF</span>
          </a>
        </div>

        {copied ? (
          <p className="share-feedback" role="status">
            {copied}
          </p>
        ) : null}
        <p className="share-hint">
          WhatsApp, email and text message share the receipt details. To send the PDF itself, download it and attach it.
          On a phone, opening the portal over HTTPS shows your phone&apos;s own share menu with the PDF attached.
        </p>
      </div>
    </div>
  );
}
