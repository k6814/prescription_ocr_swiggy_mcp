#!/usr/bin/env bash
# Run many searches from a file and merge them into ONE deduped JSON.
#
#   ./bulk-search.sh queries.txt --out catalog.json
#   ./bulk-search.sh queries.txt --out catalog.json --resume
#   ./bulk-search.sh more-meds.txt --out catalog.json --append
#
# Each line of the queries file is searched with ./search.sh --all (so it
# paginates to exhaustion), then everything is merged and deduped by spinId.
#
# --append folds the NEW results into an existing --out file instead of
# replacing it, so you can keep adding query files over time. Records already
# present are refreshed (price/stock updated, matchedQueries unioned) rather
# than duplicated.
# Every record carries `matchedQueries`, so you can see which terms found it.
#
# Read-only. Nothing is ever added to a cart.
#
# NOTE ON COVERAGE: this is a SAMPLE, not a catalogue. Swiggy's MCP has no
# browse/category tool -- only keyword search, and search depth is capped per
# query. You will only ever find what your seed terms surface, and you cannot
# tell what you missed. Results are also per-store: a different delivery
# address returns different stock and prices.

set -euo pipefail
cd "$(dirname "$0")"

OUT="catalog.json"
QUERY_DELAY="${QUERY_DELAY:-2}"     # seconds between queries; Swiggy's planned ceiling is 120 req/min
RETRIES="${RETRIES:-3}"             # attempts per term before giving up
BACKOFF="${BACKOFF:-4}"             # first retry waits this long, then doubles
RESUME=0
KEEP_RAW=0
APPEND=0
QFILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --out)      OUT="${2:-}"; shift 2 ;;
    --resume)   RESUME=1; shift ;;
    --append)   APPEND=1; shift ;;
    --keep-raw) KEEP_RAW=1; shift ;;
    --)         shift ;;
    *)          QFILE="$1"; shift ;;
  esac
done

c(){ printf '\033[1;36m%s\033[0m\n' "$*"; }
ok(){ printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$QFILE" ] || die 'usage: ./bulk-search.sh queries.txt [--out catalog.json] [--resume]'
[ -f "$QFILE" ] || die "no such file: $QFILE"
[ -x ./search.sh ] || die "./search.sh not found or not executable"

RAW=".bulk-raw"
mkdir -p "$RAW"

# Start the backend ONCE for the whole run. Without this, search.sh spawns and
# kills its own server per term -- 30 terms means 30 startups, and each one
# re-does OAuth discovery.
STARTED_SERVER=0; SERVER_PID=""
cleanup(){ if [ "$STARTED_SERVER" = "1" ] && [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi; }
trap cleanup EXIT

PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2- || echo 3000); PORT=${PORT:-3000}
API="http://localhost:$PORT"
if [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/status" 2>/dev/null)" != "401" ]; then
  node src/server.js > server.log 2>&1 &
  SERVER_PID=$!; STARTED_SERVER=1
  for _ in $(seq 1 25); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/status" 2>/dev/null)" = "401" ] && break
    sleep 0.4
  done
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/status" 2>/dev/null)" = "401" ] || die "backend did not start (see server.log)"
fi

# Resolve the delivery address BEFORE the loop. search.sh would prompt for it,
# but its output is redirected per-term, so the prompt would vanish into a log
# and `read` would get nothing. Ask here, where stdout is still the terminal.
if [ ! -s .address-id ]; then
  [ -f .user-token ] || die "no saved user. Run ./setup.sh first."
  TOKEN=$(cat .user-token)
  AJ=$(curl -s -H "Authorization: Bearer $TOKEN" "$API/api/addresses")
  AERR=$(printf '%s' "$AJ" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).error??"")}catch{process.stdout.write("bad response")}})')
  [ -z "$AERR" ] || die "$AERR"
  c "Results are per-store, so pick the delivery address to crawl against"
  printf '%s' "$AJ" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);o.addresses.forEach((a,i)=>console.log(`  ${String(i+1).padStart(2)}. [${a.label}] ${String(a.line||"").slice(0,55)}`))})'
  printf '  Pick a number: '
  read -r PICK
  ADDRESS_ID=$(printf '%s' "$AJ" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).addresses[Number(process.argv[1])-1];process.stdout.write(a?a.id:"")})' "$PICK")
  [ -n "$ADDRESS_ID" ] || die "invalid choice"
  printf '%s' "$ADDRESS_ID" > .address-id
  ok "using that address for every search (delete .address-id to change)"
fi

# Read terms, skipping blanks and comments.
TERMS=()
while IFS= read -r LINE || [ -n "$LINE" ]; do
  LINE="$(printf '%s' "$LINE" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  case "$LINE" in ""|\#*) continue ;; esac
  TERMS+=("$LINE")
done < "$QFILE"

