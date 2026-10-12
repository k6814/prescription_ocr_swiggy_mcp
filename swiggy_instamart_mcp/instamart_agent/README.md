# Instamart NL Cart Agent

Groq parses a natural-language shopping request into structured items;
this script searches Swiggy Instamart's MCP server for each one and only
adds it to cart on a strict, literal-equality match. Anything ambiguous or
unmatched is reported, never guessed.

## What's confirmed vs. not

Sourced from Swiggy's real developer docs (fetched directly, not recalled):

| Fact | Status | Source |
|---|---|---|
| Builders Club program exists; localhost/staging dev needs no approval | Confirmed | mcp.swiggy.com/builders, .../docs/start/developer/index.md |
| OAuth 2.1 + PKCE + Dynamic Client Registration at `/auth/register` | Confirmed | .../docs/start/authenticate.md |
| Instamart cart tools: `get_cart`, `update_cart`, `clear_cart` | Confirmed | .../docs/build/agent-patterns/multi-turn-state/ |
| Order tools: `get_orders`, `get_order_details`, `track_order` | Confirmed | .../docs/reference/instamart/{track_order,get_order_details}/ |
| Instamart product-search tool name and arguments | **Not confirmed** | not found in retrievable docs -- get it from `discover_tools.py` |
| `update_cart`'s exact line-item argument shape | **Not confirmed** | Food's equivalent (`update_food_cart`) uses `cartItems: [{itemId, quantity}]`, but Instamart's isn't necessarily the same |
| Staging vs. production endpoint hostname | **Not confirmed** | quickstart mentions "a staging endpoint" without naming it in what I could retrieve |
| Consumer redirect URI whitelist has no port number (`http://localhost/callback`) | Confirmed | github.com/Swiggy/swiggy-mcp-server-manifest |

Don't trust the two "not confirmed" rows as fact -- they're deliberately left
as `None` / flagged in the code so the script fails loudly instead of
silently calling something invented.

## Setup

```bash
pip install -r requirements.txt
export GROQ_API_KEY=gsk_...
```

1. **Run discovery first, before anything else:**
   ```bash
   sudo python discover_tools.py   # sudo because CALLBACK_PORT defaults to 80 -- see instamart_client.py
   ```
   This opens a browser for Swiggy login (phone + OTP) and prints every real
   tool name and JSON schema Instamart's MCP server exposes.

2. Open `main.py`, find `SEARCH_TOOL_NAME` and `SEARCH_QUERY_ARG` near the
   top, and fill them in from what step 1 printed. Also check
   `update_cart`'s printed schema against the `cartItems` shape used in
   `main.py` and adjust if it differs.

3. Run it:
   ```bash
   python main.py "add 2 liters of milk and a loaf of bread"
   ```

## Why nothing here is fully automatic yet

Two things intentionally block a first run:
- `discover_tools.py` must be run and read by a human before `main.py` will
  do anything, because the search tool's identity isn't guessed.
- `main.py` exits with an explicit message if `SEARCH_TOOL_NAME` is still
  `None`, rather than trying a plausible-looking name.

This is slower than shipping a guess, but a wrong guess here either throws
an opaque error (best case) or -- if a guessed argument name happens to be
accepted by a different tool -- silently does the wrong thing to a real,
non-cancellable COD order (worst case). Given that stakes, the slower path
is the right one.

## Known friction points to expect

- **Port 80 for the OAuth callback.** The whitelisted redirect URI has no
  port number. If Swiggy's auth server matches redirect URIs exactly, you
  need to bind the local callback listener to port 80, which needs elevated
  privileges. If it fails, try running with `sudo`/admin, or email
  `builders@swiggy.in` to ask about a non-standard-port redirect for
  development.
- **"Exact match" will often mean "no match."** By design. A generic query
  like "milk" won't literally equal a catalog title like "Amul Taaza Toned
  Milk 500ml Pouch." Decide deliberately whether you want to set
  `STRICT_MATCH = False` in `main.py` (substring matching, still
  deterministic, not fuzzy) or handle "no match" items by prompting
  yourself for the exact product name.
- **`place_food_order`-equivalent calls are not idempotent** (documented for
  Food; assume the same for Instamart's order-placement tool once you find
  its name). If a cart-mutating or order-placing call fails with a 5xx, call
  `get_cart` / `get_orders` to check real state before retrying, rather than
  blindly retrying the mutation.
