// Ranks Instamart search results against a parsed request item.
//
// WHY THIS IS NOT EXACT MATCHING ANY MORE
// ---------------------------------------
// The original design only added an item on a literal name match. Measured
// against a real `search_products "milk"` response: ZERO of 20 products have a
// displayName equal to "milk" -- the catalog is entirely branded ("Amul Cow
// Milk Packet", "Mother Dairy Toned Milk"). Strict equality therefore matches
// nothing, ever. Relaxing to substring gives 19 products / 36 variants, which
// is a match in name only -- no one picks from 36 radio buttons.
//
// So the safety property moved: nothing is auto-added unless the request
// identifies exactly one variant on its own terms (brand AND size). Otherwise
// the user picks from a SHORT ranked list. Same protection against silently
// buying the wrong thing, without pretending the catalog is something it isn't.
//
// Field names below are confirmed from a real response:
//   products[].displayName / .brand / .variations[]
//   variations[].spinId / .skuId / .quantityDescription / .price.offerPrice
//                / .isInStockAndAvailable / .maxQuantity

export const MatchStatus = Object.freeze({
  MATCHED: "matched",       // exactly one confident candidate
  AMBIGUOUS: "ambiguous",   // several plausible -- user picks
  NO_MATCH: "no_match",     // nothing usable came back
});

export const MAX_OPTIONS = 6;

