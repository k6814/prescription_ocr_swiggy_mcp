// node scripts/discover-tools.js <user-token>
import "dotenv/config";
import { getConnectedClient } from "../src/instamartClient.js";
import * as store from "../src/store.js";

const userKey = store.resolveUser(process.argv[2]);
if (!userKey) { console.error("usage: node scripts/discover-tools.js <user-token>"); process.exit(1); }
if (!store.isConnected(userKey)) { console.error("That user hasn't connected Swiggy yet."); process.exit(1); }

const client = await getConnectedClient(userKey);
const { tools } = await client.listTools();
for (const t of tools) {
  console.log("=".repeat(70));
  console.log(`name: ${t.name}`);
  console.log(`description: ${t.description}`);
  console.log("input_schema:");
  console.log(JSON.stringify(t.inputSchema, null, 2));
  console.log();
}
