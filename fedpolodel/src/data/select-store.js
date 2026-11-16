function selectStore(env = process.env) {
  const provider = String(env.DATA_STORE || "").trim().toLowerCase();
  if (!provider && env.NODE_ENV === "production") throw new Error("Production requires DATA_STORE=firestore.");
  if (provider && !["sqlite", "firestore"].includes(provider)) throw new Error("DATA_STORE must be sqlite or firestore.");
  if (env.NODE_ENV === "production" && provider !== "firestore") throw new Error("SQLite is not supported in production; set DATA_STORE=firestore.");
  if (env.NODE_ENV === "production" && env.FIRESTORE_EMULATOR_HOST) throw new Error("FIRESTORE_EMULATOR_HOST is not permitted in production.");
  if (provider !== "firestore") return { store: require("./store"), sessionStore: undefined };
  const projectId = String(env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || "").trim();
  if (!projectId) throw new Error("Firestore requires GOOGLE_CLOUD_PROJECT.");
  const { applicationDefault, initializeApp, getApps } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const { createFirestoreStore } = require("./firestore");
  const { FirestoreSessionStore } = require("./firestore-session");
  const app = getApps()[0] || initializeApp({ projectId, credential: applicationDefault() });
  const db = getFirestore(app);
  return { store: createFirestoreStore(db), sessionStore: new FirestoreSessionStore(db) };
}

module.exports = { selectStore };
