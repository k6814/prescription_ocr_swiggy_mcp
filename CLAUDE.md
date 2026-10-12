# CLAUDE.md — med_ocr_swiggy_mcp (integration workspace)

This file governs **the integration only** and does not restate how either side
works. Read those first, as authoritative: `rx-ocr-expo/about.md` (architecture
§2–3, output contract §4, OCR internals §5, privacy §9, conventions §10) and
`swiggy_instamart_mcp/about.md` (HTTP contract §4, auth §5, MCP layer §6,
backend matcher §7, invariants §11, defects §12). Both carry a mirrored
integration section — `rx-ocr-expo` §7, `swiggy_instamart_mcp` §9 — written to
agree. **If they diverge: code wins, then this file, then those sections.**

**Status: built and run on a device.** Everything below is implemented in `rx-ocr-expo/app/`.
The backend gained **exactly one route**, `POST /enroll` (§8a) — a deliberate, discussed
exception to the rule below, taken because the client genuinely could not do it.

---

## 1. What we are building

One Android APK: photograph a prescription → crop → **on-device** OCR and
medicine matching → user reviews and approves → approved items go into the
user's real Swiggy Instamart cart via the existing backend. It never places an
order — preserve that (`swiggy_instamart_mcp/about.md` §11).

---

## 2. Decision: where the integrated app lives

**Extend `rx-ocr-expo/app/` in place.** It is the only React Native project
here, the one with the native ONNX Runtime + Skia chain, and it is under git.
`instamart_app/mobile/` is a 3-file reference client, not a second app — port
from it, do not run it. The backend stays a separate process. **Adding a backend route
needs a human's agreement first** — ask whether the client can do it with `/api/search` +
`/api/cart/confirm`. For the cart itself it can, and does. The one agreed exception is
`POST /enroll` (§8a): onboarding could not be fixed from the client, because the Swiggy
login endpoint was itself behind the token you were trying to avoid asking for.

---

## 3. Reuse map — what to take, from where

| Need | Take from | How |
|---|---|---|
| Camera / gallery / crop / rotate | `rx-ocr-expo/app/src/screens/*`, `src/image.ts` | reuse unchanged |
| OCR + matching | `src/ocr/pipeline.ts` → `readPrescription()` | reuse unchanged; it is the only entry point you need |
| Temp-file hygiene | `src/privacy.ts` | reuse; every new image op goes through `withTempImage` |
| HTTP client + token storage | `instamart_app/mobile/api.js` (47 L) + `config.js` | **port to TypeScript**, do not rewrite |
| Cart flow reference UI | `instamart_app/mobile/App.js` | read before designing; do not copy its styling |
| Design tokens | `rx-ocr-expo/app/src/theme.ts`, `src/ui.tsx` | extend — this is the app's design system |

Do **not** create: a second OCR path, matcher, cropper or HTTP client, and do
not add a navigation or state-management library. `App.tsx` already owns all
state in a 4-step machine; the integration is additive to it.

---

## 4. The seam: what crosses between the two halves

Exactly one payload crosses: **product identifiers and quantities.**

```
SpottedMedicine[]  →  [review + approval UI]  →  { spinId, skuId, quantity }[]
                                                  → POST /api/cart/confirm
```

Nothing else. Never `ocrText`, never `prescribed`, never `lines`, never the
photo. The backend has no route that accepts them and must not get one.

Types to define here (derive from the real structures; no `any` at this seam):
`ApprovedItem {spinId, skuId|null, quantity}`, `ReviewItem {medicine,
selected, chosenOptionIndex, quantity}`, `CartOutcome {added,
preservedFromExisting}`, and a discriminated error type covering the kinds in
§8. `SpottedMedicine` lives in `src/match/spot.ts` — extend it, don't clone it.

---

## 5. The five mismatches — status and required action

Detailed in `rx-ocr-expo/about.md` §7.2 / `swiggy_instamart_mcp/about.md` §9.2.
What this project must do about each:

1. **`spinId` missing on the OCR side.** `update_cart` requires it and both
   `matcher.js:80` and `server.js:257` silently drop items without one.
   `CatalogItem` already carries `spinId?` (`matcher.ts:20`), so the value is
   in hand at `res.chosen.listing.raw.spinId` — **add `spinId` to
   `SpottedMedicine` and to `options[]`.** Do not build a `skuId → spinId`
   lookup: that works only because this snapshot is accidentally 1:1.
   Note `npm run verify` compares `sku` only, so it will keep passing — that is
   a gap in the check, not evidence the change is safe. Eyeball it.
2. **No quantity anywhere in the OCR output**, deliberately (`spot.ts` header:
   doses are not read). Quantity comes from the user on the review screen.
   Default 1; clamp to `maxQuantity`; **treat `maxQuantity: null` as unknown,
   not 0** (78 catalogue rows are null).
