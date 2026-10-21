import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { getSubscriptionPath } from "../lib/subscription.mjs";

const origin = process.argv[2];
if (!origin) {
  console.error("Usage: npm run subscription-url -- https://your-worker.workers.dev");
  process.exit(1);
}

let local = {};
try {
  local = parseEnv(await readFile(new URL("../.dev.vars", import.meta.url), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const icsURL = process.env.ICS_URL ?? local.ICS_URL;
if (!icsURL) {
  console.error("Set ICS_URL in .dev.vars or in the environment first.");
  process.exit(1);
}

const url = new URL(origin);
if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
  throw new Error("Provide the HTTP(S) origin of your Worker.");
}
console.log(new URL(await getSubscriptionPath(icsURL), url.origin).href);
