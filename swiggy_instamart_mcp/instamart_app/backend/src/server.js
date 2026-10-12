import "dotenv/config";
import express from "express";
import { parseShoppingList } from "./groqParser.js";
import { findMatch } from "./matcher.js";
import { startAuthFlow, completeAuthFlow, callTool, closeClient } from "./instamartClient.js";
import { verifyState } from "./swiggyOAuthProvider.js";
import * as store from "./store.js";
import { newUserToken } from "./crypto.js";
import { unwrap } from "./unwrap.js";

// ===========================================================================
// FIELD PATHS -- fill from `npm run inspect-shapes <user-token> "milk"`.
// Tool names/arguments are confirmed; response field names are not.
// ===========================================================================
// All confirmed from real responses captured via inspect-shapes.
// search_products nests variants under `variations` (not `variants`) and uses
// `displayName` (not `name`); the matcher reads those directly.
const FIELDS = {
  addressList: "addresses",
  addressId: "id",
  addressLabel: "addressTag",
  addressLine: "addressLine",

  productList: "products",
  similarProductList: "similarProducts",   // second array Swiggy returns

  // get_cart -> { cartTotalAmount, items[], billBreakdown, cartAbsent }
  // NOTE: the cart was EMPTY when captured, so the per-item field names below
  // are still unverified. Once you have something in the cart, re-run
  // inspect-shapes and confirm -- getting these wrong means the merge drops
  // existing items. The guard in /api/cart/confirm refuses to write if the
  // cart is non-empty but no spinIds could be read, rather than wiping it.
  // CONFIRMED against a real non-empty cart:
  //   items[] = { spinId, skuId, productId, itemName, itemVariant, quantity,
  //               storeId, maxQuantity, ... }
  cartItems: "items",
  cartItemSpinId: "spinId",
  cartItemSkuId: "skuId",
  cartItemQuantity: "quantity",
  cartItemName: "itemName",
  cartItemVariant: "itemVariant",
  // The cart is bound to one address, reported as the PREFIX of the
  // get_addresses id (before "__").
  cartAddress: "selectedAddress",
};

/** get_addresses ids look like "abc123__XYZ"; get_cart reports just "abc123". */
const addressPrefix = (id) => String(id ?? "").split("__")[0];

const app = express();
app.use(express.json());

// Behind a reverse proxy (Dokploy/Traefik, nginx) every request arrives from the proxy, so
// req.ip would be the SAME for everyone and the /enroll rate limit would lock out all users
// collectively after ten attempts. TRUST_PROXY=1 tells Express to read the client address
// from X-Forwarded-For instead.
//
// It is opt-in because trusting that header when nothing sets it lets a client forge its own
// address. Set it to the number of proxies in front of this app -- 1 for a standard Dokploy
// deployment -- and leave it unset when running directly.
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set("trust proxy", Number.isFinite(hops) ? hops : process.env.TRUST_PROXY);
}

// Unauthenticated liveness probe, for container health checks. Deliberately says nothing
// about users, connections or configuration -- it is reachable by anyone who can reach the
// port, so it reports only that the process is up.
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---- identity: every /api call resolves to exactly one user ----

function auth(req, res, next) {
  const header = req.get("authorization") ?? "";
  const raw = header.startsWith("Bearer ") ? header.slice(7) : null;
  const userKey = store.resolveUser(raw);
  if (!userKey) return res.status(401).json({ error: "invalid token" });
  req.userKey = userKey;
  next();
}

// ---- open enrollment: the Swiggy OTP is the only thing a user has to do ----
//
// This route is PUBLIC, and deliberately so. Previously a bearer token was minted by
// `npm run add-user` and pasted into the app by hand, which meant the Swiggy login could
// not even be reached without an out-of-band step. Enrollment inverts that: anyone may
// take a token, but it is INERT until they complete a real Swiggy authorization.
//
// What makes that safe is a property of the routes, not of this handler: every route that
// spends anything -- search, preview (Groq), cart read and cart write -- sits behind
// requireConnected. An unconnected token reaches only /api/status and /api/auth/link,
// and /api/auth/link just sends the holder to Swiggy's own login page.
//
// Two consequences to be honest about:
//   - Per-user revocation is weakened. `add-user --remove` still drops that record, but
//     nothing stops the same person enrolling again. To actually shut the door, set
//     ENROLL_DISABLED=1; to cut one person off from Swiggy, remove their record so their
//     stored Swiggy tokens go with it.
//   - Records accumulate. Unconnected ones are pruned after ENROLL_TTL_HOURS (default 24).
const ENROLL_TTL_HOURS = Number(process.env.ENROLL_TTL_HOURS ?? 24);
const ENROLL_WINDOW_MS = 60 * 60 * 1000;
const ENROLL_MAX_PER_WINDOW = Number(process.env.ENROLL_MAX_PER_HOUR ?? 10);
const enrollHits = new Map(); // ip -> timestamps. In-memory: resets on restart, which is fine.

