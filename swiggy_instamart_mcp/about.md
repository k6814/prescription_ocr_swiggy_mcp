# CLAUDE.md — swiggy_instamart_mcp (Instamart cart backend)

Working context for AI assistants and for the engineer wiring this backend to
the prescription-OCR app at `/home/k6814/Downloads/rx-ocr-expo`.


## 1. What this repo is

A natural-language → Swiggy Instamart cart builder. You say what you want in
plain English; it parses that into items (Groq), searches Instamart's MCP
server, ranks the results, asks you to disambiguate when it must, and writes
the chosen variants into your **real Swiggy cart**.

It **never places an order.** There is no checkout route, deliberately —
building the cart is automated, spending money stays a tap in Swiggy's own app.
[VERIFIED — no checkout/confirm-order route exists in `src/server.js`.]

Two projects live here, and only one matters:

```
swiggy_instamart_mcp/
├── instamart_app/          ← THE REAL ONE
│   ├── backend/            Express + Groq + MCP. All credentials, all logic.
│   ├── mobile/             Expo RN thin client (3 files, ~300 lines total)
│   └── README.md
├── instamart_agent/        Python CLI prototype. Superseded. See §10.
└── README.md
```

`instamart_agent/` is the earlier Python CLI. It is **not runnable as shipped**
— `main.py` holds `SEARCH_TOOL_NAME = None` and exits rather than guess
[VERIFIED]. Everything it was for has been answered by the Node backend. Read
it only for the OAuth-port-80 discussion in `instamart_client.py`'s header.

---

## 2. Repository layout (the files that matter)

```
instamart_app/backend/
├── package.json            type: module; node src/server.js
├── .env / .env.example     GROQ_API_KEY, ENCRYPTION_KEY, PUBLIC_BASE_URL, PORT
├── src/
│   ├── server.js     321 L  Express app. THE HTTP CONTRACT + the FIELDS map.
│   ├── instamartClient.js   94 L  per-user MCP client, session reuse, 1 retry
│   ├── swiggyOAuthProvider.js 96 L OAuthClientProvider impl + HMAC state
│   ├── store.js     124 L  data/users.json; per-user tokens, DCR info
│   ├── crypto.js     54 L  AES-256-GCM at rest; SHA-256 bearer hashing
│   ├── unwrap.js     47 L  MCP tool result → payload, failures first
│   ├── groqParser.js 88 L  free text → [{query,name,brand,quantity,unit}]
│   └── matcher.js   227 L  rank search results → matched|ambiguous|no_match
├── scripts/
│   ├── add-user.js         issue / list / revoke personal bearer tokens
│   ├── discover-tools.js   dump every MCP tool name + JSON schema
│   └── inspect-shapes.js   dump real get_addresses / search_products / get_cart
├── setup.sh                7-step first run: deps → .env → server → user →
│                           Swiggy connect → address → shapes.json
├── add.sh                  interactive NL → preview → confirm, from the shell
├── search.sh               read-only search, --all paginates, --out writes JSON
├── bulk-search.sh          many queries → one deduped catalog.json
├── queries.txt             30 seed terms (meds/first-aid heavy)
├── more-meds.txt           10 extra brand terms
├── catalog.json            1227 variants — SHARED WITH THE OCR APP (§8)
├── shapes.json             captured real MCP responses (43 KB, from setup.sh)
├── .bulk-raw/              10 per-term raw search dumps
└── data/users.json         gitignored; encrypted tokens, chmod 600

instamart_app/mobile/
├── config.js    7 L   BASE_URL only — nothing secret ships in the APK
├── api.js      47 L   token in expo-secure-store + typed-ish fetch wrapper
└── App.js     253 L   token paste → connect → address → preview → confirm
```

Gitignored / local-only: `node_modules/`, `.env`, `data/`, `.user-token`,
`server.log`, `shapes.json` [VERIFIED from `.gitignore`]. Note `.address-id`
and `catalog.json` are **not** ignored.

---

## 3. Topology: module graph and data flow

```
                       HTTP (Bearer <personal token>)
                                   │
                            ┌──────▼───────┐
                            │  server.js   │  auth middleware on /api/*
                            │  FIELDS map  │  (callback route is NOT /api)
                            └──┬───┬───┬───┘
              parseShoppingList│   │   │findMatch
                    ┌──────────▼┐  │  ┌▼───────────┐
                    │groqParser │  │  │  matcher   │  pure; no I/O
                    └─────┬─────┘  │  └────────────┘
                     Groq API      │
                                   │ callTool(userKey, name, args)
                          ┌────────▼─────────┐
                          │ instamartClient  │ one MCP session per user
                          └────────┬─────────┘
                                   │ StreamableHTTP + OAuth
                    ┌──────────────▼──────────────┐
                    │ swiggyOAuthProvider (1/user)│
                    └──────┬───────────────┬──────┘
                        store.js        unwrap.js  (applied by server.js)
                           │
                     crypto.js → data/users.json (AES-256-GCM)
                           │
                   https://mcp.swiggy.com/im
```

