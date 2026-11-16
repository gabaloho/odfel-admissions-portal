import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Express backend (../app.js) listens on PORT, which defaults to 3000.
const DEFAULT_API_PROXY_TARGET = "http://127.0.0.1:3000";

// Backend routes the browser requests directly. Everything else, including
// SPA routes like /admin/payments, is handled by Vite and React Router.
const BACKEND_PATHS = [
  "/api/", // JSON API used by apiRequest()
  "/admin/payments/export.csv", // reconciliation CSV download link
  "/webhooks/", // payment provider webhooks (useful for local testing)
];

function resolveProxyTarget(value) {
  const target = (value || "").trim() || DEFAULT_API_PROXY_TARGET;

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error(`BACKEND_URL or API_PROXY_TARGET must be a valid HTTP or HTTPS URL (received "${target}").`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("BACKEND_URL or API_PROXY_TARGET must use HTTP or HTTPS.");
  }

  return target;
}

function createBackendProxy(target) {
  const options = {
    target,
    changeOrigin: true,
    xfwd: true,
    configure(proxy) {
      // Runs before Vite's own handler. Send a JSON error that apiRequest()
      // can display, rather than an empty 500 response.
      proxy.on("error", (err, req, res) => {
        if (!res || !("req" in res) || res.headersSent || res.writableEnded) {
          return;
        }
        const reason = err.code ? ` (${err.code})` : "";
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            message: `Backend API is unreachable at ${target}${reason}. Start it with "node app.js" in fedpolodel/ and check that terminal for errors, or run "npm run dev" there to start the API and UI together.`,
          })
        );
      });
    },
  };

  return Object.fromEntries(BACKEND_PATHS.map((path) => [path, options]));
}

// Reports in the Vite terminal whether the backend can be reached, so a stopped
// or crashed backend shows up at startup, not when a user submits a form.
// Any HTTP response counts as reachable. Only network errors count as down.
function backendStatusPlugin(target) {
  const healthUrl = `${target.replace(/\/+$/, "")}/api/health`;
  const POLL_MS = 1000;
  const GRACE_MS = 4000; // `npm run dev` starts both servers at once

  async function isReachable() {
    try {
      await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      return false;
    }
  }

  function watchBackend(server) {
    const { httpServer } = server;
    if (!httpServer) {
      return;
    }
    const logger = server.config.logger;
    let timer;
    let warned = false;

    async function check(startedAt) {
      if (await isReachable()) {
        logger.info(`  ✓ Backend API reachable at ${target}${warned ? " (now connected)" : ""}`);
        return;
      }
      if (!warned && Date.now() - startedAt >= GRACE_MS) {
        warned = true;
        logger.warn(
          [
            `  ✗ Backend API is not reachable at ${target}. Signup, login and other API calls will fail.`,
            `    Start it in another terminal: cd fedpolodel && node app.js (then check that terminal for errors)`,
            `    Or stop this server and run "npm run dev" in fedpolodel/ to start the API and UI together.`,
            `    Waiting for the backend...`,
          ].join("\n")
        );
      }
      timer = setTimeout(() => check(startedAt), POLL_MS);
      timer.unref();
    }

    httpServer.once("listening", () => check(Date.now()));
    httpServer.once("close", () => clearTimeout(timer));
  }

  return {
    name: "odfel-backend-status",
    configureServer: watchBackend,
    configurePreviewServer: watchBackend,
  };
}

export default defineConfig(({ mode }) => {
  // These values have no VITE_ prefix, so they stay server-side and are never
  // bundled into client code. BACKEND_URL takes precedence; API_PROXY_TARGET
  // remains as a compatibility alias.
  const env = loadEnv(mode, process.cwd(), "");
  const target = resolveProxyTarget(env.BACKEND_URL || env.API_PROXY_TARGET);
  const proxy = createBackendProxy(target);

  return {
    plugins: [react(), backendStatusPlugin(target)],
    server: { proxy },
    preview: { proxy },
  };
});
