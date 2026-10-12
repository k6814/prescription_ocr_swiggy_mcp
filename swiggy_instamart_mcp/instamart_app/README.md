# Instamart NL Cart -- backend + mobile (multi-user)

Express backend holds all credentials and does OAuth, Groq parsing, and MCP
calls. The app is a thin client. **Each person connects their own Swiggy
account; nobody can see or touch anyone else's.**

## If you're sharing this with friends, read this first

The earlier single-user version had a serious defect: one token file meant
the second person to connect silently overwrote the first, and everyone
afterwards drove *that* person's Swiggy account -- their cart, their saved
addresses, their phone number. This version fixes it. Do not go back to a
shared token store.

What's now in place:

- **Per-user Swiggy tokens**, encrypted at rest with AES-256-GCM
  (`ENCRYPTION_KEY`). Verified: two users' tokens coexist, reconnecting one
  doesn't disturb the other, and no plaintext token appears in `data/users.json`.
- **Per-user bearer tokens** you issue by hand. Only their SHA-256 is stored.
- **Signed OAuth `state`** carrying the user id, HMAC'd with the same secret,
  so the callback attributes each authorization code to the right person.
  Verified: tampered and forged state are rejected.
- **Nothing secret in the APK.** Only `BASE_URL` is compiled in; each user
  pastes their own token on first launch and it goes to the device keychain
  via `expo-secure-store`.

What this is still NOT: a public product. Per Swiggy's
[delegated auth contract](https://mcp.swiggy.com/builders/docs/start/enterprise/delegated-auth/),
distributing to end users makes you a platform operator -- production access
is whitelist-only, redirect URIs are agreed at onboarding, and Swiggy remains
the data fiduciary under DPDP 2023. For a handful of friends on a backend you
run, apply at https://mcp.swiggy.com/builders/access/ before going beyond
that. Also: you're holding other people's grocery account sessions. Treat the
server and the `ENCRYPTION_KEY` accordingly.

## Deploy

HTTPS is mandatory once anyone but you uses it -- their Swiggy tokens cross
that connection, and Swiggy requires exact-match HTTPS redirect URIs anyway.
Cheapest sane setup: a small VPS with Caddy in front for automatic TLS, or a
tunnel (Cloudflare Tunnel / ngrok) for testing. Set `PUBLIC_BASE_URL` to that
HTTPS origin.

```bash
cd backend
npm install
cp .env.example .env
openssl rand -hex 32        # paste into ENCRYPTION_KEY
# set GROQ_API_KEY and PUBLIC_BASE_URL too
npm start
```

Back up `ENCRYPTION_KEY`. Lose it and every user must reconnect.

## Issue tokens to people

```bash
npm run add-user kevin      # prints their token ONCE -- send privately
npm run add-user -- --list
npm run add-user -- --remove kevin   # instant revocation
```

Only the hash is stored, so a lost token can't be recovered -- remove and
re-add.

## Fill in the response field names

Tool names and arguments are confirmed from a real `discover-tools` run.
Response *field names* are not. After one person has connected:

```bash
npm run inspect-shapes <their-token> "milk"
```

Correct the `FIELDS` block at the top of `src/server.js` from the real JSON.
Symptom of leaving it wrong: every preview returns `no_match` with null ids.

## Mobile

```bash
npx create-expo-app instamart-mobile --template blank
cd instamart-mobile
npx expo install expo-secure-store
cp ../mobile/App.js ../mobile/api.js ../mobile/config.js .
npm start
```

`--template blank` is required -- plain `create-expo-app` scaffolds an Expo
Router / TypeScript project with no root `App.js`.

Set `BASE_URL` in `config.js` to your backend's HTTPS origin. That's the only
thing baked into the build. To share as an APK: `eas build -p android --profile preview`.

Each friend: install, paste their token, tap "Connect my Swiggy account",
log in with their own phone + OTP, pick their address, go.

## Token expiry

Swiggy access tokens last 5 days and v1 issues no refresh token, so people
re-run the connect flow about weekly. The underlying Swiggy session lasts 30
days idle, so it's usually silent -- no OTP again. The backend detects 401/419,
clears that user's token, and returns `409 {action: "call /api/auth/link"}`;
the app shows "Connect" again.

## Confirmed Instamart tools

`get_addresses`, `create_address`, `delete_address`, `search_products`,
`your_go_to_items`, `get_cart`, `update_cart`, `clear_cart`, `checkout`,
`get_orders`, `track_order`, `get_delivery_status`, `report_error`,
`get_payment_options`, `check_payment_status`, `confirm_order`.

Facts worth keeping straight (these correct the consumer README):
UPI is supported, not COD-only. Instamart has **no** cart-value cap -- the
₹1000 limit is a Food-server rule. Orders are cancelled by phoning Swiggy on
080-67466729, not through any tool.

**`update_cart` replaces the entire cart.** `/api/cart/confirm` reads the
current cart and writes the merged union. Keep that if you refactor, or
adding one item will delete everything else.

**No checkout route, deliberately.** Building a cart from text is a
reasonable thing to automate on someone's behalf. Spending their money is
not -- leave that as a tap in Swiggy's own app.
