// Per-user store. Replaces the old single-user tokenStore.js, which kept ONE
// `tokens` key -- meaning the second person to connect silently overwrote the
// first, and everyone afterwards drove that person's Swiggy account. That is
// the bug this file exists to remove.
//
// Shape on disk (data/users.json):
// {
//   "clientInformation": {...},        // OAuth DCR result -- per APPLICATION, shared
//   "users": {
//     "<sha256 of bearer token>": {
//       "id": "kevin",
//       "swiggyTokens": { iv, tag, data },   // encrypted
//       "codeVerifier": "...",               // transient, during auth only
//       "connectedAt": "..."
//     }
//   }
// }
//
// A JSON file is fine for a handful of known people. Past that, move to a real
// database -- concurrent writes here are last-write-wins.

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encrypt, decrypt, hashToken } from "./crypto.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const FILE = join(DATA_DIR, "users.json");

function load() {
  if (!existsSync(FILE)) return { clientInformation: null, users: {} };
  return JSON.parse(readFileSync(FILE, "utf-8"));
}

function save(db) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(db, null, 2));
  chmodSync(FILE, 0o600);
}

// ---- users ----

export function addUser(id, rawToken) {
  const db = load();
  db.users[hashToken(rawToken)] = {
    id,
    swiggyTokens: null,
    connectedAt: null,
    createdAt: new Date().toISOString(),
  };
  save(db);
}

/**
 * Delete users who were issued a token but never completed Swiggy authorization.
 *
 * Open enrollment (POST /enroll) means anyone can create a record, so without this
 * users.json grows without bound and a JSON file that is last-write-wins is exactly
 * the wrong thing to let grow. A record with no `createdAt` predates enrollment and
 * is never pruned -- those are the people you issued tokens to by hand.
 */
export function pruneUnconnected(maxAgeMs) {
  const db = load();
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const [k, u] of Object.entries(db.users)) {
    if (u.swiggyTokens || !u.createdAt) continue;
    if (Date.parse(u.createdAt) < cutoff) { delete db.users[k]; removed++; }
  }
  if (removed) save(db);
  return removed;
}

export function listUsers() {
  const db = load();
  return Object.values(db.users).map((u) => ({
    id: u.id,
    connected: Boolean(u.swiggyTokens),
    connectedAt: u.connectedAt,
  }));
}

/** Resolve an incoming bearer token to a user key, or null. */
export function resolveUser(rawToken) {
  if (!rawToken) return null;
  const db = load();
  const key = hashToken(rawToken);
  return db.users[key] ? key : null;
}

export function userIdOf(userKey) {
  return load().users[userKey]?.id ?? null;
}

export function removeUser(id) {
  const db = load();
  for (const [k, u] of Object.entries(db.users)) if (u.id === id) delete db.users[k];
  save(db);
}

// ---- per-user Swiggy credentials ----

export function getTokens(userKey) {
  const u = load().users[userKey];
  return u?.swiggyTokens ? decrypt(u.swiggyTokens) : undefined;
}

export function setTokens(userKey, tokens) {
  const db = load();
  db.users[userKey].swiggyTokens = encrypt(tokens);
  db.users[userKey].connectedAt = new Date().toISOString();
  save(db);
}

export function clearTokens(userKey) {
  const db = load();
  if (db.users[userKey]) {
    db.users[userKey].swiggyTokens = null;
    db.users[userKey].connectedAt = null;
    save(db);
  }
}

export function isConnected(userKey) {
  return Boolean(load().users[userKey]?.swiggyTokens);
}

export function getCodeVerifier(userKey) {
  return load().users[userKey]?.codeVerifier;
}

export function setCodeVerifier(userKey, v) {
  const db = load();
  db.users[userKey].codeVerifier = v;
  save(db);
}

// ---- OAuth client registration: per application, not per user ----

export function getClientInformation() {
  return load().clientInformation ?? undefined;
}

export function setClientInformation(info) {
  const db = load();
  db.clientInformation = info;
  save(db);
}