The only stage that talks to Swiggy is `instamartClient`. The only stage that
talks to Groq is `groqParser`. `matcher.js` is pure — same input, same output,
no network — which is why it is the piece you can reason about offline.

### Request flow for the one write

```
POST /api/cart/preview {text, addressId}
  → groqParser.parseShoppingList(text)          Groq, JSON mode, temp 0
  → for each item: search_products {addressId, query: item.query}
  → unwrap() → {products[], similarProducts?[]}
  → matcher.findMatch(item, products, similarProducts)
  → {results:[{item, status, options[]}]}       NOTHING WRITTEN

POST /api/cart/confirm {addressId, selections[{spinId,skuId,quantity}]}
  → get_cart                                    read existing
  → guard: cart address == requested address?    else 409
  → guard: non-empty cart but 0 readable spinIds? else 500, refuse
  → merge existing ∪ selections (quantities add)
  → update_cart {selectedAddressId, items}      THE ONLY WRITE
```

---

## 4. The HTTP contract (what an integrating client consumes)

Express, `src/server.js`, default port 3000. **Every `/api/*` route requires
`Authorization: Bearer <personal token>`** — `app.use("/api", auth)` at
`src/server.js:63`, which includes `/api/auth/link` [VERIFIED]. The OAuth
callback deliberately sits *outside* `/api` because the browser that lands
there carries no bearer token; its defence is the HMAC-signed `state` (§5).

| Route | Method | Input | Success | Notes |
|---|---|---|---|---|
| `/enroll` | POST | — | `{token, id}` | **public, no bearer.** Issues an inert token; see §5. 403 if `ENROLL_DISABLED=1`, 429 if throttled |
| `/api/status` | GET | — | `{user, connected}` | cheap liveness + connection probe |
| `/api/auth/link` | GET | — | `{url}` | open in a browser; Swiggy phone+OTP |
| `/swiggy/auth/callback` | GET | `code`, `state` | HTML page | **no bearer**; verifies signed state |
| `/api/auth/disconnect` | POST | — | `{disconnected:true}` | best-effort Swiggy logout, always clears locally |
| `/api/addresses` | GET | — | `{addresses[{id,label,line,category}], suggestedAddressId, needsUserClarification}` | `suggestedAddressId` comes from `resolution.defaultAddressId`, **not** top level |
| `/api/search` | GET | `q`, `addressId`, `offset?` | `{query,count,directCount,nextOffset,results[]}` | live, read-only, no Groq, one row per buyable variant |
| `/api/cart/preview` | POST | `{text, addressId}` | `{results[{item,status,options[]}]}` | **calls Groq with the raw text** — see §9.4 |
| `/api/cart/confirm` | POST | `{addressId, selections[{spinId,skuId,quantity}]}` | `{result, preservedFromExisting}` | the only write |
| `/api/cart` | GET | — | `{cart}` | raw unwrapped `get_cart` payload |

There is **no checkout route and no route that accepts an image, OCR text, or
any free-form prescription content.** Keep it that way (§9.4).

### Error contract — the part a client must implement

| Status | Body | Client must |
|---|---|---|
| 403 | `{error:"enrollment is closed on this server", hint}` | ask the operator for a token |
| 429 | `{error:"too many enrollments from this address; try later"}` | wait, or paste a token |
| 401 | `{error:"invalid token"}` | forget the stored bearer token, re-enrol or re-prompt |
| 409 | `{error:"not connected", action:"call /api/auth/link"}` | show Connect |
| 409 | `{error:"swiggy session expired", action:"call /api/auth/link"}` | show Connect; the server already cleared that user's tokens |
| 409 | `{error:"cart belongs to a different delivery address", cartAddress, requestedAddress, existingItems[], hint}` | make the user choose; do not retry |
| 400 | `{error:"addressId required"}` / `{error:"q required"}` / `{error:"no selections supplied"}` | fix the request |
| 500 | `{error:"cart is not empty but no spinIds could be read…", hint, sampleItem}` | stop; the `FIELDS` map is wrong |

Any Swiggy error whose message matches `/401|419|unauthor/i` is converted to
the reconnect 409 and the user's tokens are dropped
(`handleErr`, `src/server.js:74`) [VERIFIED]. That regex is a substring test on
an error *message*, so an unrelated message containing "401" would also force a
reconnect — annoying, not dangerous.

### `/api/search` row shape [VERIFIED against `src/server.js:173-196`]

```jsonc
{ "product", "brand", "size", "price", "mrp", "unitPrice",
  "inStock", "maxQuantity", "rating", "spinId", "skuId", "isSimilar" }
```

Identical field names to `catalog.json` rows minus `matchedQueries` — because
`bulk-search.sh` built the catalogue by merging exactly these rows (§8).

### `/api/cart/preview` option shape [VERIFIED against `src/matcher.js:61-77,136-143`]

