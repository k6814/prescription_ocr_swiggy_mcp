#!/usr/bin/env bash
# Search Instamart and list every result. Read-only -- touches nothing.
#
#   ./search.sh "paracetamol"
#   ./search.sh "paracetamol" --all              # follow nextOffset to the end
#   ./search.sh "paracetamol" --all --json       # merged JSON of every page
#   ./search.sh "paracetamol" --all --out m.json # write that JSON to a file
#   ./search.sh "paracetamol" --all --max-pages 50
#
# Flags may appear before or after the query, in any order.
#
# Run ./setup.sh first. No Groq involved: your text goes straight to Swiggy,
# so this also tells you whether a bad result in ./add.sh came from the
# language parsing or from Swiggy's own search.

set -euo pipefail
cd "$(dirname "$0")"

MAX_PAGES=25        # safety cap for --all; override with --max-pages
PAGE_DELAY=0.6      # be polite: Swiggy's planned ceiling is 120 req/min

ALL=0; JSON=0; OUT=""; WORDS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --all)       ALL=1; shift ;;
    --json)      JSON=1; shift ;;
    --out)       OUT="${2:-}"; [ -n "$OUT" ] || { echo "--out needs a filename" >&2; exit 1; }; shift 2 ;;
    --max-pages) MAX_PAGES="${2:-}"; shift 2 ;;
    --)          shift ;;
    *)           WORDS="$WORDS $1"; shift ;;
  esac
done
# Flags are stripped wherever they appeared, so the query is what's left.
QUERY="$(printf '%s' "$WORDS" | sed 's/^ *//; s/ *$//')"
[ -z "$OUT" ] || JSON=1

STARTED_SERVER=0; SERVER_PID=""
c(){ printf '\033[1;36m%s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
cleanup(){ if [ "$STARTED_SERVER" = "1" ] && [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi; }
trap cleanup EXIT

[ -n "$QUERY" ] || die 'usage: ./search.sh [--all] [--json] "what to search for"'
[ -f .user-token ] || die "no saved user. Run ./setup.sh first."
TOKEN=$(cat .user-token)

PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2- || echo 3000); PORT=${PORT:-3000}
API="http://localhost:$PORT"

if [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/status" 2>/dev/null)" != "401" ]; then
  node src/server.js > server.log 2>&1 &
  SERVER_PID=$!; STARTED_SERVER=1
  for _ in $(seq 1 25); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/status" 2>/dev/null)" = "401" ] && break
    sleep 0.4
  done
fi

# --- address (reuse the one ./add.sh saved) ---
ADDRESS_ID=""
[ -f .address-id ] && ADDRESS_ID=$(cat .address-id)
if [ -z "$ADDRESS_ID" ]; then
  AJ=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/api/addresses")
  # If stdin isn't a terminal (e.g. called from bulk-search.sh with output
  # redirected), prompting is pointless -- the question never reaches anyone.
  if [ ! -t 0 ]; then
    die "no .address-id and not running interactively. Run ./search.sh once by hand to pick an address."
  fi
  c "Choose a delivery address (results are per-store, so this matters)"
  printf '%s' "$AJ" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);o.addresses.forEach((a,i)=>console.log(`  ${String(i+1).padStart(2)}. [${a.label}] ${String(a.line||"").slice(0,55)}`))})'
  printf '  Pick a number: '; read -r PICK
  ADDRESS_ID=$(printf '%s' "$AJ" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).addresses[Number(process.argv[1])-1];process.stdout.write(a?a.id:"")})' "$PICK")
  [ -n "$ADDRESS_ID" ] || die "invalid choice"
  printf '%s' "$ADDRESS_ID" > .address-id
fi

