#!/usr/bin/env bash
# Add items to your Instamart cart from plain English.
#
#   ./add.sh "amul taaza toned milk 1 ltr and a dozen eggs"
#
# Run ./setup.sh first (creates your user, connects Swiggy, picks an address).
# This script NEVER places an order -- it only fills the cart. You check out in
# the Swiggy app.

set -euo pipefail
cd "$(dirname "$0")"

TOKEN_FILE=".user-token"
ADDR_FILE=".address-id"
REQUEST="${*:-}"
STARTED_SERVER=0; SERVER_PID=""

c(){ printf '\033[1;36m%s\033[0m\n' "$*"; }
ok(){ printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
cleanup(){ [ "$STARTED_SERVER" = "1" ] && [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

[ -n "$REQUEST" ] || die "usage: ./add.sh \"what you want, in plain English\""
[ -f "$TOKEN_FILE" ] || die "no saved user. Run ./setup.sh first."
TOKEN=$(cat "$TOKEN_FILE")

PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2- || echo 3000); PORT=${PORT:-3000}
API="http://localhost:$PORT"

GROQ=$(grep -E '^GROQ_API_KEY=' .env 2>/dev/null | cut -d= -f2- || true)
{ [ -n "$GROQ" ] && [ "$GROQ" != "gsk_..." ]; } || die "GROQ_API_KEY not set in .env -- needed to turn your text into items."

# --- server ---
if [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/status" 2>/dev/null)" != "401" ]; then
  node src/server.js > server.log 2>&1 &
  SERVER_PID=$!; STARTED_SERVER=1
  for _ in $(seq 1 25); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/status" 2>/dev/null)" = "401" ] && break
    sleep 0.4
  done
fi

CONNECTED=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/api/status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).connected))}catch{process.stdout.write("false")}})')
[ "$CONNECTED" = "true" ] || die "Swiggy not connected. Run ./setup.sh"

# --- address ---
ADDRESS_ID=""
[ -f "$ADDR_FILE" ] && ADDRESS_ID=$(cat "$ADDR_FILE")
if [ -z "$ADDRESS_ID" ]; then
  c "Choose a delivery address"
  AJ=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/api/addresses")
  printf '%s' "$AJ" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);o.addresses.forEach((a,i)=>console.log(`  ${String(i+1).padStart(2)}. [${a.label}] ${String(a.line||"").slice(0,55)}`))})'
  printf '  Pick a number: '; read -r PICK
  ADDRESS_ID=$(printf '%s' "$AJ" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).addresses[Number(process.argv[1])-1];process.stdout.write(a?a.id:"")})' "$PICK")
  [ -n "$ADDRESS_ID" ] || die "invalid choice"
  printf '%s' "$ADDRESS_ID" > "$ADDR_FILE"
  ok "saved as your default (delete $ADDR_FILE to change)"
fi

# --- preview (writes nothing) ---
c "Looking up: $REQUEST"
PREVIEW=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1],addressId:process.argv[2]}))' "$REQUEST" "$ADDRESS_ID")" \
  "$API/api/cart/preview")

ERR=$(printf '%s' "$PREVIEW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).error??"")}catch{process.stdout.write("")}})')
[ -z "$ERR" ] || { echo "  $PREVIEW"; die "$ERR"; }

# Flatten the preview into simple lines so BASH does the prompting.
# (Reading /dev/tty from inside node breaks wherever there's no controlling
# terminal; bash reading its own stdin is portable.)
PLAN=$(printf '%s' "$PREVIEW" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const {results}=JSON.parse(s); const out=[];
  results.forEach((r,ri)=>{
    const want=(r.item.query??r.item.name)+(r.item.quantity>1?` x${r.item.quantity}`:"");
    if(r.status==="no_match"){ out.push(["NONE",want].join("\t")); return; }
    if(r.status==="matched"){ const o=r.options[0];
      out.push(["AUTO",want,o.spinId,o.skuId??"",o.quantity,`${o.label} ₹${o.price}${o.quantityCapped?" (capped)":""}`].join("\t")); return; }
    out.push(["ASK",want,ri].join("\t"));
    r.options.forEach((o,oi)=>out.push(["OPT",ri,oi,o.spinId,o.skuId??"",o.quantity,`${o.label} ₹${o.price}`].join("\t")));
  });
  process.stdout.write(out.join("\n"));
});')