```jsonc
{ "searchRank", "isSimilar", "spinId", "skuId", "label", "productName",
  "brand", "sizeText", "size", "packs", "price", "mrp", "maxQuantity",
  "rating", "imageUrl",
  // added by capped() — see the defect note in §11
  "requestedQuantity", "quantity", "quantityCapped" }
```

`label` is `"<displayName> — <quantityDescription>"`. `quantity` is already
clamped to that variant's `maxQuantity`; `quantityCapped` says it happened.

---

## 5. Auth and the multi-user model

Two token systems, easy to confuse:

1. **Personal bearer token** — issued by you with `npm run add-user <id>`,
   printed once, stored only as SHA-256 (`crypto.hashToken`). Identifies a user
   to *this backend*. Revocation is `--remove <id>`, instant.
2. **Swiggy OAuth tokens** — obtained per user through the browser flow, stored
   AES-256-GCM-encrypted under that user's record. Identify the user to
   *Swiggy*.

`ENCRYPTION_KEY` (64 hex chars) does double duty: AES key for tokens at rest
**and** HMAC secret for the OAuth `state` [VERIFIED, `swiggyOAuthProvider.js:12`].
Lose it and every user must reconnect; rotate it and the same is true.

### The flow

```
app: GET /api/auth/link  (bearer)
   → SwiggyOAuthProvider(userKey).state() = base64url(userKey.nonce) + "." + HMAC
   → SDK auth() returns "REDIRECT"; the provider captures the URL instead of
     opening it (redirectToAuthorization stores, does not navigate)
   → {url}
user: opens url, Swiggy phone + OTP
Swiggy: GET {PUBLIC_BASE_URL}/swiggy/auth/callback?code=…&state=…
   → verifyState(state) → userKey or null (timing-safe compare)
   → completeAuthFlow(userKey, code) → tokens encrypted into users.json
```

The signed `state` is what makes this multi-user: it is simultaneously the CSRF
defence the SDK expects and the only thing tying an incoming authorization code
to a person. A tampered or forged state is rejected with a 400 [VERIFIED code
path; the repo README claims this was tested — [UNVERIFIED] here].

The OAuth **Dynamic Client Registration result is per application, shared
across users** (`store.getClientInformation`) — one `client_id` for the whole
backend. `data/users.json` currently holds a real DCR record with
`client_id`, `client_id_issued_at`, `redirect_uris` [VERIFIED].

### Session lifetime [UNVERIFIED — from the repo READMEs and Swiggy's docs]

Swiggy access tokens last ~5 days and v1 issues **no refresh token**, so each
person re-runs the browser authorization roughly weekly. The underlying Swiggy
session lasts ~30 days idle, so the re-auth is usually silent — no OTP again.
Any client must treat 401/419 as "re-authorize", never as a permanent failure.

### MCP session handling

`instamartClient.js` keeps **one live MCP client per user** in a module-level
`Map`, reused across requests, with a single transparent reconnect-and-retry
when the transport dies (`/Streamable HTTP|POSTing to endpoint|session|closed|
ECONNRESET|socket hang up/i`). The header explains why: the previous version
opened a new transport per call and never closed it, so a 30-term bulk crawl
opened 100+ sessions and Swiggy started refusing them [VERIFIED as the code's
own stated rationale]. If you add concurrency, do not undo this.

---

## 6. The Swiggy MCP layer

Server URL: `https://mcp.swiggy.com/im` (`instamartClient.js:17`).

**Tool names and arguments are confirmed** from a real `discover-tools` run
[per repo README; [UNVERIFIED] here — re-run `npm run discover-tools <token>`
to re-confirm]:

`get_addresses`, `create_address`, `delete_address`, `search_products`,
`your_go_to_items`, `get_cart`, `update_cart`, `clear_cart`, `checkout`,
`get_orders`, `track_order`, `get_delivery_status`, `report_error`,
`get_payment_options`, `check_payment_status`, `confirm_order`.

This backend calls exactly four of them: `get_addresses`, `search_products`,
`get_cart`, `update_cart` [VERIFIED by grep of `src/`]. The order-placing and
payment tools are reachable through the SDK but nothing in this repo invokes
them.

### Result unwrapping — `unwrap.js`, and why its order matters

Verified against real responses, per the file header:

- Success: `structuredContent` holds the payload **directly** (e.g.
  `{addresses, pagination, resolution}`) — no `{success, data}` wrapper.
- Failure: `isError: true` **and** `structuredContent.success === false` with
  `{error:{message, reportId}}`.
- `content` may carry **multiple** text blocks — `get_cart` returns prose
  first and JSON second, so "first text block" is not a safe extraction.

The failure check runs **before** returning `structuredContent`; invert that
and an error payload is handed to the caller as if it were data.

### Real response shapes [VERIFIED from `shapes.json`]

`get_addresses` →
```jsonc
{ "addresses": [ { "id", "addressLine", "phoneNumber",
                   "addressCategory", "addressTag" } ],
  "total", "pagination": {page,pageSize,total,totalPages,hasMore},
  "resolution": { "resolutionSource", "needsUserClarification",
                  "candidateAddressIds", "defaultAddressId", "scoreUsed" },
  "imWidgetV2Eligible" }
```

