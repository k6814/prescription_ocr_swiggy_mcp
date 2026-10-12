// AES-256-GCM for Swiggy tokens at rest.
//
// Swiggy's delegated-auth contract requires per-user tokens be stored "never
// shared across users, never persisted in plaintext beyond its lifetime".
// Plain file perms satisfy the first half but not the second, so tokens get
// encrypted with a key that lives in the environment, not in the data file.

import crypto from "node:crypto";

const ALGO = "aes-256-gcm";

function key() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be 64 hex chars. Generate: openssl rand -hex 32"
    );
  }
  return Buffer.from(hex, "hex");
}

export function encrypt(plainObject) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(plainObject), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export function decrypt(blob) {
  if (!blob) return null;
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const out = Buffer.concat([
    decipher.update(Buffer.from(blob.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(out.toString("utf8"));
}

/** Bearer tokens are compared by hash so the raw value never sits in the file. */
export function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function newUserToken() {
  return crypto.randomBytes(32).toString("base64url");
}
