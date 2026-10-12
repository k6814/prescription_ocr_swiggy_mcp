// Per-user MCP client + OAuth orchestration against Swiggy Instamart.
//
// Every function takes a userKey. There is no ambient "current user" -- that
// was the whole defect in the single-user version.
//
// Token lifetime note (from Swiggy's delegated-auth docs): access tokens last
// 5 days and v1 issues NO refresh token, so each person re-runs the browser
// authorization roughly weekly. The underlying Swiggy session lasts 30 days
// idle, so that re-auth is usually silent -- no phone+OTP again. Treat any 401
// as "re-run authorization", never as a permanent failure.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { SwiggyOAuthProvider } from "./swiggyOAuthProvider.js";

export const SERVER_URL = "https://mcp.swiggy.com/im";

function buildProvider(userKey) {
  return new SwiggyOAuthProvider({
    userKey,
    redirectUrl: `${process.env.PUBLIC_BASE_URL}/swiggy/auth/callback`,
  });
}

export async function startAuthFlow(userKey) {
  const provider = buildProvider(userKey);
  const result = await auth(provider, { serverUrl: SERVER_URL });
  if (result !== "REDIRECT" || !provider.capturedAuthorizationUrl) {
    throw new Error(`Unexpected auth() result starting flow: ${result}`);
  }
  return provider.capturedAuthorizationUrl.toString();
}

export async function completeAuthFlow(userKey, authorizationCode) {
  const provider = buildProvider(userKey);
  const result = await auth(provider, { serverUrl: SERVER_URL, authorizationCode });
  if (result !== "AUTHORIZED") {
    throw new Error(`Unexpected auth() result completing flow: ${result}`);
  }
}

// One live MCP session per user, reused across requests.
//
// The previous version opened a NEW transport + Client on every call and never
// closed it. A single bulk-search term spans several paginated calls, so a
// 30-term crawl would open well over a hundred sessions; Swiggy starts
// refusing them and every request after the first term dies with
// "Streamable HTTP error: Error POSTing to endpoint".
const clients = new Map(); // userKey -> { client, transport }

export async function closeClient(userKey) {
  const entry = clients.get(userKey);
  clients.delete(userKey);
  if (!entry) return;
  try { await entry.client.close(); } catch { /* already gone */ }
  try { await entry.transport.close(); } catch { /* already gone */ }
}

async function openClient(userKey) {
  const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
    authProvider: buildProvider(userKey),
  });
  const client = new Client({ name: "instamart-nl-cart", version: "0.2.0" });
  await client.connect(transport);
  const entry = { client, transport };
  clients.set(userKey, entry);
  return client;
}

export async function getConnectedClient(userKey) {
  const existing = clients.get(userKey);
  if (existing) return existing.client;
  return openClient(userKey);
}

/**
 * Call a tool, transparently reconnecting once if the session has died.
 * Sessions expire, and the server may drop them; a dead session should cost
 * one retry, not the whole crawl.
 */
export async function callTool(userKey, name, args) {
  const client = await getConnectedClient(userKey);
  try {
    return await client.callTool({ name, arguments: args });
  } catch (err) {
    const msg = String(err?.message ?? err);
    const transportDied = /Streamable HTTP|POSTing to endpoint|session|closed|ECONNRESET|socket hang up/i.test(msg);
    if (!transportDied) throw err;
    await closeClient(userKey);
    const fresh = await openClient(userKey);
    return fresh.callTool({ name, arguments: args });
  }
}