`search_products {addressId, query}` →
```jsonc
{ "nextOffset": "1",
  "products": [ { "displayName", "brand", "inStock", "isAvail", "productId",
                  "parentProductId", "isPromoted", "badges": [...],
                  "variations": [ {
                     "spinId": "7H9RRSKI76",
                     "skuId": "VP38IK9ZZS",
                     "quantityDescription": "500 ml x 3",
                     "displayName", "brandName",
                     "price": { "mrp": 90, "offerPrice": 90,
                                "unitLevelPrice": "6/100 ml" },
                     "isInStockAndAvailable": true,
                     "imageUrl", "rating": {value,count},
                     "sla": {value:"5",unit:"MINS"}, "vegClassifier",
                     "maxQuantity": 2, "maxQuantityMessage"
                  } ] } ] }
```

`get_cart` → `{ cartTotalAmount, items[], billBreakdown:{lineItems,toPay},
cartAbsent }`, with `items[] = {spinId, skuId, productId, itemName,
itemVariant, quantity, storeId, maxQuantity, …}` [the per-item names are
asserted CONFIRMED in `src/server.js:32-34` against a real non-empty cart;
the capture in `shapes.json` was taken with an **empty** cart, so this file
cannot re-verify them — [UNVERIFIED] here].

**`similarProducts` does not appear anywhere in `shapes.json`** (0 occurrences)
[VERIFIED]. `server.js` and `matcher.js` both read it, and `matcher.js`'s
header reports a real response for "Amul Taaza Toned Milk 1 ltr" with 3
`products` and 18 `similarProducts` [UNVERIFIED here]. Both readers use `?? []`,
so its absence is harmless — but do not assume it is always present.

### The `FIELDS` map — the one place field names live

`src/server.js:17-44` maps every response field name used anywhere in the HTTP
layer. It exists because tool *names* were confirmed by discovery while
response *field names* had to be read off real JSON. Notes captured there and
worth keeping:

- variants nest under `variations` (not `variants`), titled `displayName`
  (not `name`);
- `suggestedAddressId` lives at `resolution.defaultAddressId`, and reading it
  from the top level is what made the first inspect run pass no `addressId`;
- `get_addresses` ids look like `abc123__XYZ` while `get_cart` reports only the
  `abc123` prefix — hence `addressPrefix()` at `src/server.js:47`.

Symptom of a wrong `FIELDS` entry: every preview returns `no_match` with null
ids. Fix by re-running `npm run inspect-shapes <token> "milk"`.

---

## 7. The backend matcher (`src/matcher.js`) — and why it is not the OCR matcher

Pure, 227 lines, no I/O. Input: one parsed item + the two result arrays.
Output: `{status: "matched"|"ambiguous"|"no_match", item, options[]}`,
`MAX_OPTIONS = 6`.

Its header records the measurement that killed the original design: for a real
`search_products "milk"`, **zero of 20 products** had a `displayName` equal to
`"milk"` — the catalogue is entirely branded. Strict equality matched nothing,
ever; substring gave 19 products / 36 variants, which no one picks from. So the
safety property moved: **nothing is auto-added unless the request identifies
exactly one variant on its own terms.**

Pipeline:

1. `flatten()` — one candidate per variant, **dropping `isInStockAndAvailable
   === false`** and anything without a `spinId` (update_cart requires it).
   `quantityDescription` is split into `size` + `packs` ("500 ml x 3" → 500 ml,
   3 packs).
2. Relevance floor — `relevance() > 0`, i.e. at least one query word appears in
   `productName + brand`. Without it, asking for "chocolate" and being offered
   six milks looks confident and is wrong.
3. `score()` = relevance×40, +35 exact brand, +30 exact size, −12 multipack,
   −0.15×searchRank, −10 if from `similarProducts`. Tiebreak is Swiggy's own
   relevance order, **not price** — cheapest-first was pushing odd items up.