3. **Two matchers, incompatible vocabularies. Do not stack them.**
   **Never route OCR output through `/api/cart/preview`** — it forwards free
   text to Groq, discards the prescription matcher's exact-variant discipline,
   and ships handwriting-derived text to a third party.
4. **The `preview` EAS profile has no INTERNET permission** and that is a
   feature. Add a **new** profile; do not edit `preview`.
5. **No client plumbing in the OCR app.** Port `mobile/api.js`; add
   `expo-secure-store`; put `BASE_URL` in `app.config.js` `extra`, never a
   module constant.

---

## 6. Screen flow

`App.tsx`'s `Step` union is the navigation model. Target:

```
'intro' → 'pick' → 'camera' → 'crop' → 'review' → 'cart' → 'done'
```

- `'intro'` — onboarding, §10. Shown once per launch; no persistence.
- `'pick'` / `'camera'` / `'crop'` — existing screens, unchanged behaviour.
- `'review'` — **new.** Absorbs `ResultScreen`'s medicine section for the
  user-facing path. Its timings, box overlay, per-line list and raw-JSON dump
  are developer diagnostics: keep them, behind a disclosure.
- `'cart'` — **new.** Connect → address → confirm.
- `'done'` — outcome, with what was added and what was not.

Existing screens stay pure props-in/callbacks-out. All new state lives in
`App.tsx` alongside the existing state; ephemeral UI state stays local.

---

## 7. Review screen — the safety boundary

This is the screen that must not be rushed. Rules:

- **Nothing is added to a cart without an explicit tap.** OCR results are never
  cart operations by themselves.
- Render all four `decision` values distinctly, per the semantics table in
  `rx-ocr-expo/about.md` §4. Summary: `MATCH` pre-ticked; `CONFIRM` shows
  `reason` and requires a tap; `ASK_USER` forces a choice from `options`;
  `NOT_IN_CATALOGUE` is a **valid, correct answer** — the matcher never
  substitutes, so never quietly hide these.
- Also surface `OcrResult.warnings` (e.g. instruction text with no medicine
  above it) — that is the system telling you it may have missed a row.
- **Never imply the list is complete.** Persistent, calm copy near the top asks
  the user to compare the list against the prescription, because a medicine may
  not have been recognised. Not an alarm, and not a dismissible toast.
- **Cross-checking:** the cropped image is already in memory (`result.image`).
  Give a tap-to-expand prescription preview from the review screen — full-screen
  zoomable, dismissible, reusing the image already held. Do not write it to
  disk to achieve this.
- Never communicate decision state by colour alone; pair colour with a label
  (`theme.ts` already has `ok` / `mid` / `bad`).

---

## 8. Cart flow

Sequence, all through the ported client:

```
stored bearer token?  → no: POST /enroll  (public; §8a)
GET  /api/status      → connected?
GET  /api/auth/link   → open {url} in an auth session; it closes itself (phone + OTP)
GET  /api/addresses   → user picks; default to resolution.defaultAddressId
POST /api/cart/confirm { addressId, selections: ApprovedItem[] }
```

Non-negotiable client behaviours (see `swiggy_instamart_mcp/about.md` §4, §11):

- `401` → clear the stored token, offer set-up-again. `409 { action }` → drop back to
  Connect. `409 cart belongs to a different delivery address` → show the
  existing items and make the user choose; **do not retry**.
- **`/api/cart/confirm` is additive on repeat: merged quantities are summed**
  (`server.js`, merge loop). A double-tap therefore doubles the order. Disable
  the button on first press, guard with an in-flight ref, and do not offer a
  bare "retry" after an ambiguous failure — re-show what is in the cart first.
- **Every failure gets a recovery control, and a disabled primary button must say why it is
  disabled.** `recoveryAction(kind, during)` in `swiggy/types.ts` owns this: transport
  failures during setup offer "Try again"; a failed **write** never offers a retry, only
  "Check my cart". A connected session with no loadable addresses is its own screen, not a
  confirm panel with a dead button.
- Apply a request timeout and surface it as a distinct error; the round-trip
  goes through MCP and Swiggy and can be slow.
- **Swiggy sign-in runs as an auth session, not a trip to the browser.**
  `WebBrowser.openAuthSessionAsync(url, 'rxocr://connected')` opens an Android Custom Tab
  bound to the app's `scheme`; the backend's callback page navigates to that URL
  (`APP_RETURN_URL`), which dismisses the tab and resumes the app. An `AppState` listener
  re-checks status on foreground as a fallback, and "Check again" remains for the
  plain-browser path. **Do not replace this with an in-app WebView**: it would put this app
  between the user and Swiggy's password field, which is what OAuth exists to prevent, and
  providers block it. The three names must agree — `scheme` in `app.config.js`, `RETURN_URL`
  in `CartScreen.tsx`, `APP_RETURN_URL` on the backend.