urlenc(){ node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
Q=$(urlenc "$QUERY"); A=$(urlenc "$ADDRESS_ID")

fetch_page(){ # $1 = offset ("" for first)
  curl -s -H "Authorization: Bearer $TOKEN" "$API/api/search?q=$Q&addressId=$A&offset=$1"
}

fetch_all(){   # echoes one JSON doc per page, newline separated
  local offset="" page=1
  while :; do
    local body; body=$(fetch_page "$offset")
    local err; err=$(printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).error??"")}catch{process.stdout.write("bad response")}})')
    if [ -n "$err" ]; then printf 'ERROR\t%s\n' "$err"; return 1; fi
    printf '%s\n' "$body"
    [ "$ALL" = "1" ] || return 0
    local next; next=$(printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).nextOffset;process.stdout.write(v==null?"":String(v))})')
    [ -n "$next" ] || return 0
    [ "$next" != "$offset" ] || return 0          # offset stopped advancing
    page=$((page+1))
    if [ "$page" -gt "$MAX_PAGES" ]; then
      printf 'CAPPED\t%s\n' "$MAX_PAGES"; return 0
    fi
    offset="$next"
    sleep "$PAGE_DELAY"
  done
}

[ "$JSON" = "1" ] || c "Searching: $QUERY${ALL:+}"

PAGES_FILE=$(mktemp)
trap 'rm -f "$PAGES_FILE"; cleanup' EXIT
fetch_all > "$PAGES_FILE" || true

if grep -q '^ERROR	' "$PAGES_FILE"; then
  die "$(sed -n 's/^ERROR\t//p' "$PAGES_FILE" | head -1)"
fi
CAPPED=$(sed -n 's/^CAPPED\t//p' "$PAGES_FILE" | head -1 || true)

# Merge pages, dedupe by spinId (the same variant can repeat across pages).
MERGED=$(node -e '
const fs=require("fs");
const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(l=>l.startsWith("{"));
const seen=new Set(); const results=[]; let pages=0; let query="";
for(const l of lines){
  const o=JSON.parse(l); pages++; query=o.query??query;
  for(const r of o.results??[]){
    if(seen.has(r.spinId)) continue;
    seen.add(r.spinId); results.push(r);
  }
}
process.stdout.write(JSON.stringify({
  query, pages, count: results.length,
  direct: results.filter(r=>!r.isSimilar).length,
  similar: results.filter(r=>r.isSimilar).length,
  fetchedAt: new Date().toISOString(),
  results
}, null, 2));
' "$PAGES_FILE")

if [ -n "$OUT" ]; then
  printf '%s\n' "$MERGED" > "$OUT"
  N=$(printf '%s' "$MERGED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).count)))')
  P=$(printf '%s' "$MERGED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).pages)))')
  printf '  wrote %s unique result(s) from %s page(s) to %s\n' "$N" "$P" "$OUT"
  [ -z "$CAPPED" ] || printf '  (stopped at the %s-page cap -- raise with --max-pages)\n' "$CAPPED"
  exit 0
fi

if [ "$JSON" = "1" ]; then
  printf '%s\n' "$MERGED"
  exit 0
fi

printf '%s' "$MERGED" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const o=JSON.parse(s);
  o.results.forEach((r,i)=>{
    const n=String(i+1).padStart(3);
    const stock=r.inStock?"":"  [OUT OF STOCK]";
    const tag=r.isSimilar?" ~":"  ";
    const price=r.price!=null?`\u20b9${r.price}`:"-";
    const mrp=(r.mrp!=null&&r.mrp!==r.price)?` (mrp \u20b9${r.mrp})`:"";
    const max=r.maxQuantity!=null?`  max ${r.maxQuantity}`:"";
    console.log(`${n}.${tag}${r.product}`);
    console.log(`      ${String(r.size).padEnd(14)} ${price}${mrp}${max}${r.rating?`  \u2605${r.rating}`:""}${stock}`);
    console.log(`      spinId=${r.spinId}${r.skuId?`  skuId=${r.skuId}`:""}`);
  });
  console.log();
  console.log(`  ${o.count} unique result(s) across ${o.pages} page(s) -- ${o.direct} direct, ${o.similar} similar (~).`);
});'

[ -z "$CAPPED" ] || printf '  (stopped at the %s-page cap -- raise with --max-pages)\n' "$CAPPED"
[ "$ALL" = "1" ] || printf '  Only the first page. Add --all for everything.\n'
echo "  Nothing was added to your cart."