export function normalize(s) {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const UNIT_ALIASES = { l: "ltr", litre: "ltr", litres: "ltr", liter: "ltr", liters: "ltr", ltr: "ltr",
                       ml: "ml", g: "g", gm: "g", gram: "g", grams: "g", kg: "kg", kgs: "kg" };

function canonSize(qty, unit) {
  if (!qty || !unit) return null;
  const u = UNIT_ALIASES[String(unit).toLowerCase()] ?? String(unit).toLowerCase();
  return `${Number(qty)} ${u}`;
}

/** "500 ml x 4" -> {size:"500 ml", packs:4}; "1 ltr" -> {size:"1 ltr", packs:1} */
function parseQuantityDescription(qd) {
  const m = normalize(qd).match(/^(.*?)\s*x\s*(\d+)$/);
  if (m) return { size: m[1].trim(), packs: Number(m[2]) };
  return { size: normalize(qd), packs: 1 };
}

function flatten(products, isSimilar = false, startRank = 0) {
  const out = [];
  let rank = startRank;
  for (const p of products) {
    for (const v of p.variations ?? []) {
      if (v.isInStockAndAvailable === false) continue; // don't offer what can't be bought
      const { size, packs } = parseQuantityDescription(v.quantityDescription);
      out.push({
        searchRank: rank++,   // Swiggy's own relevance order -- a real signal
        isSimilar,            // came from similarProducts, not direct hits
        spinId: v.spinId,
        skuId: v.skuId,
        label: `${p.displayName} — ${v.quantityDescription}`,
        productName: p.displayName,
        brand: p.brand ?? v.brandName,
        sizeText: v.quantityDescription,
        size,
        packs,
        price: v.price?.offerPrice ?? v.price?.mrp,
        mrp: v.price?.mrp,
        maxQuantity: v.maxQuantity,
        rating: v.rating?.value,
        imageUrl: v.imageUrl,
      });
    }
  }
  return out.filter((c) => c.spinId); // spinId is required by update_cart
}

/** Share of the query's words that appear in the product name. */
function relevance(cand, item) {
  const tokens = normalize(item.query ?? item.name).split(" ").filter(Boolean);
  if (tokens.length === 0) return 1;
  const hay = normalize(`${cand.productName} ${cand.brand ?? ""}`);
  return tokens.filter((t) => hay.includes(t)).length / tokens.length;
}

function score(cand, item, wantSize) {
  let s = relevance(cand, item) * 40;

  // brand the user explicitly asked for
  if (item.brand && normalize(cand.brand ?? "").includes(normalize(item.brand))) s += 35;

  // size the user explicitly asked for
  if (wantSize && cand.size === wantSize) s += 30;

  // single packs first unless the user asked for a multipack
  if (cand.packs > 1) s -= 12;

  // Tiebreak on Swiggy's own ordering, not on price -- their relevance rank
  // carries real signal, and cheapest-first was pushing odd items to the top.
  s -= cand.searchRank * 0.15;

  // similarProducts are Swiggy's "you might also like", not direct hits.
  // Worth offering (the thing you asked for is sometimes only in here), but
  // never ahead of a real result.
  if (cand.isSimilar) s -= 10;

  return s;
}

/**
 * @param {{name,brand,quantity,unit}} item   parsed request item
 * @param {Array} products                    search_products -> products
 * @returns {{status, item, options: Array}}
 */
/**
 * @param {object} item                  parsed request item
 * @param {Array}  products              search_products -> products
 * @param {Array}  [similarProducts]     search_products -> similarProducts
 *
 * search_products returns TWO arrays. In a real response for "Amul Taaza Toned
 * Milk 1 ltr", `products` held 3 entries and `similarProducts` held 18 --
 * including other milks the user might well have meant. Reading only
 * `products` silently discards most of the catalogue's answer.
 */
/**
 * Swiggy caps how many of a variant can go in one order, and the cap varies
 * wildly between variants of the SAME product (a "1 ltr x 6" pack was limited
 * to 1 while the plain "1 ltr" allowed 20). Requesting more than the cap gets
 * rejected at update_cart, so clamp here and tell the UI it happened.
 */
function capped(options, item) {
  const want = Number(item.quantity ?? 1) || 1;
  return options.map((o) => {
    const max = typeof o.maxQuantity === "number" ? o.maxQuantity : Infinity;
    const allowed = Math.max(1, Math.min(want, max));
    return { ...o, requestedQuantity: want, quantity: allowed, quantityCapped: allowed < want };
  });
}

export function findMatch(item, products, similarProducts) {
  const direct = flatten(products ?? [], false, 0);
  const candidates = direct.concat(flatten(similarProducts ?? [], true, direct.length));
  if (candidates.length === 0) return { status: MatchStatus.NO_MATCH, item, options: [] };

  const wantSize = canonSize(item.quantity, item.unit);

  // Relevance floor: if none of the query's words appear in a product's name,
  // it is not an answer to the question. Without this, a search that returns
  // unrelated stock still produces a confident-looking list -- e.g. asking for
  // "chocolate" and being offered six milks.
  const relevant = candidates.filter((c) => relevance(c, item) > 0);
  if (relevant.length === 0) return { status: MatchStatus.NO_MATCH, item, options: [] };

  const ranked = relevant
    .map((c) => ({ ...c, _score: score(c, item, wantSize) }))
    .sort((a, b) => b._score - a._score);

  // TIER 1 -- the fast path. You typed a product's actual catalogue name, so
  // skip the picker. Matches either the bare product name ("Amul Cow Milk
  // Packet") or name-with-size as one string ("Amul Taaza Toned Milk 1 ltr").
  //
  // Name alone is NOT always enough: products with multipacks share one
  // displayName across variants ("Amul Taaza Toned Milk" covers 1 ltr, x4 and
  // x6), so we only auto-resolve when exactly one variant survives.
  const q = normalize(item.query ?? item.name);
  let exact = relevant.filter(
    (c) => normalize(c.productName) === q || normalize(`${c.productName} ${c.sizeText}`) === q
  );
  if (exact.length > 1 && wantSize) {
    const sized = exact.filter((c) => c.size === wantSize);
    if (sized.length) exact = sized;
  }
  // A multipack's unit size equals the single's ("1 ltr x 6" -> size "1 ltr"),
  // so the size filter alone cannot separate them. Unless the request actually
  // asked for a multipack, prefer the single pack.
  if (exact.length > 1) {
    const singles = exact.filter((c) => c.packs === 1);
    if (singles.length === 1 && !/\bx\s*\d+\b/.test(normalize(item.name))) exact = singles;
  }
  if (exact.length === 1) return { status: MatchStatus.MATCHED, item, options: capped(exact, item) };
  if (exact.length > 1) {
    // Right product, undecided size -- offer only its own variants, nothing else.
    return { status: MatchStatus.AMBIGUOUS, item, options: exact.slice(0, MAX_OPTIONS) };
  }

  // TIER 2 -- one candidate contains EVERY word you asked for, and no other
  // does. "Crocin Advance" appears in full only in "Crocin Advance Paracetamol
  // 500mg Tablet"; "Crocin 650" is missing "advance", "Saridon Advance" is
  // missing "crocin". That uniqueness is as good as an exact match.
  //
  // Vague queries are unaffected: for "milk", a dozen products contain the
  // whole query, so this never fires and you still get the picker.
  let full = relevant.filter((c) => relevance(c, item) === 1);
  if (full.length > 1) {
    // All variants of ONE product: narrow by stated size, then prefer singles.
    const sameProduct = full.every((c) => c.productName === full[0].productName);
    if (sameProduct) {
      if (wantSize) {
        const sized = full.filter((c) => c.size === wantSize);
        if (sized.length) full = sized;
      }
      if (full.length > 1 && !/\bx\s*\d+\b/.test(normalize(item.query ?? item.name))) {
        const singles = full.filter((c) => c.packs === 1);
        if (singles.length === 1) full = singles;
      }
    }
  }
  if (full.length === 1) return { status: MatchStatus.MATCHED, item, options: capped(full, item) };

  // TIER 3 -- brand AND size given, and exactly one in-stock variant fits both.
  if (item.brand && wantSize) {
    const pinned = ranked.filter(
      (c) => normalize(c.brand ?? "").includes(normalize(item.brand)) && c.size === wantSize
    );
    if (pinned.length === 1) return { status: MatchStatus.MATCHED, item, options: capped([pinned[0]], item) };
  }

  // A single candidate overall is also unambiguous.
  if (ranked.length === 1) return { status: MatchStatus.MATCHED, item, options: capped(ranked, item) };

  return { status: MatchStatus.AMBIGUOUS, item, options: capped(ranked.slice(0, MAX_OPTIONS), item) };
}
