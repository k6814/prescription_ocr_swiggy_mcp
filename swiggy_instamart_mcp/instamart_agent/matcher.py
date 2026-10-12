"""
Matches a parsed shopping-list item against Instamart search results.

Design decision (per earlier discussion): "exact match" is defined as
case/whitespace/punctuation-insensitive EQUALITY between the item name Groq
extracted and a candidate product's title -- not substring containment, not
fuzzy/similarity scoring. This is deliberately strict:

  - Real catalogs rarely have literal matches for generic terms ("milk" won't
    equal "Amul Taaza Toned Milk 500ml Pouch"), so expect "no_match" often.
  - When it does match, you can trust it without a human in the loop.
  - The relaxed tier (strict=False) is opt-in and is substring matching, not
    fuzzy matching -- still deterministic and auditable, just looser.

Nothing here is auto-added to cart on anything less than "matched". That
decision belongs in main.py, but the matcher enforces it can't accidentally
report false confidence.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

from groq_parser import ParsedItem


def normalize(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


class MatchStatus(Enum):
    MATCHED = "matched"        # exactly one confident candidate -- safe to auto-add
    AMBIGUOUS = "ambiguous"    # multiple candidates tied -- needs human choice
    NO_MATCH = "no_match"      # nothing met the bar -- needs human choice


@dataclass
class MatchResult:
    status: MatchStatus
    item: ParsedItem
    candidates: list[dict]  # empty, one (MATCHED), or several (AMBIGUOUS)


def find_match(
    item: ParsedItem,
    search_results: list[dict],
    title_field: str = "name",
    strict: bool = True,
) -> MatchResult:
    """
    search_results: raw candidate dicts from Instamart's product-search tool.
    title_field: the key holding the product's display name in those dicts --
        VERIFY this against the real response shape (see discover_tools.py /
        main.py TODOs). "name" is a guess based on common convention, not a
        confirmed field name.
    """
    query_norm = normalize(item.name)

    exact = [c for c in search_results if normalize(c.get(title_field, "")) == query_norm]
    if len(exact) == 1:
        return MatchResult(MatchStatus.MATCHED, item, exact)
    if len(exact) > 1:
        return MatchResult(MatchStatus.AMBIGUOUS, item, exact)

    if not strict:
        contains = [
            c for c in search_results
            if query_norm and query_norm in normalize(c.get(title_field, ""))
        ]
        if len(contains) == 1:
            return MatchResult(MatchStatus.MATCHED, item, contains)
        if len(contains) > 1:
            return MatchResult(MatchStatus.AMBIGUOUS, item, contains)

    return MatchResult(MatchStatus.NO_MATCH, item, [])
