// Issue a personal token to a friend:
//     node scripts/add-user.js kevin
// Prints the token ONCE. Send it to them over something private (Signal, not
// a group chat). Only its SHA-256 is stored, so it cannot be recovered later
// -- if they lose it, remove and re-add.
//
//     node scripts/add-user.js --list
//     node scripts/add-user.js --remove kevin

import "dotenv/config";
import * as store from "../src/store.js";
import { newUserToken } from "../src/crypto.js";

const [, , arg, arg2] = process.argv;

if (arg === "--list") {
  console.table(store.listUsers());
} else if (arg === "--remove") {
  if (!arg2) { console.error("usage: --remove <id>"); process.exit(1); }
  store.removeUser(arg2);
  console.log(`removed ${arg2}`);
} else if (arg) {
  const token = newUserToken();
  store.addUser(arg, token);
  console.log(`\nUser:  ${arg}`);
  console.log(`Token: ${token}`);
  console.log(`\nThey paste this into the app once. Shown only now.\n`);
} else {
  console.error("usage: node scripts/add-user.js <id> | --list | --remove <id>");
  process.exit(1);
}