PICKS=$(mktemp)
trap 'rm -f "$PICKS"; cleanup' EXIT

# Read the plan into an array FIRST. Looping with `while read ... <<< "$PLAN"`
# makes stdin the plan itself, so the interactive `read -r ANS` below would
# swallow plan lines instead of the user's keystrokes.
# NOTE: not `mapfile` -- that's bash 4+, and macOS still ships bash 3.2.
PLAN_LINES=()
while IFS= read -r PLAN_LINE; do
  PLAN_LINES+=("$PLAN_LINE")
done <<< "$PLAN"

# ${arr[@]+"${arr[@]}"} -- expanding an EMPTY array as "${arr[@]}" is an
# unbound-variable error under `set -u` on bash 3.2 (macOS default).
for LINE_RAW in ${PLAN_LINES[@]+"${PLAN_LINES[@]}"}; do
  [ -n "$LINE_RAW" ] || continue
  KIND=""; A=""; B=""; C=""; D=""; E=""
  IFS=$'\t' read -r KIND A B C D E <<< "$LINE_RAW"
  case "$KIND" in
    NONE) printf '  \033[1;31m✗\033[0m nothing found for "%s"\n' "$A" ;;
    AUTO) printf '  \033[1;32m✓\033[0m %s\n      -> %s\n' "$A" "$E"
          printf '%s\t%s\t%s\n' "$B" "$C" "$D" >> "$PICKS" ;;
    ASK)  printf '  \033[1;33m?\033[0m %s -- pick one:\n' "$A"
          printf '%s' "$PLAN" | awk -F'\t' -v ri="$B" '$1=="OPT" && $2==ri {printf "      %d. %s\n", $3+1, $7}'
          printf '      number (Enter to skip): '
          read -r ANS
          if [ -n "$ANS" ]; then
            LINE=$(printf '%s' "$PLAN" | awk -F'\t' -v ri="$B" -v oi="$((ANS-1))" '$1=="OPT" && $2==ri && $3==oi {printf "%s\t%s\t%s", $4, $5, $6}')
            if [ -n "$LINE" ]; then printf '%s\n' "$LINE" >> "$PICKS"; else printf '      invalid, skipped\n'; fi
          else printf '      skipped\n'; fi ;;
  esac
done

SELECTIONS=$(node -e '
const fs=require("fs");
const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
process.stdout.write(JSON.stringify(lines.map(l=>{const[spinId,skuId,quantity]=l.split("\t");
  return skuId?{spinId,skuId,quantity:Number(quantity)}:{spinId,quantity:Number(quantity)};})));
' "$PICKS")

COUNT=$(printf '%s' "$SELECTIONS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s||"[]").length)))')
[ "$COUNT" != "0" ] || { warn "nothing selected -- cart unchanged"; exit 0; }

echo
printf "  Add %s item(s) to your cart? [y/N] " "$COUNT"
read -r CONFIRM
case "$CONFIRM" in [yY]*) ;; *) warn "cancelled -- cart unchanged"; exit 0;; esac

# --- confirm (the only write) ---
RESULT=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$(node -e 'process.stdout.write(JSON.stringify({addressId:process.argv[1],selections:JSON.parse(process.argv[2])}))' "$ADDRESS_ID" "$SELECTIONS")" \
  "$API/api/cart/confirm")

ERR=$(printf '%s' "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);process.stdout.write(o.error??"")}catch{process.stdout.write("")}})')
[ -z "$ERR" ] || { echo "  $RESULT"; die "$ERR"; }

ok "cart updated"
echo
c "Cart now contains"
curl -s -H "Authorization: Bearer $TOKEN" "$API/api/cart" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const c=JSON.parse(s).cart;
  (c.items??[]).forEach(i=>console.log(`  - ${i.itemName} (${i.itemVariant}) x${i.quantity}`));
  console.log(`  total: ${c.cartTotalAmount}`);
});'
echo
echo "  Nothing has been ordered. Check out in the Swiggy app when ready."
