const crypto = require("crypto");

const PROGRAMME_PRESETS = [
  "Accounting", "Agricultural Technology", "Architectural Technology",
  "Business Administration and Management", "Civil Engineering Technology",
  "Computer Science", "Electrical and Electronic Engineering Technology",
  "Hospitality Management", "Mechanical Engineering Technology",
  "Public Administration", "Science Laboratory Technology", "Statistics",
];

function programmeId(name) {
  return `programme-${crypto.createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 24)}`;
}

function validateInstitutionSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Invalid settings." };
  const string = (value) => typeof value === "string" ? value.trim() : "";
  const name = string(input.institutionName);
  const website = string(input.institutionWebsite);
  const logo = string(input.institutionLogo);
  const email = string(input.institutionEmail);
  const phone = string(input.institutionPhone);
  const address = string(input.institutionAddress);
  const currency = string(input.currency).toUpperCase();
  const feeDescription = string(input.feeDescription);
  const feeAmount = input.feeAmount;
  const modes = Array.isArray(input.modesOfStudy) ? input.modesOfStudy.map(string) : [];
  const programmes = Array.isArray(input.programmeNames) ? input.programmeNames.map(string) : [];
  if (!name || name.length > 190) return { error: "Enter an institution name of up to 190 characters." };
  if (email && (email.length > 190 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { error: "Enter a valid contact email." };
  if (phone.length > 30 || address.length > 500) return { error: "Contact details are too long." };
  for (const [label, value] of [["Website", website], ["Logo", logo]]) {
    if (!value) continue;
    if (value.length > 1000) return { error: `${label} URL is too long.` };
    if (label === "Logo" && value.startsWith("/") && !value.startsWith("//") && !/[\\\x00-\x1f\x7f]/.test(value)) continue;
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid URL");
    } catch {
      return { error: `${label} must be an HTTP or HTTPS URL without credentials${label === "Logo" ? ", or a root-relative path" : ""}.` };
    }
  }
  if (input.language !== "en") return { error: "Only English is available in this setup phase." };
  if (!/^[A-Z]{3}$/.test(currency)) return { error: "Enter a three-letter currency code." };
  if (typeof feeAmount !== "number" || !Number.isFinite(feeAmount) || feeAmount < 0 || feeAmount > 100000000 || Math.abs(feeAmount * 100 - Math.round(feeAmount * 100)) > 1e-7) return { error: "Enter a valid fee with at most two decimal places." };
  if (!feeDescription || feeDescription.length > 190) return { error: "Enter a fee description of up to 190 characters." };
  if (!modes.length || modes.length > 20 || modes.some((v) => !v || v.length > 60) || new Set(modes.map((v) => v.toLowerCase())).size !== modes.length) return { error: "Enter between 1 and 20 unique study modes." };
  if (!programmes.length || programmes.length > 100 || programmes.some((v) => !v || v.length > 190) || new Set(programmes.map((v) => v.toLowerCase())).size !== programmes.length) return { error: "Select between 1 and 100 unique programmes." };
  return { values: { institutionName: name, institutionWebsite: website, institutionLogo: logo, institutionEmail: email, institutionPhone: phone, institutionAddress: address, language: "en", currency, feeAmount, feeDescription, modesOfStudy: modes, programmeNames: programmes } };
}

module.exports = { PROGRAMME_PRESETS, programmeId, validateInstitutionSettings };
