# Deploying the backend with Dokploy

What this does and does not change: the app on the phone keeps working exactly as it does
locally. What a public HTTPS origin buys you is the OAuth callback — Swiggy requires
**exact-match HTTPS** redirect URIs for anything that is not `localhost`, which is why the
local setup needs `adb reverse`. Dokploy fronts apps with Traefik and Let's Encrypt, so the
certificate is handled for you.

## 1. Create the application

Point Dokploy at this repository with **Build Type: Dockerfile** and
**Docker Context Path** `swiggy_instamart_mcp/instamart_app/backend`, or use
**Compose** with `docker-compose.yml` in that directory. Either way it listens on **3000**.

## 2. Add a persistent volume — do not skip this

| Mount path | Why |
|---|---|
| `/app/data` | Every user's AES-encrypted Swiggy tokens **and** the OAuth client registration |

Without it, each redeploy silently signs everyone out and discards the DCR record. In Dokploy:
*Advanced → Volumes → Volume Mount*, mount path `/app/data`.

## 3. Environment variables

| Variable | Value | Notes |
|---|---|---|
| `ENCRYPTION_KEY` | `openssl rand -hex 32` | **Must never change.** It decrypts stored tokens *and* signs the OAuth state. Rotating it forces every user to reconnect. |
| `PUBLIC_BASE_URL` | `https://your-domain` | No trailing slash. The redirect is built as `${PUBLIC_BASE_URL}/swiggy/auth/callback`. |
| `GROQ_API_KEY` | your key | Only `/api/cart/preview` uses it. The prescription flow never calls that route. |
| `APP_RETURN_URL` | `rxocr://connected` | Must match `scheme` in `rx-ocr-expo/app/app.config.js`. |
| `TRUST_PROXY` | `1` | Required behind Traefik, or every client shares one apparent IP and the `/enroll` limit locks everyone out together. |
| `PORT` | `3000` | Matches the Dockerfile and the compose file. |
| `ENROLL_DISABLED` | `1` once everyone has signed up | Enrollment is public by design; this is the off switch. |

Carry over your existing `ENCRYPTION_KEY` from `.env` if you want current users to stay
connected — a new one makes every stored token undecryptable.

## 4. Domain and HTTPS

Add the domain in Dokploy, container port **3000**, and enable **HTTPS / Let's Encrypt**.
Confirm with `curl https://your-domain/healthz` → `{"ok":true}`.

## 5. Re-register the OAuth redirect

The Dynamic Client Registration result is cached in `data/users.json` and reused forever, so
changing `PUBLIC_BASE_URL` alone leaves a registration made for `localhost`. The server says
so at startup:

```
!  REDIRECT MISMATCH -- Swiggy will reject the callback.
!    will send:  https://your-domain/swiggy/auth/callback
!    registered: http://localhost:3000/swiggy/auth/callback
```

Delete the `"clientInformation"` key from `/app/data/users.json` and restart so a fresh
registration is made against the new URL.

**This is the step most likely to stop you**, and not for a reason in this code: the DCR
returns a generic `client_id` (`swiggy-mcp`), which suggests Swiggy controls which redirect
URIs are acceptable. `localhost` is permitted for development; your own domain may need
approval through `https://mcp.swiggy.com/builders/access/`. Verify before relying on it.

## 6. Point the app at it

In `rx-ocr-expo/app/eas.json`, `cart` profile:

```json
"BASE_URL": "https://your-domain"
```

Then `./run.sh build-cart`. With HTTPS you can also build with `HTTPS_ONLY=1` to drop the
cleartext permission entirely. Once deployed, `./run.sh link-phone` is no longer needed — the
callback reaches a real server, so the phone no longer has to tunnel to your laptop.

## Operating it

```bash
docker exec -it <container> npm run add-user -- --list     # who is registered
docker exec -it <container> npm run add-user -- --remove <id>
```

Note that with open enrollment `--remove` is not durable revocation: the same person can
enrol again. `ENROLL_DISABLED=1` is what actually closes the door.

## Still true in production

- **No checkout route.** This builds carts; it never spends money.
- **Prescription data never reaches this server** — only `spinId`, `skuId` and `quantity`.
- `data/users.json` is last-write-wins. Fine for a handful of people; past that it needs a
  real database, and two users connecting in the same instant can lose one update.
