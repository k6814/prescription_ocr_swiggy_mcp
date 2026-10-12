#!/usr/bin/env bash
# One-shot setup + connect + inspect for the Instamart backend.
#
#   ./setup.sh              # uses saved user, or creates one; query defaults to "milk"
#   ./setup.sh "bread"      # different search query
#   ./setup.sh "milk" kevin # explicit user id
#
# Safe to re-run. It reuses your saved token instead of creating a new user
# each time -- creating a new user is what silently loses your Swiggy
# connection, since tokens are stored per user.

set -euo pipefail
cd "$(dirname "$0")"

TOKEN_FILE=".user-token"
QUERY="${1:-milk}"
USER_ID="${2:-}"
STARTED_SERVER=0
SERVER_PID=""

c()  { printf '\033[1;36m%s\033[0m\n' "$*"; }      # step
ok() { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  if [ "$STARTED_SERVER" = "1" ] && [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    printf '\n'; ok "stopped the server this script started"
  fi
}
trap cleanup EXIT

# JSON parsing via node -- already a dependency, unlike jq.
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a?.[k],o);process.stdout.write(v==null?"":String(v))}catch{process.stdout.write("")}})' "$1"; }

# ---------------------------------------------------------------- preflight
c "1/7  Checking prerequisites"
command -v node >/dev/null || die "node not found. Install Node 18+."
command -v npm  >/dev/null || die "npm not found."
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18+ required (found $(node -v))."
ok "node $(node -v)"

[ -d node_modules ] || { c "      installing dependencies (first run, ~30s)"; npm install --no-audit --no-fund >/dev/null; }
ok "dependencies present"

# ---------------------------------------------------------------- .env
c "2/7  Checking .env"
[ -f .env ] || { cp .env.example .env; ok "created .env from template"; }

