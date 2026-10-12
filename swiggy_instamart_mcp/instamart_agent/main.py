"""
Wires the pieces together. Run `python discover_tools.py` first and fill in
the two constants marked FILL ME IN below from its real output -- this
script refuses to run with placeholders left in place, on purpose, so it
can't silently call a tool name that was never confirmed.
"""

import asyncio
import sys

from groq_parser import parse_shopping_list
from instamart_client import InstamartClient
from matcher import MatchStatus, find_match

# --- FILL ME IN from `python discover_tools.py` output ---
SEARCH_TOOL_NAME = None          # e.g. "search_products" -- confirm, don't assume
SEARCH_QUERY_ARG = None          # e.g. "query" -- the search tool's query parameter name
PRODUCT_TITLE_FIELD = "name"     # the field in a search result holding the display name
PRODUCT_ID_FIELD = "id"          # the field in a search result holding the product id
# -----------------------------------------------------------

# Confirmed from https://mcp.swiggy.com/builders/docs/start/authenticate.md
# and https://mcp.swiggy.com/builders/docs/build/agent-patterns/multi-turn-state/
CART_UPDATE_TOOL = "update_cart"
CART_GET_TOOL = "get_cart"

STRICT_MATCH = True  # False enables the substring fallback tier -- see matcher.py


async def run(nl_request: str):
    if SEARCH_TOOL_NAME is None:
        sys.exit(
            "SEARCH_TOOL_NAME is not set. Run `python discover_tools.py`, "
            "find the real product-search tool in its output, and fill in "
            "SEARCH_TOOL_NAME / SEARCH_QUERY_ARG at the top of main.py."
        )

    items = parse_shopping_list(nl_request)
    print(f"Groq parsed {len(items)} item(s):")
    for it in items:
        print(f"  - {it}")

    async with InstamartClient() as client:
        for item in items:
            search_result = await client.call_tool(
                SEARCH_TOOL_NAME, {SEARCH_QUERY_ARG: item.name}
            )
            # NOTE: the shape of search_result.content is also unconfirmed --
            # adjust this extraction once you've seen a real response from
            # discover_tools.py / a manual test call.
            candidates = search_result.content  # placeholder extraction

            match = find_match(
                item, candidates, title_field=PRODUCT_TITLE_FIELD, strict=STRICT_MATCH
            )

            if match.status == MatchStatus.MATCHED:
                product = match.candidates[0]
                print(f"MATCHED '{item.name}' -> {product}")
                await client.call_tool(
                    CART_UPDATE_TOOL,
                    {
                        # Unconfirmed argument shape -- Food's equivalent
                        # (update_food_cart) takes a `cartItems` array of
                        # {itemId, quantity}; verify Instamart's actual shape
                        # via discover_tools.py before trusting this.
                        "cartItems": [
                            {"productId": product[PRODUCT_ID_FIELD], "quantity": item.quantity}
                        ]
                    },
                )
                print("  -> added to cart.")

            elif match.status == MatchStatus.AMBIGUOUS:
                print(f"AMBIGUOUS for '{item.name}' -- not adding. Candidates:")
                for c in match.candidates:
                    print(f"    - {c}")

            else:
                print(f"NO EXACT MATCH for '{item.name}' -- not adding.")

        cart = await client.call_tool(CART_GET_TOOL, {})
        print("\nFinal cart state:")
        print(cart.content)


if __name__ == "__main__":
    request = " ".join(sys.argv[1:]) or input("What do you want to add to cart? ")
    asyncio.run(run(request))
