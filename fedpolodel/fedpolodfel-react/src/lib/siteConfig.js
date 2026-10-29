const env = import.meta.env;

function optionalValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validateHttpUrl(value, variableName) {
  if (!value) {
    return "";
  }

  let parsedWebsite;
  try {
    parsedWebsite = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid HTTP or HTTPS URL.`);
  }
  if (parsedWebsite.protocol !== "http:" && parsedWebsite.protocol !== "https:") {
    throw new Error(`${variableName} must use HTTP or HTTPS.`);
  }
  if (parsedWebsite.username || parsedWebsite.password) {
    throw new Error(`${variableName} must not contain credentials.`);
  }

  return value;
}

const institutionWebsite = validateHttpUrl(
  optionalValue(env.VITE_INSTITUTION_WEBSITE),
  "VITE_INSTITUTION_WEBSITE"
);
const configuredLogo = optionalValue(env.VITE_INSTITUTION_LOGO);
const institutionLogo =
  configuredLogo.startsWith("/") && !configuredLogo.startsWith("//")
    ? configuredLogo
    : validateHttpUrl(configuredLogo, "VITE_INSTITUTION_LOGO");
const configuredModes = optionalValue(env.VITE_MODES_OF_STUDY);
const modesOfStudy = configuredModes
  ? configuredModes.split(",").map((mode) => mode.trim()).filter(Boolean)
  : ["Full-Time", "Part-Time", "Distance Learning"];
if (modesOfStudy.length === 0 || new Set(modesOfStudy).size !== modesOfStudy.length) {
  throw new Error("VITE_MODES_OF_STUDY must be a comma-separated list of unique study modes.");
}

export const siteConfig = Object.freeze({
  brandName: "ODFel",
  institutionName: optionalValue(env.VITE_INSTITUTION_NAME) || "Your Institution",
  institutionWebsite,
  institutionEmail: optionalValue(env.VITE_INSTITUTION_EMAIL),
  institutionPhone: optionalValue(env.VITE_INSTITUTION_PHONE),
  institutionAddress: optionalValue(env.VITE_INSTITUTION_ADDRESS),
  institutionLogo,
  modesOfStudy,
});