# ENCRYPTION_KEY: generate if absent/blank. Never regenerate an existing one --
# that would make every stored Swiggy token undecryptable.
CURRENT_KEY=$(grep -E '^ENCRYPTION_KEY=' .env | cut -d= -f2- || true)
if [ ${#CURRENT_KEY} -ne 64 ]; then
  NEWKEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
  if grep -qE '^ENCRYPTION_KEY=' .env; then
    node -e 'const fs=require("fs");const f=".env";fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/^ENCRYPTION_KEY=.*$/m,"ENCRYPTION_KEY="+process.argv[1]))' "$NEWKEY"
  else
    echo "ENCRYPTION_KEY=$NEWKEY" >> .env
  fi
  ok "generated ENCRYPTION_KEY (back up .env -- losing it means everyone reconnects)"
else
  ok "ENCRYPTION_KEY set"
fi

GROQ=$(grep -E '^GROQ_API_KEY=' .env | cut -d= -f2- || true)
if [ -z "$GROQ" ] || [ "$GROQ" = "gsk_..." ]; then
  warn "GROQ_API_KEY not set in .env"
  printf '      Paste your Groq key (from console.groq.com), or press Enter to skip: '
  read -r GROQ_INPUT
  if [ -n "$GROQ_INPUT" ]; then
    node -e 'const fs=require("fs");const f=".env";const s=fs.readFileSync(f,"utf8");fs.writeFileSync(f,/^GROQ_API_KEY=/m.test(s)?s.replace(/^GROQ_API_KEY=.*$/m,"GROQ_API_KEY="+process.argv[1]):s+"\nGROQ_API_KEY="+process.argv[1])' "$GROQ_INPUT"
    ok "GROQ_API_KEY saved"
  else
    warn "skipping -- connect + inspect still work; /api/cart/preview will not"
  fi
else
  ok "GROQ_API_KEY set"
fi

PORT=$(grep -E '^PORT=' .env | cut -d= -f2- || echo 3000); PORT=${PORT:-3000}
BASE=$(grep -E '^PUBLIC_BASE_URL=' .env | cut -d= -f2- || true)
if [ -z "$BASE" ] || [ "$BASE" = "https://your-backend.example.com" ]; then
  BASE="http://localhost:$PORT"
  node -e 'const fs=require("fs");const f=".env";const s=fs.readFileSync(f,"utf8");fs.writeFileSync(f,/^PUBLIC_BASE_URL=/m.test(s)?s.replace(/^PUBLIC_BASE_URL=.*$/m,"PUBLIC_BASE_URL="+process.argv[1]):s+"\nPUBLIC_BASE_URL="+process.argv[1])' "$BASE"
  warn "PUBLIC_BASE_URL set to $BASE (local only -- needs real HTTPS before sharing)"
else
  ok "PUBLIC_BASE_URL=$BASE"
fi
API="http://localhost:$PORT"

# ---------------------------------------------------------------- server
c "3/7  Starting backend"
if curl -fsS -o /dev/null "$API/api/status" 2>/dev/null || [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/status" 2>/dev/null)" = "401" ]; then
  ok "already running on :$PORT (leaving it alone)"
else
  node src/server.js > server.log 2>&1 &
  SERVER_PID=$!; STARTED_SERVER=1
  for i in $(seq 1 25); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/status" 2>/dev/null)" = "401" ] && break
    sleep 0.4
    kill -0 "$SERVER_PID" 2>/dev/null || { echo; tail -20 server.log; die "server exited on startup (see server.log)"; }
  done
  ok "started on :$PORT (pid $SERVER_PID, logs -> server.log)"
fi

# ---------------------------------------------------------------- user
c "4/7  Resolving your user token"
TOKEN=""
if [ -f "$TOKEN_FILE" ]; then
  TOKEN=$(cat "$TOKEN_FILE")
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$API/api/status")
  if [ "$CODE" = "200" ]; then
    ok "reusing saved token for '$(curl -s -H "Authorization: Bearer $TOKEN" "$API/api/status" | jget user)'"
  else
    warn "saved token no longer valid (user was removed) -- creating a new one"
    TOKEN=""
  fi
fi

if [ -z "$TOKEN" ]; then
  if [ -z "$USER_ID" ]; then
    printf '      Pick a user id (e.g. your name): '
    read -r USER_ID
    [ -n "$USER_ID" ] || die "user id required"
  fi
  TOKEN=$(node scripts/add-user.js "$USER_ID" | awk '/^Token:/{print $2}')
  [ -n "$TOKEN" ] || die "failed to create user"
  printf '%s' "$TOKEN" > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"
  ok "created user '$USER_ID', token saved to $TOKEN_FILE"
fi

# ---------------------------------------------------------------- connect
c "5/7  Connecting your Swiggy account"
CONNECTED=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/api/status" | jget connected)
if [ "$CONNECTED" = "true" ]; then
  ok "already connected"
else
  LINK_JSON=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/api/auth/link")
  URL=$(printf '%s' "$LINK_JSON" | jget url)
  if [ -z "$URL" ]; then
    echo "      response: $LINK_JSON"
    die "could not get an auth link (check server.log)"
  fi

  echo
  echo "      Opening Swiggy login in your browser."
  echo "      If it doesn't open, paste this URL yourself:"
  echo
  echo "      $URL"
  echo
  if command -v open >/dev/null; then open "$URL"
  elif command -v xdg-open >/dev/null; then xdg-open "$URL" >/dev/null 2>&1
  else warn "no browser opener found -- open the URL above manually"; fi

  printf '      Waiting for you to finish logging in'
  for i in $(seq 1 150); do   # 5 minutes
    sleep 2; printf '.'
    C=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/api/status" | jget connected)
    [ "$C" = "true" ] && { CONNECTED=true; break; }
  done
  echo
  [ "${CONNECTED:-}" = "true" ] || die "timed out. Re-run the script; if the browser showed a redirect_uri error, PUBLIC_BASE_URL doesn't match what Swiggy accepts."
  ok "connected"
fi

# ---------------------------------------------------------------- address
c "6/7  Choosing a delivery address"
ADDR_JSON=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/api/addresses")
COUNT=$(printf '%s' "$ADDR_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).addresses.length))}catch{process.stdout.write("0")}})')
[ "$COUNT" != "0" ] || { echo "      $ADDR_JSON"; die "no addresses returned"; }

printf '%s' "$ADDR_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);o.addresses.forEach((a,i)=>console.log(`      ${String(i+1).padStart(2)}. [${a.label}] ${String(a.line||"").slice(0,60)}`));})'
echo
printf "      Pick 1-%s (Swiggy's suggestion is NOT auto-used on purpose): " "$COUNT"
read -r PICK
ADDRESS_ID=$(printf '%s' "$ADDR_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const a=o.addresses[Number(process.argv[1])-1];process.stdout.write(a?a.id:"")})' "$PICK")
[ -n "$ADDRESS_ID" ] || die "invalid choice"
ok "using $ADDRESS_ID"

# ---------------------------------------------------------------- inspect
c "7/7  Dumping response shapes for query \"$QUERY\""
echo
node scripts/inspect-shapes.js "$TOKEN" "$QUERY" "$ADDRESS_ID" | tee shapes.json
echo
ok "saved to shapes.json"
echo
echo "      Next: read the search_products block above and fill the FIELDS"
echo "      object at the top of src/server.js -- what the product array is"
echo "      called, the title field, and where spinId/skuId live."
echo
