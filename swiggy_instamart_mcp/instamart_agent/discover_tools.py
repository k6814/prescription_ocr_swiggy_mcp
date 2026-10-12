"""
Run this before anything else:

    python discover_tools.py

It authenticates (opens a browser for Swiggy phone+OTP login) and prints
every tool the Instamart MCP server actually exposes, with its real
parameter schema. Confirmed from Swiggy's own docs going in: `get_cart`,
`update_cart`, `clear_cart`, `get_orders`, `get_order_details`, `track_order`.
NOT confirmed: the product-search tool's name and argument shape, and
`update_cart`'s exact line-item format -- read those from this script's
output, not from a guess, then fill in the two constants at the top of
main.py.
"""

import asyncio
import json

from instamart_client import InstamartClient


async def main():
    async with InstamartClient() as client:
        result = await client.list_tools()
        for tool in result.tools:
            print("=" * 70)
            print(f"name: {tool.name}")
            print(f"description: {tool.description}")
            print("input_schema:")
            print(json.dumps(tool.inputSchema, indent=2))
            print()


if __name__ == "__main__":
    asyncio.run(main())