### 8a. Enrollment — why the backend changed

The original design had the operator run `npm run add-user` and the user paste the printed
token. That is a bad first run, and it could not be fixed in the app: `app.use("/api", auth)`
guards **`/api/auth/link` too**, so the Swiggy OTP was unreachable without the very token you
were trying not to ask for.

`POST /enroll` inverts it. It is public, and the token it returns is **inert**: every route
that spends anything — `/api/search`, `/api/cart/preview` (Groq), `/api/cart`,
`/api/cart/confirm` — already sits behind `requireConnected`. An unclaimed token reaches only
`/api/status` and `/api/auth/link`, and the latter just opens Swiggy's own login page.
**That property is what makes open enrollment safe, so if you ever add a route that costs
money, CPU or a third-party call, put `requireConnected` on it.**

Accepted consequences, chosen knowingly:
- **Per-user revocation is weakened.** `add-user --remove` still deletes the record and its
  Swiggy tokens, but the same person may enrol again. To close the door set `ENROLL_DISABLED=1`.
- **Records accumulate.** Unconnected ones are pruned after `ENROLL_TTL_HOURS` (default 24);
  enrollment is throttled to `ENROLL_MAX_PER_HOUR` (default 10) per IP.
- Records created before enrollment existed have no `createdAt` and are **never** pruned.

The paste screen survives as the recovery path for a revoked token and for hand-issued ones.

**Open decision, and the only one that blocks design:** offline catalogue as
source of truth (A) vs live re-validation through `/api/search` before confirm
(B), per `swiggy_instamart_mcp/about.md` §9.2.3. **Default to A for Phase 1**
— it preserves the prescription matcher exactly and ships — but the catalogue
is a per-store, point-in-time sample (`fetchedAt` 2026-09-16), so A can offer a
sold-out item or miss a restocked one. Structure the cart service so B is a
change inside it, not across the UI. Confirm the choice with the human before
a real order is placed.

---

## 9. Build profiles and configuration

- Keep `preview` exactly as it is — INTERNET blocked, the provably-offline OCR
  test build. Deleting that block destroys a real guarantee. Add a new profile
  (suggest `cart`) in `eas.json` with `EAS_BUILD_PROFILE=cart` and internet
  allowed; `app.config.js` already branches on profile name, so extend it.
- `BASE_URL` goes in `app.config.js` `extra`, read via `expo-constants`. It
  differs per build.
- **Nothing secret ships in the APK.** Only `BASE_URL`; each user pastes their
  own bearer token into `expo-secure-store`. APKs decompile trivially — if you
  find yourself adding a key to the bundle, stop and say so.
- **Plain HTTP is allowed, deliberately.** The backend is deployed over HTTP, so
  `usesCleartextTraffic` is on for every internet-capable build (`HTTPS_ONLY=1` tightens it
  when the backend gets a certificate; `preview` refuses it outright, having no INTERNET at
  all). Recorded cost: the bearer token is sent on every request and can be read by anyone
  observing the connection, who could then drive that person's Swiggy cart. Prescription
  content is never on the wire — only `spinId`/`skuId`/`quantity` — so the exposure is the
  grocery account, not the prescription.
- **It must go through `expo-build-properties`.** Setting `android.usesCleartextTraffic` in
  `app.config.js` is **silently ignored** — nothing in the Expo config schema reads that key,
  and no prebuild plugin applies it. Only the `expo-build-properties` plugin writes the real
  manifest attribute. Verify any manifest-level change with
  `npx expo config --type introspect` and grep the result, rather than trusting that a
  plausible-looking config key does anything; a whole APK build is the alternative feedback
  loop.
- **The OAuth callback may still need HTTPS, and that is Swiggy's rule, not ours.** The
  backend's own `.env` records that Swiggy requires exact-match HTTPS redirect URIs, with
  `http://localhost` allowed for dev only. `PUBLIC_BASE_URL` builds that redirect, so an
  `http://` public origin may fail at the connect step even though every other call works.
- **Do not remove `tools/fix-onnxruntime.js`** from postinstall. See
  `rx-ocr-expo/about.md` §8.
- Expo Go is not a target. This app needs a development/preview build for the
  native ONNX Runtime. Do not sacrifice working ML for Expo Go compatibility.

---

## 10. Onboarding

Short, visual, skippable, no persistence (nothing is written to storage today
and that should stay true). Five points, in this order: take or upload a
prescription → it is processed on this phone → review what was detected →
approve what you want → the app adds it to your Swiggy Instamart cart.

State the Instamart dependency plainly: this needs a Swiggy account and a
connection step, and it builds a cart — it does not place an order.

Privacy copy may say **"prescription processing happens on your device"** —
that is true and verified. It may **not** claim nothing leaves the phone in a
networked build: product identifiers and quantities do. Update
`rx-ocr-expo/README.md`'s "no user data" table when the `cart` profile exists;
it is accurate today and would become false.

