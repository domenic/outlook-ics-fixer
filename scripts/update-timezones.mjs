import { mkdir, writeFile } from "node:fs/promises";
import tzdata from "tzdata" with { type: "json" };

const aliases = {};
const zones = {};
const names = Object.keys(tzdata.zones).filter(name => name !== "Factory").sort();
const canonicalNames = names.filter(name => typeof tzdata.zones[name] !== "string");

for (const name of names) {
  let canonical = name;
  while (typeof tzdata.zones[canonical] === "string") {
    canonical = tzdata.zones[canonical];
  }
  if (canonical !== name) {
    aliases[name] = canonical;
  }
}

// Fetch complete historical definitions, not the simplified `zoneinfo-outlook` rules.
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < canonicalNames.length) {
    const name = canonicalNames[next++];
    const url = `https://www.tzurl.org/zoneinfo/${name.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`Could not download ${name}: HTTP ${response.status}`);
    }
    const text = (await response.text()).replace(/\r\n/g, "\n");
    if (!text.includes(`PRODID:-//tzurl.org//NONSGML Olson ${tzdata.version}//EN\n`)) {
      throw new Error(`tzurl.org and the installed tzdata package must both use ${tzdata.version}`);
    }
    const block = text.match(/^BEGIN:VTIMEZONE\n[\s\S]*?^END:VTIMEZONE$/m)?.[0];
    if (!block || !block.includes(`\nTZID:${name}\n`)) {
      throw new Error(`Invalid timezone definition for ${name}`);
    }
    zones[name] = block;
  }
}));

const data = {
  version: tzdata.version,
  source: "https://www.tzurl.org/zoneinfo/",
  aliases,
  zones: Object.fromEntries(Object.entries(zones).sort(([a], [b]) => a.localeCompare(b, "en")))
};
await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(new URL("../data/timezones.json", import.meta.url), JSON.stringify(data, undefined, 2) + "\n");
console.log(`Updated ${Object.keys(zones).length} timezones and ${Object.keys(aliases).length} aliases to tzdb ${tzdata.version}`);
