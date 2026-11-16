const session = require("express-session");
const crypto = require("crypto");

class FirestoreSessionStore extends session.Store {
  constructor(db, { ttlMs = 86400000 } = {}) {
    super();
    this.collection = db.collection("sessions");
    this.ttlMs = ttlMs;
  }

  ref(sid) {
    return this.collection.doc(crypto.createHash("sha256").update(sid).digest("hex"));
  }

  get(sid, callback) {
    this.ref(sid).get().then((snapshot) => {
      if (!snapshot.exists) return callback(null, null);
      const data = snapshot.data();
      const expiresAt = typeof data.expiresAt?.toDate === "function" ? data.expiresAt.toDate() : new Date(data.expiresAt);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        return this.ref(sid).delete().then(() => callback(null, null));
      }
      return callback(null, JSON.parse(data.session));
    }).catch(callback);
  }

  set(sid, value, callback = () => {}) {
    const expires = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + this.ttlMs;
    this.ref(sid).set({ session: JSON.stringify(value), expiresAt: new Date(expires) }).then(() => callback(null)).catch(callback);
  }

  destroy(sid, callback = () => {}) {
    this.ref(sid).delete().then(() => callback(null)).catch(callback);
  }

  touch(sid, value, callback = () => {}) {
    const expires = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + this.ttlMs;
    // update does not resurrect a session deleted by logout.
    this.ref(sid).update({ expiresAt: new Date(expires) }).then(() => callback(null)).catch((error) => {
      if (error.code === 5 || error.code === "not-found") return callback(null);
      return callback(error);
    });
  }
}

module.exports = { FirestoreSessionStore };
