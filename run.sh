#!/usr/bin/env bash
# Everything you need to run for the prescription-OCR -> Instamart integration.
#
#   ./run.sh setup        install both halves (once, and after any dependency change)
#   ./run.sh check        typecheck + all offline verification   <- start here, no network
#   ./run.sh web          run the app in a browser (OCR works; cart is native-only)
#   ./run.sh app          Metro for a development build (JS hot-reload on the phone)
#   ./run.sh backend      start the Instamart backend in the foreground
#   ./run.sh smoke        read-only live checks against Swiggy   <- proves MCP works
#   ./run.sh cart-test    ONE real cart write, with confirmation <- touches your cart
#   ./run.sh probe        is this machine reachable from the phone AT ALL?
#   ./run.sh link-phone   make the phone's localhost:3000 reach this backend (for Swiggy OAuth)
#   ./run.sh build-dev       EAS APK: development build (JS then hot-reloads via Metro)
#   ./run.sh build-offline   EAS APK: OCR only, no internet permission
#   ./run.sh build-cart      EAS APK: OCR + Instamart cart
#
# Conventions borrowed from swiggy_instamart_mcp/instamart_app/backend/*.sh:
# this script starts the backend itself when it needs one and kills only what it
# started. It NEVER places an order -- there is no checkout route to call.

set -euo pipefail
cd "$(dirname "$0")"

APP="rx-ocr-expo/app"
BACKEND="swiggy_instamart_mcp/instamart_app/backend"
PORT="${PORT:-3999}"          # the port the phone's build already targets
BASE="http://localhost:$PORT"

STARTED_SERVER=0; SERVER_PID=""

c()   { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  [ "$STARTED_SERVER" = "1" ] && [ -n "$SERVER_PID" ] || return 0
  kill "$SERVER_PID" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.2
  done
  # Verify by the port, not by the pid: a half-dead listener is the failure that matters.
  if curl -s -o /dev/null -m 1 "$BASE/api/status" 2>/dev/null; then
    kill -9 "$SERVER_PID" 2>/dev/null || true
    sleep 0.5
  fi
  if curl -s -o /dev/null -m 1 "$BASE/api/status" 2>/dev/null; then
    warn "a backend is STILL listening on :$PORT -- stop it yourself"
  else
    ok "stopped the backend this script started"
  fi
}
trap cleanup EXIT

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"; }

# Start the backend only if nothing is already answering on $PORT.
start_backend() {
  if curl -s -o /dev/null -m 1 "$BASE/api/status" 2>/dev/null; then
    ok "backend already running on :$PORT"
    return
  fi
  [ -f "$BACKEND/.env" ] || die "$BACKEND/.env is missing. Run: cd $BACKEND && ./setup.sh"
  # `exec` matters: without it $! is the subshell's pid and node survives as an orphan.
  ( cd "$BACKEND" && exec env PORT="$PORT" node src/server.js >/tmp/rx-backend.log 2>&1 ) &
  SERVER_PID=$!; STARTED_SERVER=1
  for _ in $(seq 1 30); do
    sleep 0.4
    curl -s -o /dev/null -m 1 "$BASE/api/status" 2>/dev/null && break
  done
  curl -s -o /dev/null -m 1 "$BASE/api/status" 2>/dev/null \
    || die "backend did not start. See /tmp/rx-backend.log"
  ok "backend started on :$PORT"
}

creds() {
  [ -f "$BACKEND/.user-token" ] || die "no $BACKEND/.user-token. Run: cd $BACKEND && ./setup.sh"
  [ -f "$BACKEND/.address-id" ] || die "no $BACKEND/.address-id. Run: cd $BACKEND && ./setup.sh"
  TOK="$(cat "$BACKEND/.user-token")"
  ADDR="$(cat "$BACKEND/.address-id")"
}

# --- commands ---------------------------------------------------------------

cmd_setup() {
  need node; need npm
  c "Installing the app (postinstall patches onnxruntime -- do not skip it)"
  ( cd "$APP" && npm install )
  ok "app dependencies installed"
  c "Installing the backend"
  ( cd "$BACKEND" && npm install )
  ok "backend dependencies installed"
  if [ ! -f "$BACKEND/.env" ]; then
    warn "$BACKEND/.env does not exist yet."
    warn "Run: cd $BACKEND && ./setup.sh    (creates .env, a user, and connects Swiggy)"
  fi
}