app.post("/enroll", (req, res) => {
  if (process.env.ENROLL_DISABLED === "1") {
    return res.status(403).json({
      error: "enrollment is closed on this server",
      hint: "ask the operator for a token, or unset ENROLL_DISABLED",
    });
  }

  // Crude per-IP throttle. Not a defence against a determined attacker -- it is there so a
  // loop or a bad retry cannot fill users.json before the pruner next runs.
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const hits = (enrollHits.get(ip) ?? []).filter((t) => now - t < ENROLL_WINDOW_MS);
  if (hits.length >= ENROLL_MAX_PER_WINDOW) {
    return res.status(429).json({ error: "too many enrollments from this address; try later" });
  }
  hits.push(now);
  enrollHits.set(ip, hits);

  try {
    store.pruneUnconnected(ENROLL_TTL_HOURS * 60 * 60 * 1000);
    const token = newUserToken();
    // The id is a label for `add-user --list`, not an identity: identity is the Swiggy
    // account this token gets attached to when the OTP completes.
    const id = `app-${new Date().toISOString().slice(0, 10)}-${token.slice(0, 6)}`;
    store.addUser(id, token);
    res.json({ token, id });
  } catch (err) {
    console.error("enroll failed:", err);
    res.status(500).json({ error: "could not create an account on this server" });
  }
});

app.use("/api", auth);

function requireConnected(req, res) {
  if (!store.isConnected(req.userKey)) {
    res.status(409).json({ error: "not connected", action: "call /api/auth/link" });
    return false;
  }
  return true;
}

// Swiggy 401/419 => this user's token died; surface it as reconnect, not 500.
function handleErr(req, res, err) {
  const msg = String(err?.message ?? err);
  if (/401|419|unauthor/i.test(msg)) {
    store.clearTokens(req.userKey);
    closeClient(req.userKey).catch(() => {});
    return res.status(409).json({ error: "swiggy session expired", action: "call /api/auth/link" });
  }
  console.error(`[${store.userIdOf(req.userKey)}]`, err);
  res.status(500).json({ error: msg });
}

// ---- OAuth ----

// The app asks for a personal link. The browser that opens it carries no
// bearer token, so the user identity rides in the signed `state` parameter,
// which the callback verifies.
app.get("/api/auth/link", async (req, res) => {
  try {
    res.json({ url: await startAuthFlow(req.userKey) });
  } catch (err) {
    handleErr(req, res, err);
  }
});

app.get("/swiggy/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Swiggy auth failed: ${error}`);
  const userKey = verifyState(state);
  if (!userKey) return res.status(400).send("Invalid or tampered state parameter.");
  try {
    await completeAuthFlow(userKey, code);
    // Hand control straight back to the app. The browser tab the app opened is an auth
    // session bound to APP_RETURN_URL's scheme, so navigating there dismisses it and the app
    // resumes -- the user never has to find their way back manually. The visible link is the
    // fallback for anyone who completed this in a plain browser instead.
    // Hand control straight back to the app. The tab the app opened is an auth session bound
    // to APP_RETURN_URL's scheme, so navigating there dismisses it and the app resumes.
    //
    // The scheme only resolves if the installed build declares it. An older build, or a plain
    // browser, has no handler -- the navigation silently does nothing and a bare link would
    // just sit there looking broken. So the page leads with the outcome and an instruction
    // that is true either way, and offers the link only as a secondary action.
    const ret = process.env.APP_RETURN_URL || "rxocr://connected";
    res.send(
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Connected</title></head>` +
      `<body style="font-family:system-ui,-apple-system,sans-serif;margin:0;padding:2.5rem 1.5rem;` +
      `text-align:center;color:#1B2638;background:#E8EEEA">` +
      `<div style="max-width:22rem;margin:0 auto;background:#FBFCFA;border-radius:18px;padding:1.75rem">` +
      `<div style="font-size:2.5rem;line-height:1">&#10003;</div>` +
      `<h1 style="font-size:1.25rem;margin:.75rem 0 .5rem">Connected to Swiggy</h1>` +
      `<p style="color:#5B6676;line-height:1.5;margin:0 0 1.25rem">` +
      `You can close this tab and return to the app.</p>` +
      `<a href="${ret}" style="display:inline-block;min-height:44px;line-height:44px;` +
      `padding:0 1.25rem;border-radius:10px;background:#2447A6;color:#fff;text-decoration:none;` +
      `font-weight:700">Open the app</a>` +
      `<p style="color:#5B6676;font-size:.8rem;margin:1rem 0 0">` +
      `If that button does nothing, switch back to the app yourself &mdash; you are already connected.</p>` +
      `</div>` +
      `<script>setTimeout(function(){location.replace(${JSON.stringify(ret)})},400)</script>` +
      `</body></html>`
    );
  } catch (err) {
    console.error(err);
    res.status(500).send(String(err));
  }
});

