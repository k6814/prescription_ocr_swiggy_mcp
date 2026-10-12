// Converts a natural-language shopping request into a structured list of
// items. This module does ONE job: text -> structured items; it knows nothing
// about Instamart.
//
// Model: openai/gpt-oss-20b, the small/cheap GPT-OSS on Groq. Groq deprecated
// llama-3.3-70b-versatile on 2026-06-17 and points users at gpt-oss-20b (as
// the llama-3.1-8b replacement) or gpt-oss-120b. Override with GROQ_MODEL in
// .env if that changes again -- check https://console.groq.com/docs/models.
//
// GPT-OSS models are reasoning models: by default they return a `reasoning`
// field alongside the answer, and support a reasoning_effort setting. We turn
// reasoning off and keep effort low -- extracting a shopping list needs no
// deliberation, and it keeps latency and cost down.

import Groq from "groq-sdk";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const SYSTEM_PROMPT = `You extract a shopping list from a user's natural-language request.

Return ONLY a JSON object of the form:
{"items": [
  {"query": "<everything the user said that describes the PRODUCT, kept verbatim: brand, sub-brand, strength, form. Only the count is removed>",
   "name": "<generic item name, singular, no brand/qty words>",
   "brand": "<brand name if the user specified one, else null>",
   "quantity": <number>,
   "unit": "<pack size unit if stated, e.g. 'kg', 'ml', 'ltr', 'g'; null if unspecified>"}
]}

Rules:
- One entry per distinct item the user wants added to cart.
- "query" is the MOST IMPORTANT field. It is what gets searched, so keep every
  identifying word the user gave. Never reduce a product to its generic
  ingredient or category.
    "crocin advance paracetamol 500 mg tab"
      -> query: "crocin advance paracetamol 500 mg tab", name: "paracetamol tablet", brand: "Crocin"
    "2 packs of amul taaza toned milk 1 ltr"
      -> query: "amul taaza toned milk 1 ltr", name: "milk", brand: "Amul", quantity: 2, unit: "ltr"
    "milk"
      -> query: "milk", name: "milk", brand: null, quantity: 1, unit: null
- "name" must NOT include the brand, quantity, or unit (put those in their own fields).
- "quantity" is HOW MANY the user wants to buy, not the pack size. "500 mg" and
  "1 ltr" describe the product, so they stay in "query"; quantity is 1 unless
  the user asked for several.
- If the user gives no quantity, set quantity to 1 and unit to null.
- Do not invent items, brands, or quantities the user did not state or clearly imply.
- Do not include commentary, only the JSON object.`;

/**
 * @param {string} nlText
 * @param {{apiKey?: string}} [opts]
 * @returns {Promise<Array<{query: string, name: string, brand: string|null, quantity: number, unit: string|null}>>}
 */
export async function parseShoppingList(nlText, opts = {}) {
  const client = new Groq({ apiKey: opts.apiKey ?? process.env.GROQ_API_KEY });

  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    include_reasoning: false,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: nlText },
    ],
  });

  const raw = (response.choices[0].message.content ?? "").trim();
  // Strip ```json fences if a model adds them despite response_format.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error(`Groq (${MODEL}) did not return valid JSON: ${raw.slice(0, 300)}`);
  }

  return (data.items ?? []).map((it) => ({
    // `query` drives both the Swiggy search and relevance scoring. Falling back
    // to `name` keeps older/sloppier model output working.
    query: it.query || it.name,
    name: it.name,
    brand: it.brand ?? null,
    quantity: Number(it.quantity ?? 1),
    unit: it.unit ?? null,
  }));
}