---

## 11. Design system

One design language across the whole app. `src/theme.ts` (light/dark tokens,
`band()`) and `src/ui.tsx` (`Panel`, `H2`, `Hint`, `Button`, `ErrorBox`,
`StepRail`) are the existing system — **extend these files** rather than
introducing a parallel styling approach.

Additions likely needed — status pill, list row, selection control, quantity
stepper, empty state, progress, modal sheet, full-screen image viewer — go in
`src/ui.tsx` with the same props-in/theme-in signature as the existing
components. `StepRail` is typed `step: 1 | 2 | 3` and needs widening.

Constraints: no new fonts, no gradients, no decorative animation, no absolute
positioning for layout. Flex + `maxWidth` as `App.tsx` already does. Test at
320 dp width and at 200% font scale; long medicine names must wrap, not
truncate into ambiguity. Minimum 44×44 touch targets. Accessibility labels and
roles on every control as it is written, not afterwards.

---

## 12. Processing and error UX

`readPrescription()` already reports real stages via `onStage`:
`'Loading model' | 'Preparing photo' | 'Finding and reading text' |
'Matching medicines'` (`src/ocr/pipeline.ts:6`). **Drive the progress UI from
those four values.** Do not invent percentages — there is no progress signal
behind them, only stage transitions.

Every failure path needs a named state and a recovery action: permission
denied, capture or crop cancelled, model load failure (`ModelStatus` already
carries `{state:'error', message}`), OCR failure, zero medicines detected, no
token, not connected, session expired, address conflict, network down, timeout,
cart write refused. Never an indefinite spinner; never a swallowed failure.

---

## 13. Privacy invariants the integration must not break

`rx-ocr-expo/about.md` §9 is the full verified table. The three this project is
most likely to break:

1. **Images stay in memory.** Base64 only; every disk touch goes through
   `withTempImage`, which deletes in a `finally`. The review screen's
   prescription preview must reuse the in-memory `Img`, not a saved file.
2. **`purgeTempImages()` runs on startup and on start-over.** Keep both calls.
3. **Only identifiers and quantities leave the device.** No photo, no OCR text,
   no analytics, no tracking SDK, no prescription content in production logs.

Screenshot blocking stays **off** by default (the toggle in `App.tsx` exists for
later). Do not implement screenshot protection in Phase 1, but do not build
anything that would make per-screen protection hard to add.

---

## 14. Verification

Done (`cd rx-ocr-expo/app`):

- `npm run typecheck` — clean.
- `npm run verify` — 24/24 matcher cases and all 3 prescriptions identical to Python, so the
  OCR path is unchanged by the `spinId` edit.
- `npm run verify:spin` — the gap `verify` cannot see: 9/9 chosen listings and 5/5 options
  resolve a `spinId`.
- `npm run verify:cart` — 29 checks: selection rules per decision, quantity clamping
  (including `maxQuantity: null` as unknown), the payload's exact key set, and every row of
  the backend's documented error contract mapped to a named recovery.
- Web bundle builds clean; intro renders; `extra.cartEnabled` correctly flips the copy and
  the step rail between the offline and networked builds; no horizontal overflow at 320 dp;
  dark theme applies; console clean.

Still open — needs hardware, a reachable backend and a Swiggy account:

- Full flow on a real device build: photo → crop → review → approve → cart.
- Every error branch in §12 reached deliberately once — kill the backend, revoke the token,
  use a stale session, use a cart bound to another address.
- Double-tap confirm; the cart must gain the intended quantity exactly once.
- Rebuild the offline `preview` APK and re-confirm it still has no INTERNET permission.

---

## 15. Questions for the human, not for code

1. Design A or B (§8)? This decides whether catalogue staleness is an accepted
   limit or a bug.
2. Who refreshes `catalog.json`, how often, and who copies it between the two
   repos? There is no sync mechanism; both hold identical bytes today.
3. ~~One fixed delivery address or a user picker?~~ **Settled: default + Change.** The
   suggested address (`resolution.defaultAddressId`) is preselected and shown as one line
   with a Change button; the full list appears only on request. It is not removed, because
   a real account here holds ten addresses across four cities and the backend refuses to
   merge a cart across them — a silent default can send medicines to the wrong city. The
   "Swiggy could not tell which address" notice now shows only when `needsUserClarification`
   is true and there is more than one address.
4. Is prescription-derived data going near a third-party grocery account
   acceptable here, and under whose authorization? Distributing this makes you
   a platform operator under Swiggy's delegated-auth contract (whitelist-only
   production access, DPDP 2023, `https://mcp.swiggy.com/builders/access/`).
   Prescription data raises it further.
5. Does the backend get a public HTTPS origin before this ships?