# Everything here is offline and safe. Run it after any change to the app.
cmd_check() {
  c "TypeScript"
  ( cd "$APP" && npm run typecheck ) && ok "no type errors"
  c "OCR path unchanged (TypeScript vs the Python reference)"
  ( cd "$APP" && npm run verify )
  c "spinId propagation (the gap 'verify' cannot see -- it compares skuId only)"
  ( cd "$APP" && npm run verify:spin )
  c "Cart seam: selection rules, quantity caps, payload shape, error contract"
  ( cd "$APP" && npm run verify:cart )
  c "Both build profiles resolve correctly"
  ( cd "$APP" \
    && EAS_BUILD_PROFILE=preview npx expo config --type public --json 2>/dev/null \
       | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);
         const blocked=(c.android.blockedPermissions||[]).includes("android.permission.INTERNET");
         console.log("  preview: cartEnabled="+c.extra.cartEnabled+"  INTERNET blocked="+blocked);
         if(!blocked||c.extra.cartEnabled!==false){console.error("  FAIL: preview must stay offline");process.exit(1);}})' \
    && BASE_URL=https://example.invalid EAS_BUILD_PROFILE=cart npx expo config --type public --json 2>/dev/null \
       | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);
         const blocked=(c.android.blockedPermissions||[]).includes("android.permission.INTERNET");
         console.log("  cart:    cartEnabled="+c.extra.cartEnabled+"  INTERNET blocked="+blocked);
         if(blocked||c.extra.cartEnabled!==true){console.error("  FAIL: cart profile needs internet");process.exit(1);}})' )
  ok "all offline checks passed"
}

cmd_web() {
  c "Starting the app on http://localhost:8081"
  echo "  The OCR half runs here. The CART HALF DOES NOT: expo-secure-store has an empty"
  echo "  web shim, so the bearer token has nowhere safe to live and cartEnabled() is false"
  echo "  on web by design. Use a device build (./run.sh build-cart) to exercise the cart."
  ( cd "$APP" && npx expo start --web --port 8081 --clear )
}

cmd_backend() {
  [ -f "$BACKEND/.env" ] || die "$BACKEND/.env is missing. Run: cd $BACKEND && ./setup.sh"
  c "Backend on :$PORT (Ctrl-C to stop)"
  ( cd "$BACKEND" && PORT="$PORT" node src/server.js )
}

# Read-only. Proves the MCP chain to Swiggy is alive. Writes nothing.
cmd_smoke() {
  need curl; creds; start_backend

  c "1. /api/status            (local record, no Swiggy call)"
  curl -s -H "Authorization: Bearer $TOK" "$BASE/api/status"; echo

  c "2. /api/addresses         (MCP: get_addresses)"
  curl -s -m 60 -H "Authorization: Bearer $TOK" "$BASE/api/addresses" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);
    if(d.error){console.log("  ERROR:",d.error,d.action||"");process.exit(1);}
    console.log("  "+d.addresses.length+" addresses; needsUserClarification="+d.needsUserClarification);
    d.addresses.slice(0,5).forEach(a=>console.log("   - "+a.label+" ("+a.category+")"));})'

  c "3. /api/search            (MCP: search_products)"
  curl -s -m 90 -G -H "Authorization: Bearer $TOK" \
    --data-urlencode "q=colimex" --data-urlencode "addressId=$ADDR" "$BASE/api/search" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);
    if(d.error){console.log("  ERROR:",d.error);process.exit(1);}
    console.log("  "+d.count+" rows for \"colimex\"");
    (d.results||[]).slice(0,3).forEach(r=>console.log("   - "+r.product+"  stock="+r.inStock+" max="+r.maxQuantity+" spin="+r.spinId));})'

  c "4. /api/cart              (MCP: get_cart) -- your current cart"
  curl -s -m 60 -H "Authorization: Bearer $TOK" "$BASE/api/cart" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=(JSON.parse(s).cart)||{};
    const items=c.items||[];
    console.log("  "+items.length+" item(s), total "+(c.cartTotalAmount||0));
    items.forEach(i=>console.log("   - "+i.itemName+" x"+i.quantity));})'

  c "5. payload validation     (returns before any MCP call -- nothing is written)"
  printf '  no selections -> '; curl -s -X POST -H "Authorization: Bearer $TOK" \
    -H "Content-Type: application/json" -d '{"addressId":"x"}' "$BASE/api/cart/confirm"; echo
  printf '  no addressId  -> '; curl -s -X POST -H "Authorization: Bearer $TOK" \
    -H "Content-Type: application/json" \
    -d '{"selections":[{"spinId":"S","skuId":"K","quantity":1}]}' "$BASE/api/cart/confirm"; echo

  ok "read-only checks done. Nothing was added to your cart."
}