4. Auto-resolve tiers:
   - **T1** query equals a catalogue title (or title+size) and exactly one
     variant survives size/single-pack narrowing → `matched`;
   - **T2** exactly one candidate contains *every* query word → `matched`
     ("Crocin Advance" is complete only in "Crocin Advance Paracetamol 500mg
     Tablet");
   - **T3** brand **and** size both given and exactly one in-stock variant fits
     → `matched`;
   - a single overall candidate → `matched`; otherwise `ambiguous`.
5. `capped()` clamps the requested quantity to the variant's `maxQuantity` and
   reports `quantityCapped`. Swiggy's cap varies between variants of the *same*
   product (a "1 ltr x 6" capped at 1 while plain "1 ltr" allowed 20), and
   exceeding it is rejected at `update_cart`.

**This matcher cannot do the OCR app's job** and vice versa — see §9.3.

### `groqParser.js`

`openai/gpt-oss-20b` by default (override `GROQ_MODEL`), `temperature: 0`,
`response_format: json_object`, `include_reasoning: false`,
`reasoning_effort: "low"`. Returns `[{query, name, brand, quantity, unit}]`.

`query` is the load-bearing field: the *verbatim* product description, because
searching "paracetamol" for "crocin advance paracetamol 500mg" returns every
brand and loses the user's intent (`src/server.js:219-221`). `quantity` means
*how many to buy*, never pack size. Markdown fences are stripped defensively
even though JSON mode is requested.

---

## 8. `catalog.json` — the join between the two repos

**Both repos ship the identical file** [VERIFIED by md5sum:
`523dbd37d7d57c4d2d13929a18e6c5ab` for both
## 14. Open questions for the human before integration starts

1. **Design A or B (§9.2.3)?** Offline catalogue versus live re-validation.
   This decides whether `catalog.json`'s staleness is an accepted limit or a
   bug.
2. **Who re-runs `bulk-search.sh`, and how fresh must the catalogue be?** Both
   repos hold the same bytes with no sync mechanism, and the snapshot is
   per-store and per-day.
3. **One hardcoded delivery address, or does the user pick?** The backend
   refuses to merge a cart across addresses, so this is a real branch in the
   UI, not a detail.
4. **Is prescription-derived data going near a third-party grocery account
   acceptable at all here, and under whose authorization?** (§9.4)
5. **Does the backend get a public HTTPS origin before this ships?**
   `PUBLIC_BASE_URL` is currently local-only in `.env`, and the OAuth redirect
   is built from it.
{ "queriesRun": 10, "carriedOver": 1004, "count": 1227,
  "direct": 848, "similar": 379, "inStock": 1197,
  "fetchedAt": "2026-09-16T07:27:08.726Z", "note": "Sample from keyword…",
  "results": [ { "product","brand","size","price","mrp","unitPrice","inStock",
                 "maxQuantity","rating","spinId","skuId","isSimilar",
                 "matchedQueries" } ] }
```

Measured properties of this snapshot [VERIFIED this session]:

- 1227 records; **0 missing `spinId`, 0 missing `skuId`**;
- 1227 unique `spinId`, 1227 unique `skuId`, **0 `skuId`→`spinId` conflicts** →
  the mapping is 1:1 *in this file*. That is a property of the snapshot, **not
  a Swiggy invariant**. Re-check after every `--append`.
- 1197 in stock; **78 records have `maxQuantity: null`** — a client that
  clamps on `maxQuantity` must treat null as "unknown", not as 0.

Three caveats that constrain the whole integration:

1. **It is a sample, not a catalogue.** Swiggy's MCP exposes no browse or
   category tool — only keyword search, capped at roughly 40–50 results per
   query [per `queries.txt`'s own comment]. You only find what your seed terms
   surface, and you cannot tell what you missed. `bulk-search.sh`'s written
   note says exactly this.
2. **It is per-store.** Which products exist, their prices and their stock all
   depend on the delivery address the crawl ran against
   (`backend/.address-id`, present locally [VERIFIED]). A user ordering to a
   different address may see different results.
3. **It is a point-in-time snapshot** (`fetchedAt` 2026-09-16). `inStock`,
   `price` and `maxQuantity` go stale, and the OCR app's matcher rejects
   `!inStock` listings — so a stale file both offers sold-out items and hides
   restocked ones.

Refreshing it: `./bulk-search.sh queries.txt --out catalog.json` (or
`more-meds.txt --append` to fold new terms in without losing what you have;
existing records are refreshed and `matchedQueries` unioned). `QUERY_DELAY=2`
between terms, 3 retries with doubling backoff, and it **stops after 3 failures
rather than hammering a broken connection** [VERIFIED]. Then copy the file into
`rx-ocr-expo/app/src/match/catalog.json` and re-run that app's verify script.

---

## 9. Integrating with `rx-ocr-expo`

**Status: implemented on the OCR side; this backend is unchanged and needs no change.**
No route was added, and none should be. The client does the whole job with `/api/status`,
`/api/auth/link`, `/api/addresses` and `/api/cart/confirm`. `/api/cart/preview` is
deliberately never called, so no prescription-derived text reaches Groq.
See `rx-ocr-expo/about.md` §7.3 for what was built. The live path has not been exercised
end to end against a real Swiggy session — that remains the open gate.

The analysis below stands as the map of both sides. What follows is the map of both sides
plus the specific mismatches to resolve *before* writing code. The OCR side has
a mirror of this section in `/home/k6814/Downloads/rx-ocr-expo/CLAUDE.md` §7 —
the two were written to agree; if they diverge, the code wins.

### 9.1 What the OCR app produces

`SpottedMedicine[]` (`rx-ocr-expo/app/src/match/spot.ts`), one per medicine
spotted on the prescription:

```ts
type SpottedMedicine = {
  prescribed: string;   // reconstructed, e.g. "clavam ds (ped)"
  decision: 'MATCH' | 'CONFIRM' | 'ASK_USER' | 'NOT_IN_CATALOGUE';
  product: string | null;   // catalogue title of the chosen listing
  skuId: string | null;     // chosen listing's skuId
  reason: string;           // why CONFIRM, or why nothing matched
  ocrText: string;          // the OCR row it came from  ← NEVER SEND THIS
  spotScore: number;        // 0..1 brand-name similarity
  options: { product: string; skuId: string }[];
};
```

Decision → cart behaviour: `MATCH` safe to pre-tick; `CONFIRM` show `reason`
and require a tap; `ASK_USER` force a choice from `options`; and
`NOT_IN_CATALOGUE` is a **valid answer** — that matcher never substitutes.

### 9.2 The five concrete mismatches

**(1) `spinId` is missing on the OCR side; `update_cart` requires it. — FIXED on the OCR
side**, by carrying `res.chosen.listing.raw.spinId` through to `SpottedMedicine` and
`options[]`, not by a lookup table.
`SpottedMedicine` carries `skuId` only, and both `matcher.js:80`
(`flatten` filters on `spinId`) and `/api/cart/confirm`
(`server.js:257`, `.filter(i => i.spinId)`) drop anything without one
[VERIFIED both sides]. *Fix on the OCR side*: add `spinId` to
`SpottedMedicine` and to `options[]` — the value is already in hand there as
`res.chosen.listing.raw.spinId`. Prefer that to a `skuId → spinId` lookup,
which works only because this snapshot happens to be 1:1 (§8).

**(2) Quantity does not exist anywhere in the OCR output.** `spot.ts`
deliberately does not read doses ("lite OCR mangles them"). The cart needs a
number per item. It must come from the user on a confirm screen, clamped to
`maxQuantity` — and note the live `/api/search` row is authoritative over the
snapshot's `maxQuantity`, 78 of which are null anyway.

**(3) Two matchers with incompatible vocabularies — do not stack them.**

| | OCR app (`src/match/`) | This backend (`src/matcher.js`) |
|---|---|---|
| Input | OCR lines, handwriting | Groq-parsed shopping text |
| Corpus | frozen `catalog.json` | live `search_products` |
| Outcomes | MATCH / CONFIRM / ASK_USER / NOT_IN_CATALOGUE | matched / ambiguous / no_match |
| Discipline | brand fuzzy, variant+form+audience **exact**, never substitutes | ranked score, auto-resolves only when one variant survives |

**Do not route OCR output through `/api/cart/preview`.** That endpoint sends
free text to Groq, which would re-parse an already-structured result, discard
the prescription-specific discipline, and ship handwriting-derived text to a
third party.

Two defensible designs:

- **A — offline catalogue is the source of truth.** Send the spotted
  `{spinId, skuId, quantity}` straight to `/api/cart/confirm`. Simplest;
  preserves the prescription matcher entirely; inherits every staleness problem
  in §8.
- **B — re-validate live.** For each `MATCH`/`CONFIRM`, call
  `GET /api/search?q=<chosen product title>&addressId=…`, then confirm against
  a fresh row. One extra search per medicine plus a round of UI, but real stock,
  real price, right store. **Recommended for any real order.**

Either way the offline matcher stays where it is: it is what turns handwriting
into a product, and this backend's matcher cannot do that job.

**(4) The OCR app's `preview` EAS profile has no INTERNET permission.**
`app.config.js` pushes `android.permission.INTERNET` onto `blockedPermissions`
when `EAS_BUILD_PROFILE === 'preview'`. An integrated build needs a **new,
separately-named profile**; do not delete the block from `preview`, or the
offline test build stops being provably offline.

**(5) Client plumbing already exists here — port it, don't rewrite it.**
`instamart_app/mobile/api.js` (47 lines) + `config.js` (7 lines) are a
complete, working thin client: token in `expo-secure-store`, bearer header on
every call, `e.status`/`e.action` surfaced so callers can branch on 401 and 409.
`mobile/App.js` is the reference UI for the whole flow (token paste → connect →
address pick → preview → per-item selection → confirm → show cart) and is worth
reading before designing `CartScreen`.

### 9.3 Smallest honest integration

1. In the OCR app: `npx expo install expo-secure-store`; put `BASE_URL` in
   `app.config.js` `extra` (it differs per build — not a module constant).
2. Port `mobile/api.js` → `app/src/swiggy/api.ts`, typed.
3. Add `spinId` to `SpottedMedicine` and `options[]` (§9.2.1). The OCR app's
   `tools/fixtures/match_ref.json` compares `sku` only, so `npm run verify`
   will keep passing — that is a gap in the check, not evidence of safety.
4. New EAS profile (e.g. `cart`) with internet allowed; leave `preview` blocked.
5. New `Step` in `App.tsx` — `'cart'`, after `'result'`. All state already
   lives there, so this is additive.
6. `CartScreen`: token paste → `/api/status` → `/api/auth/link` if not
   connected → `/api/addresses` (let the user pick; the backend refuses to
   merge a cart across addresses) → quantity per medicine → resolve `ASK_USER`
   from `options` → `/api/cart/confirm`.
7. Handle `409 {action}` everywhere by dropping back to Connect.

Nothing needs to change in this backend for design A or B. If you are tempted
to add a route, the honest question first is whether the client can do it with
`/api/search` + `/api/cart/confirm` — it can.

### 9.4 Privacy and legal boundaries this integration crosses

- **Send product identifiers and quantities only.** Never the photo, never the
  OCR lines, never `ocrText` or `prescribed`. This backend has no route that
  accepts them and should not get one. In particular `/api/cart/preview` is
  the wrong door precisely because it forwards text to Groq.
- The OCR app's README currently claims nothing leaves the phone. A networked
  profile makes that false for that build; update it there.
- Per `instamart_app/README.md`: distributing this to end users makes you a
  **platform operator** under Swiggy's delegated-auth contract — production
  access is whitelist-only, redirect URIs are agreed at onboarding, and Swiggy
  remains data fiduciary under DPDP 2023. Apply at
  `https://mcp.swiggy.com/builders/access/` before going past a handful of
  friends. Prescription data raises the stakes further; that is a question for
  a human, not a code change.
- You are holding other people's grocery account sessions. Treat the server and
  `ENCRYPTION_KEY` accordingly: HTTPS is mandatory the moment anyone but you
  uses it, and Swiggy requires exact-match HTTPS redirect URIs anyway.

---

## 10. Running it

### Backend, first time

```bash
cd instamart_app/backend
./setup.sh                 # deps → .env → server → user → Swiggy connect →
                           # address pick → shapes.json dump
```

`setup.sh` is safe to re-run and **reuses `.user-token`** rather than creating
a new user — creating a new user is what silently loses your Swiggy connection,
since tokens are stored per user. It generates `ENCRYPTION_KEY` only if absent
or malformed, never regenerates an existing one (that would make every stored
token undecryptable) [VERIFIED].

Manual equivalent:

```bash
npm install
cp .env.example .env       # GROQ_API_KEY, ENCRYPTION_KEY=$(openssl rand -hex 32), PUBLIC_BASE_URL
npm start                  # :3000
npm run add-user kevin     # prints their token ONCE
```

### Day to day

```bash
./add.sh "amul taaza toned milk 1 ltr and a dozen eggs"   # NL → preview → confirm
./search.sh "paracetamol" --all                            # read-only, paginated
./search.sh "paracetamol" --all --out meds.json
./bulk-search.sh queries.txt --out catalog.json --append
npm run discover-tools <token>         # every MCP tool + schema
npm run inspect-shapes <token> "milk"  # real response JSON → fix FIELDS
npm run add-user -- --list
npm run add-user -- --remove kevin     # instant revocation
```

`add.sh`, `search.sh` and `bulk-search.sh` all start the backend themselves if
it is not already up and kill only what they started. `bulk-search.sh` starts it
**once for the whole run** and resolves the delivery address **before** the loop,
because `search.sh`'s prompt would otherwise vanish into a redirected log
[VERIFIED — both are commented as fixes for exactly that]. Several bash-3.2
compatibility workarounds in `add.sh` (no `mapfile`, `${arr[@]+"${arr[@]}"}`)
are deliberate; macOS still ships bash 3.2.

### Mobile reference client

```bash
npx create-expo-app instamart-mobile --template blank   # --template blank is required
cd instamart-mobile && npx expo install expo-secure-store
cp ../mobile/App.js ../mobile/api.js ../mobile/config.js .
# set BASE_URL in config.js to the backend's HTTPS origin
npm start
```

### `instamart_agent/` (Python, superseded)

```bash
pip install -r instamart_agent/requirements.txt
export GROQ_API_KEY=gsk_...
sudo python discover_tools.py     # sudo: CALLBACK_PORT defaults to 80
python main.py "add 2 liters of milk"
```

`main.py` exits immediately unless you first fill `SEARCH_TOOL_NAME` /
`SEARCH_QUERY_ARG` from discovery output [VERIFIED]. The port-80 issue is real
and external: Swiggy's consumer manifest whitelists `http://localhost/callback`
with no port, and exact-string redirect matching then forces a privileged bind.
The Node backend sidesteps this entirely by using `PUBLIC_BASE_URL`.

---

## 11. Invariants that must not break

- **`update_cart` REPLACES the entire cart.** `/api/cart/confirm` does
  read-merge-write. Remove the merge and adding one item deletes everything
  else. This is the single most destructive mistake available in this repo.
- **`/api/cart/confirm` refuses rather than risks the cart**, in two distinct
  ways: a non-empty cart from which no `spinId` could be read → 500 with the
  sample item (wrong `FIELDS` would otherwise wipe it); a cart bound to a
  different delivery address → 409 listing the existing items (moving a cart
  between stores can silently drop or revalue items).
- **`spinId` is mandatory** for anything entering a cart; `skuId` is optional
  and omitted from the payload when absent (`server.js:295-298`).
- **Quantities are clamped to `maxQuantity`**, per variant, before they reach
  Swiggy — the cap differs between variants of the same product.
- **No implementation type crosses a stage boundary**: no MCP SDK objects out of
  `instamartClient`, no Groq SDK types out of `groqParser`, no raw Swiggy JSON
  out of `server.js` except the deliberate `/api/cart` passthrough. `matcher.js`
  stays pure.
- **One MCP session per user, reused.** Not one per call.
- **Nothing secret in the app bundle** — only `BASE_URL`. Each user pastes their
  own bearer token into the device keychain. APKs decompile trivially.
- **Out-of-stock and spinId-less variants are never offered** (`flatten`).
- **The relevance floor stays.** Dropping it makes unrelated stock look like a
  confident answer.
- **No checkout route.** Adding one is a decision for a human, not a
  refactor — and per the READMEs, Instamart orders are cancelled by phoning
  080-67466729, not through any tool, so a mistaken order is not undoable in
  software.

---

## 12. Known gaps, defects and limitations

**Defect — `ambiguous` options from the tier-1 branch carry no quantity.**
`src/matcher.js:188` returns `options: exact.slice(0, MAX_OPTIONS)` without
`capped()`, while the other ambiguous return (line 226) applies it [VERIFIED].
So for the "right product, undecided size" case, options lack `quantity`,
`requestedQuantity` and `quantityCapped`. A client doing
`{quantity: o.quantity}` (as `mobile/App.js:82` does) sends `undefined`, JSON
drops the key, and `/api/cart/confirm` falls back to `Number(s.quantity ?? 1)`
= 1. It fails quiet and small — the user silently gets one unit — but it is
inconsistent, and any new client will hit it. Fix is `capped(exact.slice(0,
MAX_OPTIONS), item)`.

**`codeVerifier` is never cleared after a successful authorization.** It is
written by `store.setCodeVerifier` during the flow and stays in
`data/users.json` afterwards — the connected user's record still has the field
[VERIFIED]. Harmless (it is single-use and useless without the matching
authorization code) but it is transient state persisted past its lifetime,
which is exactly what `crypto.js`'s header says not to do with credentials.

**`data/users.json` is last-write-wins.** `store.js` says so in its header: a
JSON file is fine for a handful of known people; concurrent writes can lose an
update. Two users connecting at the same instant is the realistic trigger.
Past a handful of people, move to a real database.

**Per-item `get_cart` field names are asserted but not re-verifiable here.**
`shapes.json` was captured against an empty cart, so the `cartItem*` entries in
`FIELDS` rest on a claim in a code comment. Re-run `inspect-shapes` with
something in the cart before trusting the merge path with a full cart.

**The live Swiggy path is unexercised in this session.** No tool call was made
here. `server.log` shows the backend has run and one user is connected, but
every claim about what Swiggy returns *today* — tool list, token lifetime,
rate limits — is [UNVERIFIED] as of now.

**Rate limits are guessed.** `search.sh` uses `PAGE_DELAY=0.6` and
`bulk-search.sh` `QUERY_DELAY=2`, both annotated "Swiggy's planned ceiling is
120 req/min". "Planned" is doing a lot of work in that sentence.

**Search depth is capped and there is no browse tool**, so `catalog.json` can
never be complete (§8).

**`handleErr`'s `/401|419|unauthor/i` test matches error *text*,** not a status
code, so an unrelated message containing those digits forces a spurious
reconnect.

**`instamart_agent/` is dead weight** — non-runnable as shipped, with
placeholder field names (`PRODUCT_TITLE_FIELD = "name"`) that the Node side has
since proven wrong (`displayName`). Keep it only for the OAuth notes; do not
port anything from it.

---

## 13. Conventions worth preserving

- **[VERIFIED] vs [UNVERIFIED].** Measured facts are not re-litigated;
  assertions are labelled and re-checked before being relied on. This file
  follows the rule in its own header.
- **Fail loudly and specifically.** The refusals in `/api/cart/confirm` name
  the wrong config field and include a sample item; `unwrap` surfaces Swiggy's
  `reportId`; `discover-tools`/`inspect-shapes` exist so a human can correct
  the `FIELDS` map from real JSON instead of guessing. A bare traceback is not
  acceptable here.
- **Never guess a tool name or a field name.** The Python prototype exits
  rather than invent one, and `FIELDS` carries a comment per entry saying how
  it was confirmed. A guessed argument that happens to be accepted by a
  different tool does the wrong thing to a real cart.
- **Read-only by default, one write, clearly marked.** `/api/search` and
  `/api/cart/preview` write nothing, and every shell script ends by saying
  "Nothing was added to your cart."
- **Automate building the cart, never spending the money.**
- **Comments record the measurement, not the intention.** "ZERO of 20 products
  have a displayName equal to milk", "385 unusable candidates", "the cart was
  EMPTY when captured" — that is why the code looks the way it does. Keep
  writing them that way.

---
