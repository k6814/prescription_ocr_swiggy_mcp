"""
Converts a natural-language shopping request into a structured list of items
using openai/gpt-oss-20b on Groq. (llama-3.3-70b-versatile was deprecated on
2026-06-17; Groq points users at gpt-oss-20b / gpt-oss-120b. Override with the
GROQ_MODEL env var; current list at https://console.groq.com/docs/models.)

This module does ONE job: text -> structured items. It knows nothing about
Instamart's catalog, matching, or carts. Keeping it isolated means you can
unit-test extraction quality independently of the MCP/auth plumbing.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

from groq import Groq

MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b")

SYSTEM_PROMPT = """You extract a shopping list from a user's natural-language request.

Return ONLY a JSON object of the form:
{"items": [
  {"query": "<everything the user said that describes the PRODUCT, verbatim: brand, sub-brand, strength, form. Only the count is removed>",
   "name": "<generic item name, singular, no brand/qty words>",
   "brand": "<brand name if the user specified one, else null>",
   "quantity": <number>,
   "unit": "<unit as the user stated it, e.g. 'kg', 'ml', 'pack', 'liter', 'count'; null if unspecified>"}
]}

Rules:
- One entry per distinct item the user wants added to cart.
- "query" is the MOST IMPORTANT field -- it is what gets searched. Keep every
  identifying word. Never reduce a product to its generic ingredient:
  "crocin advance paracetamol 500 mg tab" -> query stays the whole phrase.
- "name" must NOT include the brand, quantity, or unit (put those in their own fields).
- If the user gives no quantity, set quantity to 1 and unit to null.
- Do not invent items, brands, or quantities the user did not state or clearly imply.
- Do not include commentary, only the JSON object.
"""


@dataclass
class ParsedItem:
    query: str
    name: str
    brand: str | None
    quantity: float
    unit: str | None


def parse_shopping_list(nl_text: str, api_key: str | None = None) -> list[ParsedItem]:
    client = Groq(api_key=api_key or os.environ["GROQ_API_KEY"])

    response = client.chat.completions.create(
        model=MODEL,
        temperature=0,
        response_format={"type": "json_object"},
        # GPT-OSS are reasoning models; we want the answer only.
        include_reasoning=False,
        reasoning_effort="low",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": nl_text},
        ],
    )

    raw = response.choices[0].message.content
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"Groq did not return valid JSON: {raw!r}") from e

    items = data.get("items", [])
    return [
        ParsedItem(
            query=it.get("query") or it["name"],
            name=it["name"],
            brand=it.get("brand"),
            quantity=float(it.get("quantity", 1)),
            unit=it.get("unit"),
        )
        for it in items
    ]


if __name__ == "__main__":
    import sys

    text = " ".join(sys.argv[1:]) or "add 2 liters of milk and a loaf of bread"
    for item in parse_shopping_list(text):
        print(item)