# The one write. Adds a single real item to a real Swiggy cart.
cmd_cart_test() {
  need curl; creds; start_backend

  warn "This adds ONE real item to your real Swiggy Instamart cart."
  warn "No order is placed and no money moves -- there is no checkout route."
  warn "The backend has NO removal path: you clear it in the Swiggy app afterwards."
  printf '\033[1;33m  Type "yes" to continue: \033[0m'
  read -r reply
  [ "$reply" = "yes" ] || die "cancelled; nothing was written"

  c "Cart before"
  curl -s -m 60 -H "Authorization: Bearer $TOK" "$BASE/api/cart" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=(JSON.parse(s).cart)||{};
    const i=c.items||[];console.log("  "+i.length+" item(s)");i.forEach(x=>console.log("   - "+x.itemName+" x"+x.quantity));})'

  c "Adding Ibugesic Plus x1, using the app's own toApprovedItems()"
  ( cd "$APP" && TOK="$TOK" ADDR="$ADDR" BASE="$BASE" npx tsx - <<'TS'
import * as fs from 'fs';
import catalog from './src/match/catalog.json';
import { CatalogItem, parseListing } from './src/match/matcher';
import { Spotter } from './src/match/spot';
import { toApprovedItems, toReviewItems, mapError } from './src/swiggy/types';

const ocr = JSON.parse(fs.readFileSync('tools/fixtures/ref.json', 'utf8'));
const spotter = new Spotter((catalog as { results: CatalogItem[] }).results.map(parseListing));
const d = ocr['IMG-20260610-WA0004'];
const items = toReviewItems(spotter.spot(d.lines, d.w, d.h).medicines);
// Simulate the review screen: tick exactly one medicine, quantity 1.
items.forEach((it) => { it.selected = it.medicine.prescribed === 'ibugesic plus'; it.quantity = 1; });

const payload = toApprovedItems(items);
console.log('  payload:', JSON.stringify(payload));
if (payload.length !== 1) { console.error('  ABORT: expected exactly one item'); process.exit(1); }

(async () => {
  const res = await fetch(`${process.env.BASE}/api/cart/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TOK}` },
    body: JSON.stringify({ addressId: process.env.ADDR, selections: payload }),
  });
  const body: any = await res.json();
  if (!res.ok) {
    const e = mapError(res.status, body, '/api/cart/confirm');
    console.error(`  FAILED ${res.status} kind=${e.kind} "${e.message}"`);
    process.exit(1);
  }
  console.log('  HTTP', res.status, '| preservedFromExisting =', body.preservedFromExisting);
})();
TS
  )

  c "Cart after"
  curl -s -m 60 -H "Authorization: Bearer $TOK" "$BASE/api/cart" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=(JSON.parse(s).cart)||{};
    const i=c.items||[];console.log("  "+i.length+" item(s), total "+(c.cartTotalAmount||0));
    i.forEach(x=>console.log("   - "+x.itemName+" x"+x.quantity));})'

  warn "Remove this in the Swiggy app when you are done -- the backend cannot."
}

# Answers one question only: do packets from the phone reach this machine?
#
# It is a raw TCP listener, not an HTTP server, so it cannot be confounded by anything the
# client does above the socket. Whatever arrives is printed -- including a TLS handshake,
# which is itself the answer when a browser has silently upgraded http:// to https://.
#
#   nothing arrives          -> the phone is not reaching this machine (wrong network,
#                               mobile data, or the router isolates clients)
#   "GET / HTTP/1.1"         -> plain HTTP arrives; the network is fine
#   binary starting with 16 03 -> a TLS ClientHello: the client upgraded to HTTPS on its own.
#                               The network is FINE; the scheme is the problem.
cmd_probe() {
  need node
  local ip
  ip="$(ip -4 addr show 2>/dev/null | grep -oP 'inet \K[0-9.]+' | grep -v '^127\.' | grep -v '^172\.17\.' | head -1)"
  [ -n "$ip" ] || die "could not work out this machine's LAN address"
  c "Open this on the phone, then watch below (Ctrl-C to stop):"
  printf '\n    \033[1;36mhttp://%s:4999/\033[0m\n\n' "$ip"
  echo "  Nothing appearing = the phone never reached this machine."
  echo
  node -e '
    const net = require("net");
    net.createServer((sock) => {
      const who = sock.remoteAddress?.replace("::ffff:", "") ?? "?";
      sock.once("data", (buf) => {
        const tls = buf[0] === 0x16 && buf[1] === 0x03;
        const head = buf.toString("latin1").split(/\r?\n/)[0].slice(0, 70);
        console.log(
          tls
            ? `  [${who}] TLS handshake -- the client upgraded to HTTPS. NETWORK IS FINE.`
            : `  [${who}] ${head}   <- plain HTTP arrived. NETWORK IS FINE.`
        );
        sock.end("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nreached\n");
      });
      sock.on("error", () => {});
      setTimeout(() => sock.destroy(), 4000);
    }).listen(4999, "0.0.0.0", () => console.log("  listening on 0.0.0.0:4999 ..."));
  '
}

