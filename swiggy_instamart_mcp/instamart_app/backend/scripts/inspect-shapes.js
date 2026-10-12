// node scripts/inspect-shapes.js <user-token> [query] [addressId]
//
// If you omit addressId it uses resolution.defaultAddressId from get_addresses.
// Pass one explicitly to search against a specific address.
import "dotenv/config";
import { getConnectedClient } from "../src/instamartClient.js";
import * as store from "../src/store.js";

const userKey = store.resolveUser(process.argv[2]);
const query = process.argv[3] ?? "milk";
let addressId = process.argv[4];

if (!userKey) { console.error("usage: node scripts/inspect-shapes.js <user-token> [query] [addressId]"); process.exit(1); }
if (!store.isConnected(userKey)) { console.error("That user hasn't connected Swiggy yet."); process.exit(1); }

const client = await getConnectedClient(userKey);

console.log("#".repeat(70) + "\n# get_addresses\n" + "#".repeat(70));
const addresses = await client.callTool({ name: "get_addresses", arguments: {} });
console.log(JSON.stringify(addresses.structuredContent ?? addresses, null, 2));

if (!addressId) {
  // Real path: resolution.defaultAddressId (NOT top-level defaultAddressId).
  const sc = addresses.structuredContent ?? {};
  addressId = sc.resolution?.defaultAddressId ?? sc.addresses?.[0]?.id;
}
console.log(`\n>>> addressId for search: ${addressId ?? "(none found)"}`);
if (!addressId) { console.error("No addressId -- pass one as the 3rd argument."); process.exit(1); }

console.log("\n" + "#".repeat(70) + `\n# search_products "${query}"  <-- THE ONE WE STILL NEED\n` + "#".repeat(70));
const search = await client.callTool({ name: "search_products", arguments: { addressId, query } });
console.log(JSON.stringify(search.structuredContent ?? search, null, 2));

console.log("\n" + "#".repeat(70) + "\n# get_cart\n" + "#".repeat(70));
const cart = await client.callTool({ name: "get_cart", arguments: {} });
console.log(JSON.stringify(cart.structuredContent ?? cart, null, 2));
