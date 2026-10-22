import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { downloadTimeZoneData } from "./time-zone-data.mjs";

export async function buildTimeZones({ rootURL = new URL("../", import.meta.url), fetchImpl = globalThis.fetch } = {}) {
  const data = await downloadTimeZoneData({ fetchImpl });
  const directory = new URL(".generated/", rootURL);
  await mkdir(directory, { recursive: true });
  const temporaryURL = new URL(`time-zones-${randomUUID()}.tmp`, directory);
  try {
    await writeFile(temporaryURL, JSON.stringify(data, undefined, 2) + "\n");
    await rename(temporaryURL, new URL("time-zones.json", directory));
  } finally {
    await rm(temporaryURL, { force: true });
  }
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("Downloading current time zone definitions and Windows mappings...");
  try {
    const data = await buildTimeZones();
    console.log(`Prepared tzdb ${data.version} (${Object.keys(data.zones).length} zones, ${Object.keys(data.aliases).length} aliases) and CLDR ${data.cldrVersion}`);
  } catch (error) {
    console.error(`Unable to prepare time zone data: ${error.message}`);
    process.exitCode = 1;
  }
}
