// Unwraps a Swiggy MCP tool result.
//
// Verified against real responses:
//  - Success: `structuredContent` holds the payload DIRECTLY (e.g. {addresses,
//    pagination, resolution}) -- there is no {success, data} wrapper on the
//    happy path.
//  - Failure: `isError: true` at the top level AND
//    `structuredContent: {success: false, error: {message, reportId}}`.
//  - `content` may contain MULTIPLE text blocks: get_cart returns prose first
//    and JSON second, so "first text block" is not a safe way to find data.
//
// The failure check must come BEFORE returning structuredContent, or an error
// payload gets handed to the caller as if it were real data.

export function unwrap(toolResult) {
  const sc = toolResult.structuredContent;

  // --- failures first ---
  if (toolResult.isError || sc?.success === false) {
    const err = sc?.error ?? {};
    const e = new Error(err.message ?? textOf(toolResult) ?? "Swiggy tool failed");
    e.reportId = err.reportId;
    e.retryable = sc?.retryable ?? false;
    throw e;
  }

  if (sc) return sc.data ?? sc;

  // --- no structuredContent: fall back to text blocks, preferring JSON ---
  const blocks = (toolResult.content ?? []).filter((c) => c.type === "text");
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b.text);
      if (parsed.success === false) throw new Error(parsed.error?.message ?? "Swiggy tool failed");
      return parsed.data ?? parsed;
    } catch (e) {
      if (e.message !== "Unexpected end of JSON input" && !(e instanceof SyntaxError)) throw e;
      // not JSON -- try the next block
    }
  }
  if (blocks.length) return blocks[blocks.length - 1].text; // prose only
  throw new Error(`Unrecognised tool result: ${JSON.stringify(toolResult).slice(0, 300)}`);
}

function textOf(r) {
  return (r.content ?? []).find((c) => c.type === "text")?.text;
}
