import { copyFile, writeFile } from "node:fs/promises";
import cldr from "cldr-core/supplemental/windowsZones.json" with { type: "json" };

const mappings = Object.fromEntries(cldr.supplemental.windowsZones.mapTimezones
  .map(({ mapZone }) => mapZone)
  .filter(zone => zone._territory === "001")
  .map(zone => [zone._other, zone._type]));
// Retain this legacy Windows identifier, which is no longer included in CLDR.
mappings["Mid-Atlantic Standard Time"] = "Etc/GMT+2";
const sorted = Object.fromEntries(Object.entries(mappings).sort(([a], [b]) => a.localeCompare(b, "en")));
const source = `// Unicode CLDR ${cldr.supplemental.version._cldrVersion}, territory 001. See \`UNICODE-LICENSE.txt\`.\n\nexport default ${JSON.stringify(sorted, undefined, 2)};\n`;
await writeFile(new URL("../lib/windows-to-iana.mjs", import.meta.url), source);
await copyFile(new URL("../node_modules/cldr-core/LICENSE", import.meta.url), new URL("../UNICODE-LICENSE.txt", import.meta.url));
console.log(`Updated ${Object.keys(sorted).length} Windows timezone mappings`);
