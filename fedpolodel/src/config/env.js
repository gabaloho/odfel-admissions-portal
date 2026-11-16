const fs = require("fs");
const path = require("path");
const util = require("util");

/**
 * Loads backend settings (fee, programmes, secrets, ...) from `backend.env` next
 * to app.js, if that file exists. Variables already set in the real environment
 * win over the file. Set BACKEND_ENV_FILE to use another file, or to "none" to
 * skip loading (the test suite does this).
 *
 * Must run before src/data/store.js is required: the store reads PROGRAMS_JSON
 * when it loads.
 */
function loadBackendEnv(rootDir) {
  const configured = String(process.env.BACKEND_ENV_FILE || "").trim();
  if (configured.toLowerCase() === "none") {
    return null;
  }
  const file = configured ? path.resolve(configured) : path.join(rootDir, "backend.env");
  if (!fs.existsSync(file)) {
    if (configured) {
      throw new Error(`BACKEND_ENV_FILE points to a missing file: ${file}`);
    }
    return null;
  }
  process.loadEnvFile(file);
  return file;
}

/** Reads one value from the frontend's .env file without loading it into process.env. */
function readFrontendEnvValue(rootDir, key) {
  const file = path.join(rootDir, "fedpolodfel-react", ".env");
  try {
    const value = util.parseEnv(fs.readFileSync(file, "utf8"))[key];
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

module.exports = { loadBackendEnv, readFrontendEnvValue };