TOTAL=${#TERMS[@]}
[ "$TOTAL" -gt 0 ] || die "no search terms found in $QFILE"
c "$TOTAL search term(s) from $QFILE"

# A stable, filesystem-safe name per term.
slug(){ printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '_' | sed 's/__*/_/g; s/^_//; s/_$//'; }

I=0; FAILURES=0
for TERM in ${TERMS[@]+"${TERMS[@]}"}; do
  I=$((I+1))
  F="$RAW/$(slug "$TERM").json"
  if [ "$RESUME" = "1" ] && [ -s "$F" ]; then
    printf '  [%2s/%s] %-20s skipped (already have it)\n' "$I" "$TOTAL" "$TERM"
    continue
  fi
  printf '  [%2s/%s] %-20s ' "$I" "$TOTAL" "$TERM"
  ERRLOG="$RAW/$(slug "$TERM").err"

  # Retry with EXPONENTIAL BACKOFF -- but only on failure. A fixed growing
  # sleep between every term would punish the successful ones: doubling from
  # 2s across 30 terms ends at 2^29 seconds. Successes stay at QUERY_DELAY.
  ATTEMPT=1; WAIT="$BACKOFF"; PASSED=0
  while [ "$ATTEMPT" -le "$RETRIES" ]; do
    if ./search.sh "$TERM" --all --out "$F" >"$ERRLOG" 2>&1; then PASSED=1; break; fi
    [ "$ATTEMPT" -lt "$RETRIES" ] || break
    printf 'retry in %ss... ' "$WAIT"
    sleep "$WAIT"
    WAIT=$((WAIT*2))
    ATTEMPT=$((ATTEMPT+1))
  done

  if [ "$PASSED" = "1" ]; then
    N=$(node -e 'try{process.stdout.write(String(require(process.argv[1]).count))}catch{process.stdout.write("0")}' "$PWD/$F")
    if [ "$ATTEMPT" -gt 1 ]; then printf '%s result(s) (after %s attempts)\n' "$N" "$ATTEMPT"
    else printf '%s result(s)\n' "$N"; fi
    rm -f "$ERRLOG"
  else
    # Keep the whole thing on disk -- truncating to a one-liner is how the
    # real cause ("Error POSTing to endpoint: ...") got cut off before.
    printf 'FAILED: %s\n' "$(sed 's/\x1b\[[0-9;]*m//g' "$ERRLOG" | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-200)"
    printf '           full error: %s   |   server log: server.log\n' "$ERRLOG"
    rm -f "$F"
    FAILURES=$((FAILURES+1))
    if [ "$FAILURES" -ge 3 ] && [ "$I" -ge 3 ]; then
      warn "3 failures so far -- stopping rather than hammering a broken connection."
      warn "Check $ERRLOG and server.log, fix, then re-run with --resume to keep what worked."
      break
    fi
  fi
  [ "$I" -ge "$TOTAL" ] || sleep "$QUERY_DELAY"
done

c "Merging"
BASE=""
if [ "$APPEND" = "1" ] && [ -s "$OUT" ]; then
  BASE="$OUT"
  ok "appending into existing $OUT"
elif [ "$APPEND" = "1" ]; then
  warn "--append given but $OUT doesn't exist yet -- creating it"
fi
node -e '
const fs=require("fs"), path=require("path");
const dir=process.argv[1], out=process.argv[2], base=process.argv[3]||"";
const byId=new Map();
let files=0, carried=0;

// Seed from the existing catalogue when appending, so previously-collected
// products survive even if .bulk-raw was cleared or came from another run.
if(base && fs.existsSync(base)){
  try{
    const prev=JSON.parse(fs.readFileSync(base,"utf8"));
    for(const r of prev.results??[]){
      if(!r.spinId) continue;
      byId.set(r.spinId, {...r, matchedQueries:[...(r.matchedQueries??[])]});
      carried++;
    }
  }catch(e){ console.error("  could not read existing catalogue:", e.message); }
}
for(const f of fs.readdirSync(dir).filter(f=>f.endsWith(".json"))){
  let doc; try{ doc=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8")); }catch{ continue; }
  files++;
  for(const r of doc.results??[]){
    if(!r.spinId) continue;
    const prev=byId.get(r.spinId);
    if(prev){
      const queries=[...new Set([...(prev.matchedQueries??[]), doc.query])];
      // Fresh data wins for price/stock -- the point of re-running is to get
      // current values -- but never downgrade a direct hit to "similar".
      const wasDirect = prev.isSimilar===false;
      Object.assign(prev, r, {
        matchedQueries: queries,
        isSimilar: wasDirect ? false : r.isSimilar,
        firstSeen: prev.firstSeen ?? prev.lastSeen ?? new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      });
    } else {
      const now=new Date().toISOString();
      byId.set(r.spinId, {...r, matchedQueries:[doc.query], firstSeen:now, lastSeen:now});
    }
  }
}
const results=[...byId.values()].sort((a,b)=>String(a.product).localeCompare(String(b.product)));
fs.writeFileSync(out, JSON.stringify({
  queriesRun: files,
  carriedOver: carried,
  count: results.length,
  direct: results.filter(r=>!r.isSimilar).length,
  similar: results.filter(r=>r.isSimilar).length,
  inStock: results.filter(r=>r.inStock).length,
  fetchedAt: new Date().toISOString(),
  note: "Sample from keyword searches, not a complete catalogue. Per-store: results depend on the delivery address used.",
  results
}, null, 2));
const added=results.length-carried;
console.log(carried
  ? `  ${results.length} unique variant(s): ${carried} already there, ${added>0?`+${added} new`:"none new"} from ${files} quer(ies)`
  : `  ${results.length} unique product variant(s) from ${files} quer(ies)`);
' "$RAW" "$OUT" "$BASE"

ok "wrote $OUT"
if [ "$KEEP_RAW" = "1" ]; then
  warn "per-query files kept in $RAW/ (use --resume to reuse them)"
else
  warn "per-query files are in $RAW/ -- delete it to start clean, or use --resume to skip re-fetching"
fi
echo "  Nothing was added to your cart."
