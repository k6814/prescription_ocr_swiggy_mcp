// Implements the MCP SDK's OAuthClientProvider interface, bound to ONE user.
//
// Two things differ from the single-user version:
//  - every token/verifier read and write is scoped to a userKey
//  - state() returns a value that encodes which user started the flow, so the
//    OAuth callback can attribute the returned code to the right person. This
//    doubles as the CSRF defence the SDK expects state to provide.

import crypto from "node:crypto";
import * as store from "./store.js";

const STATE_SECRET_ENV = "ENCRYPTION_KEY"; // reuse; it's already a strong secret

export function signState(userKey) {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const payload = `${userKey}.${nonce}`;
  const mac = crypto
    .createHmac("sha256", process.env[STATE_SECRET_ENV])
    .update(payload)
    .digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${mac}`;
}

export function verifyState(state) {
  const [b64, mac] = String(state ?? "").split(".");
  if (!b64 || !mac) return null;
  const payload = Buffer.from(b64, "base64url").toString();
  const expected = crypto
    .createHmac("sha256", process.env[STATE_SECRET_ENV])
    .update(payload)
    .digest("base64url");
  // timing-safe compare
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return payload.split(".")[0]; // userKey
}

export class SwiggyOAuthProvider {
  constructor({ userKey, redirectUrl, scope = "mcp:tools" }) {
    this.userKey = userKey;
    this._redirectUrl = redirectUrl;
    this._scope = scope;
    this.capturedAuthorizationUrl = null;
  }

  get redirectUrl() {
    return this._redirectUrl;
  }

  get clientMetadata() {
    return {
      client_name: "Instamart NL Cart",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: this._scope,
    };
  }

  // Ties this authorization attempt to this user.
  state() {
    return signState(this.userKey);
  }

  // DCR result is per-application: shared across users deliberately.
  clientInformation() {
    return store.getClientInformation();
  }
  saveClientInformation(info) {
    store.setClientInformation(info);
  }

  // Everything below is per-user.
  tokens() {
    return store.getTokens(this.userKey);
  }
  saveTokens(tokens) {
    store.setTokens(this.userKey, tokens);
  }
  saveCodeVerifier(v) {
    store.setCodeVerifier(this.userKey, v);
  }
  codeVerifier() {
    return store.getCodeVerifier(this.userKey);
  }

  redirectToAuthorization(url) {
    this.capturedAuthorizationUrl = url;
  }

  // Called by the SDK when Swiggy rejects the credentials (401/419). Clearing
  // here means the next request re-runs authorization instead of looping.
  invalidateCredentials(scope) {
    if (scope === "all" || scope === "tokens") store.clearTokens(this.userKey);
  }
}