app.post("/api/auth/disconnect", async (req, res) => {
  // Best-effort revoke on Swiggy's side, then drop locally either way.
  try {
    const tokens = store.getTokens(req.userKey);
    if (tokens?.access_token) {
      await fetch("https://mcp.swiggy.com/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }).catch(() => {});
    }
  } finally {
    store.clearTokens(req.userKey);
    res.json({ disconnected: true });
  }
});

app.get("/api/status", (req, res) =>
  res.json({ user: store.userIdOf(req.userKey), connected: store.isConnected(req.userKey) })
);

// ---- addresses ----

app.get("/api/addresses", async (req, res) => {
  if (!requireConnected(req, res)) return;
  try {
    const data = unwrap(await callTool(req.userKey, "get_addresses", {}));
    const list = data[FIELDS.addressList] ?? [];
    res.json({
      addresses: list.map((a) => ({
        id: a[FIELDS.addressId],
        label: a[FIELDS.addressLabel] ?? "(unlabelled)",
        line: a[FIELDS.addressLine],
        category: a.addressCategory,
      })),
      // NOTE: nested under `resolution`, not top-level. Reading it from the
      // top level is why the first inspect run passed no addressId.
      suggestedAddressId: data.resolution?.defaultAddressId ?? null,
      needsUserClarification: data.resolution?.needsUserClarification ?? true,
    });
  } catch (err) {
    handleErr(req, res, err);
  }
});

// ---- raw search: no Groq, no matching, no writes ----
//
// Deliberately separate from /api/cart/preview. This passes your text straight
// to Swiggy and returns everything it sends back, flattened to one row per
// buyable variant. Use it to see what actually exists before deciding what to
// add -- and to check whether a bad result came from the parser or from
// Swiggy's search.
app.get("/api/search", async (req, res) => {
  if (!requireConnected(req, res)) return;
  const { q, addressId, offset } = req.query;
  if (!q) return res.status(400).json({ error: "q required" });
  if (!addressId) return res.status(400).json({ error: "addressId required" });
  try {
    const args = { addressId, query: q };
    if (offset !== undefined && offset !== "") args.offset = Number(offset);
    const data = unwrap(await callTool(req.userKey, "search_products", args));

    const rows = [];
    const take = (list, isSimilar) => {
      for (const p of list ?? []) {
        for (const v of p.variations ?? []) {
          rows.push({
            product: p.displayName,
            brand: p.brand ?? v.brandName ?? null,
            size: v.quantityDescription,
            price: v.price?.offerPrice ?? v.price?.mrp ?? null,
            mrp: v.price?.mrp ?? null,
            unitPrice: v.price?.unitLevelPrice ?? null,
            inStock: v.isInStockAndAvailable !== false,
            maxQuantity: v.maxQuantity ?? null,
            rating: v.rating?.value ?? null,
            spinId: v.spinId,
            skuId: v.skuId ?? null,
            isSimilar,
          });
        }
      }
    };
    take(data[FIELDS.productList], false);
    take(data[FIELDS.similarProductList], true);

    res.json({
      query: q,
      count: rows.length,
      directCount: rows.filter((r) => !r.isSimilar).length,
      nextOffset: data.nextOffset ?? null,
      results: rows,
    });
  } catch (err) {
    handleErr(req, res, err);
  }
});

// ---- preview (no writes) ----

app.post("/api/cart/preview", async (req, res) => {
  if (!requireConnected(req, res)) return;
  const { text, addressId } = req.body;
  if (!addressId) return res.status(400).json({ error: "addressId required" });
  try {
    const items = await parseShoppingList(text);
    const results = [];
    for (const item of items) {
      // Search the full descriptive phrase, not the stripped generic name:
      // searching "paracetamol" for "crocin advance paracetamol 500mg" returns
      // every brand and loses the user's intent.
      const data = unwrap(
        await callTool(req.userKey, "search_products", { addressId, query: item.query ?? item.name })
      );
      const match = findMatch(
        item,
        data[FIELDS.productList] ?? [],
        data[FIELDS.similarProductList] ?? []
      );
      results.push({ item, status: match.status, options: match.options });
    }
    res.json({ results });
  } catch (err) {
    handleErr(req, res, err);
  }
});

// ---- confirm (the only write; merges, never replaces) ----

app.post("/api/cart/confirm", async (req, res) => {
  if (!requireConnected(req, res)) return;
  const { addressId, selections } = req.body;
  if (!addressId) return res.status(400).json({ error: "addressId required" });
  if (!Array.isArray(selections) || selections.length === 0) {
    return res.status(400).json({ error: "no selections supplied" });
  }
  try {
    // update_cart REPLACES the whole cart, so read-merge-write.
    const cartData = unwrap(await callTool(req.userKey, "get_cart", {}));
    const rawExisting = cartData[FIELDS.cartItems] ?? [];
    const existing = rawExisting
      .map((i) => ({
        spinId: i[FIELDS.cartItemSpinId],
        skuId: i[FIELDS.cartItemSkuId],
        quantity: i[FIELDS.cartItemQuantity],
      }))
      .filter((i) => i.spinId);

    // The cart belongs to ONE address. Writing a merged cart under a different
    // address moves an existing order to another store's catalogue, which can
    // silently drop or revalue items. Refuse and make the user decide.
    const cartAddr = addressPrefix(cartData[FIELDS.cartAddress]);
    if (rawExisting.length > 0 && cartAddr && cartAddr !== addressPrefix(addressId)) {
      return res.status(409).json({
        error: "cart belongs to a different delivery address",
        cartAddress: cartData[FIELDS.cartAddress],
        requestedAddress: addressId,
        existingItems: rawExisting.map((i) => i[FIELDS.cartItemName]).filter(Boolean),
        hint: "switch back to that address, or empty the cart in the Swiggy app first",
      });
    }

    // If the cart has items but we could not read a single spinId, our field
    // names are wrong -- and since update_cart REPLACES the cart, writing now
    // would delete everything already in it. Refuse instead.
    if (rawExisting.length > 0 && existing.length === 0) {
      return res.status(500).json({
        error: "cart is not empty but no spinIds could be read from it; refusing to write",
        hint: "re-run inspect-shapes with a non-empty cart and fix FIELDS.cartItem* in src/server.js",
        sampleItem: rawExisting[0],
      });
    }

    const merged = new Map();
    for (const i of existing) merged.set(`${i.spinId}|${i.skuId ?? ""}`, { ...i });
    for (const s of selections) {
      const k = `${s.spinId}|${s.skuId ?? ""}`;
      const prev = merged.get(k);
      merged.set(k, {
        spinId: s.spinId,
        skuId: s.skuId,
        quantity: (prev?.quantity ?? 0) + Number(s.quantity ?? 1),
      });
    }
    const items = [...merged.values()].map((i) =>
      i.skuId ? { spinId: i.spinId, skuId: i.skuId, quantity: i.quantity }
              : { spinId: i.spinId, quantity: i.quantity }
    );

    const result = unwrap(
      await callTool(req.userKey, "update_cart", { selectedAddressId: addressId, items })
    );
    res.json({ result, preservedFromExisting: existing.length });
  } catch (err) {
    handleErr(req, res, err);
  }
});

app.get("/api/cart", async (req, res) => {
  if (!requireConnected(req, res)) return;
  try {
    res.json({ cart: unwrap(await callTool(req.userKey, "get_cart", {})) });
  } catch (err) {
    handleErr(req, res, err);
  }
});

// No checkout route, deliberately -- see README.

// The OAuth redirect is built from PUBLIC_BASE_URL, but the Dynamic Client Registration
// result is cached in data/users.json and reused forever. Change PUBLIC_BASE_URL without
// clearing it and every authorization silently goes out with a redirect_uri that does not
// match the one Swiggy has on file -- which surfaces much later, as a rejected callback.
// Say so at startup instead.
function checkRedirectRegistration() {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) return console.warn("!  PUBLIC_BASE_URL is not set; the OAuth redirect cannot be built.");
  const willSend = `${base}/swiggy/auth/callback`;
  const registered = store.getClientInformation()?.redirect_uris;
  if (!registered) return console.log(`   OAuth redirect: ${willSend} (not registered yet)`);
  if (registered.includes(willSend)) return console.log(`   OAuth redirect: ${willSend}`);
  console.warn(
    `\n!  REDIRECT MISMATCH -- Swiggy will reject the callback.\n` +
    `!    will send:  ${willSend}\n` +
    `!    registered: ${registered.join(", ")}\n` +
    `!  Clear "clientInformation" from data/users.json to re-register with the new URL.\n` +
    `!  Note Swiggy requires exact-match HTTPS for anything that is not localhost.\n`
  );
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Listening on :${port}`);
  checkRedirectRegistration();
});