# Swiggy's OAuth callback is registered as EXACTLY http://localhost:3000/swiggy/auth/callback,
# and Swiggy only tolerates plain http because it is localhost. On the phone, "localhost" is the
# phone -- so the redirect at the end of the OTP lands nowhere and Chrome shows
# ERR_CONNECTION_REFUSED.
#
# `adb reverse` fixes that at the right layer: it makes the PHONE's localhost:3000 forward over
# USB to this machine. Nothing about the registered redirect URI changes, which matters because
# re-registering it as a LAN address would almost certainly be refused (non-localhost http).
#
# Needs USB debugging on, and it must be re-run whenever the cable is unplugged.
cmd_link_phone() {
  need adb
  local devices
  devices="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
  if [ -z "$devices" ]; then
    warn "no authorised device. Plug the phone in over USB, enable Developer options ->"
    warn "USB debugging, and accept the 'Allow USB debugging?' prompt on the phone."
    adb devices -l
    die "no device to link"
  fi
  ok "device: $devices"
  # Phone-side port is 3000 because that is what Swiggy has registered; the local side is
  # whatever the backend actually runs on. They do not have to match.
  adb reverse tcp:3000 "tcp:$PORT" >/dev/null || die "adb reverse failed"
  ok "phone's localhost:3000 -> this machine's :$PORT"
  c "Check it from the phone's browser:"
  printf '\n    \033[1;36mhttp://localhost:3000/api/status\033[0m\n\n'
  echo "  Expect {\"error\":\"invalid token\"} -- that means the tunnel works."
  echo "  Re-run this after unplugging the cable. Remove it with: adb reverse --remove tcp:3000"
}

# A development build loads JS from Metro, so after this only NATIVE changes (a new native
# module, or app.config.js native keys like `scheme`) need another build -- JS reloads.
# Built in the cloud on purpose: the Android Gradle Plugin wants JDK 17 and this machine has
# only 11 and 22, so `--local` would likely fail on the toolchain rather than the code.
cmd_build_dev() {
  need npx
  c "EAS build: development profile"
  echo "  Afterwards: install the APK, run './run.sh app', and JS changes reload live."
  ( cd "$APP" && npx eas build -p android --profile development )
}

# Metro, for a development build. `expo start` sets up adb reverse for 8081 itself when a
# device is attached; ./run.sh link-phone handles port 3000 for the OAuth callback.
cmd_app() {
  c "Metro (Ctrl-C to stop)"
  ( cd "$APP" && npx expo start --dev-client )
}

cmd_build_offline() {
  need npx
  c "EAS build: preview profile (no INTERNET permission)"
  echo "  This is the build that PROVES the OCR runs offline. Keep it that way."
  ( cd "$APP" && npx eas build -p android --profile preview )
}

cmd_build_cart() {
  need npx
  grep -q "your-backend.example.com" "$APP/eas.json" \
    && die "Set BASE_URL in $APP/eas.json (cart profile) to your backend's address first."
  c "EAS build: cart profile (OCR + Instamart)"
  ( cd "$APP" && npx eas build -p android --profile cart )
}

case "${1:-}" in
  setup)          cmd_setup ;;
  check)          cmd_check ;;
  web)            cmd_web ;;
  backend)        cmd_backend ;;
  smoke)          cmd_smoke ;;
  cart-test)      cmd_cart_test ;;
  probe)          cmd_probe ;;
  link-phone)     cmd_link_phone ;;
  build-dev)      cmd_build_dev ;;
  app)            cmd_app ;;
  build-offline)  cmd_build_offline ;;
  build-cart)     cmd_build_cart ;;
  *)  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
