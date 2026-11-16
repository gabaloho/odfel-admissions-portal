#!/usr/bin/env node
// `npm run dev`: start the Express backend and the Vite dev server together.
//
// The React app calls /api/... on the Vite server (port 5173), which proxies to
// the backend. If only Vite is running, every API call fails (e.g. you cannot
// register or log in), so this script always brings up both.
//
// Extra arguments are passed to Vite, e.g. `npm run dev -- --host`.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT, "fedpolodfel-react");
const VITE_BIN = path.join(FRONTEND_DIR, "node_modules", "vite", "bin", "vite.js");
const BACKEND_PORT = Number(process.env.PORT || 3000);
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const STARTUP_TIMEOUT_MS = 30000;

const children = [];
let shuttingDown = false;

function log(message) {
  console.log(`[dev] ${message}`);
}

function fail(message) {
  console.error(`\n[dev] ${message}\n`);
  shutdown(1);
}

function prefixStream(stream, prefix, target) {
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop();
    for (const line of lines) target.write(`${prefix} ${line}\n`);
  });
  stream.on("end", () => {
    if (buffered) target.write(`${prefix} ${buffered}\n`);
  });
}

function start(name, args, options) {
  const child = spawn(process.execPath, args, { ...options, stdio: ["inherit", "pipe", "pipe"] });
  prefixStream(child.stdout, `[${name}]`, process.stdout);
  prefixStream(child.stderr, `[${name}]`, process.stderr);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    fail(`${name} stopped unexpectedly (${signal || `exit code ${code}`}). See the [${name}] output above.`);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1500).unref();
}

// Resolves true when an ODFel backend answers on BACKEND_PORT, false when the
// port is closed, and "foreign" when something else is listening there.
function probeBackend() {
  return new Promise((resolve) => {
    const req = http.get(`${BACKEND_URL}/api/auth/session`, { timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body).ok === true ? true : "foreign");
        } catch {
          resolve("foreign");
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve(err.message === "timeout" ? "foreign" : false));
  });
}

async function waitForBackend() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    if ((await probeBackend()) === true) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, "node_modules", "express"))) {
    return fail("Backend dependencies are missing. Run: npm --prefix fedpolodel install");
  }
  if (!fs.existsSync(VITE_BIN)) {
    return fail("Frontend dependencies are missing. Run: npm --prefix fedpolodel/fedpolodfel-react install");
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  const existing = await probeBackend();
  if (existing === true) {
    log(`Reusing the admissions backend already running at ${BACKEND_URL}.`);
  } else if (existing === "foreign") {
    return fail(
      `Port ${BACKEND_PORT} is in use by another program, so the backend cannot start.\n` +
        `[dev] Stop that program, or choose another port, e.g.  PORT=3001 npm run dev`
    );
  } else {
    log(`Starting the admissions backend on ${BACKEND_URL} ...`);
    start("api", [path.join(ROOT, "app.js")], { cwd: ROOT, env: { ...process.env, PORT: String(BACKEND_PORT) } });
    if (!(await waitForBackend())) {
      if (!shuttingDown) fail(`The backend did not respond on ${BACKEND_URL} within ${STARTUP_TIMEOUT_MS / 1000}s.`);
      return undefined;
    }
    log("Backend is ready.");
  }

  log("Starting the Vite dev server (API calls are proxied to the backend) ...");
  start("web", [VITE_BIN, ...process.argv.slice(2)], {
    cwd: FRONTEND_DIR,
    env: { ...process.env, BACKEND_URL },
  });
  return undefined;
}

main().catch((err) => fail(err.stack || String(err)));
