import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { list } from "tar";
import ICAL from "ical.js";

const tzurl = "https://www.tzurl.org/zoneinfo/";
const ianaFiles = ["africa", "antarctica", "asia", "australasia", "europe", "northamerica", "southamerica", "etcetera", "backward"];

class ReleaseChangedError extends Error {}

async function request(fetchImpl, url) {
  for (let attempt = 0; ; ++attempt) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), cache: "no-store" });
      if (response.ok) return response;
      await response.body?.cancel();
      if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
        await setTimeout(500 * (attempt + 1));
        continue;
      }
      throw new Error(`Could not download ${url}: HTTP ${response.status}`);
    } catch (error) {
      if (attempt < 2 && (error instanceof TypeError || error.name === "TimeoutError")) {
        await setTimeout(500 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

async function readArchive(response, paths) {
  const bytes = Buffer.from(await response.arrayBuffer());
  const files = new Map();
  await new Promise((resolve, reject) => {
    // Read only the requested files into memory; never extract archive paths to disk.
    const parser = list({ strict: true, onReadEntry(entry) {
      if (entry.type !== "File" || !paths.includes(entry.path)) return;
      const chunks = [];
      entry.on("data", chunk => chunks.push(chunk));
      entry.on("end", () => files.set(entry.path, Buffer.concat(chunks).toString("utf8")));
    } });
    parser.on("error", reject);
    parser.on("end", resolve);
    parser.end(bytes);
  });
  for (const path of paths) {
    if (!files.has(path)) throw new Error(`Downloaded archive is missing ${path}`);
  }
  return files;
}

function releaseVersion(calendar) {
  const version = calendar.match(/^PRODID:-\/\/tzurl\.org\/\/NONSGML Olson (\d{4}[a-z]+)\/\/EN\r?$/m)?.[1];
  if (!version) throw new Error("tzurl.org returned a calendar without a recognized tzdb version");
  return version;
}

function parseIANANames(files) {
  const zones = new Set();
  const links = new Map();
  for (const file of ianaFiles) {
    for (const line of files.get(file).split("\n")) {
      const [type, first, second] = line.split("#", 1)[0].trim().split(/\s+/);
      if (type === "Zone") zones.add(first);
      if (type === "Link") links.set(second, first);
    }
  }
  // `Factory` is an unspecified local time zone, not a usable calendar time zone.
  zones.delete("Factory");
  const aliases = new Map();
  for (const name of links.keys()) {
    const visited = new Set();
    let target = name;
    while (links.has(target)) {
      if (visited.has(target)) throw new Error(`Circular IANA time zone alias: ${name}`);
      visited.add(target);
      target = links.get(target);
    }
    if (!zones.has(target)) throw new Error(`IANA time zone alias ${name} refers to missing zone ${target}`);
    aliases.set(name, target);
  }
  if (zones.size === 0) throw new Error("The IANA archive contains no time zones");
  return { names: [...zones].sort(), aliases: Object.fromEntries([...aliases].sort()) };
}

function timeZoneBlock(calendar, name, version) {
  if (releaseVersion(calendar) !== version) {
    throw new ReleaseChangedError("tzurl.org changed releases during the download");
  }
  const normalized = calendar.replaceAll("\r\n", "\n");
  const block = normalized.match(/^BEGIN:VTIMEZONE\n[\s\S]*?^END:VTIMEZONE$/m)?.[0];
  if (!block) throw new Error(`Missing time zone definition for ${name}`);
  const component = new ICAL.Component(ICAL.parse(block));
  if (component.name !== "vtimezone" || component.getFirstPropertyValue("tzid") !== name) {
    throw new Error(`Invalid time zone definition for ${name}`);
  }
  const observances = component.getAllSubcomponents();
  if (observances.length === 0) throw new Error(`Missing time zone observances for ${name}`);
  for (const observance of observances) {
    if (!["standard", "daylight"].includes(observance.name) ||
        !observance.getFirstPropertyValue("dtstart") ||
        !observance.getFirstPropertyValue("tzoffsetfrom") ||
        !observance.getFirstPropertyValue("tzoffsetto")) {
      throw new Error(`Invalid time zone observance for ${name}`);
    }
    // Decode recurrence properties too, so malformed rules fail before deployment.
    for (const property of observance.getAllProperties()) property.getValues();
  }
  return block;
}

async function downloadDefinitions(fetchImpl) {
  const utcCalendar = await (await request(fetchImpl, `${tzurl}Etc/UTC`)).text();
  const version = releaseVersion(utcCalendar);
  const archive = await request(fetchImpl, `https://data.iana.org/time-zones/releases/tzdata${version}.tar.gz`);
  const files = await readArchive(archive, ["version", ...ianaFiles]);
  if (files.get("version").trim() !== version) throw new Error("IANA archive has an unexpected version");
  const { names, aliases } = parseIANANames(files);
  const zones = new Map();
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < names.length && !failure) {
      const name = names[next++];
      try {
        const calendar = name === "Etc/UTC" ? utcCalendar : await (await request(fetchImpl,
          `${tzurl}${name.split("/").map(encodeURIComponent).join("/")}`)).text();
        zones.set(name, timeZoneBlock(calendar, name, version));
      } catch (error) {
        failure ??= error;
      }
    }
  }));
  if (failure) throw failure;
  return { version, source: tzurl, aliases, zones: Object.fromEntries([...zones].sort()) };
}

async function downloadWindowsMappings(fetchImpl) {
  // Resolve the current published release independently of `package-lock.json`.
  const metadata = await (await request(fetchImpl, "https://registry.npmjs.org/cldr-core/latest")).json();
  if (metadata.name !== "cldr-core" || typeof metadata.version !== "string" ||
      typeof metadata.dist?.tarball !== "string" || !metadata.dist.tarball.startsWith("https://registry.npmjs.org/")) {
    throw new Error("Invalid cldr-core release metadata");
  }
  const files = await readArchive(await request(fetchImpl, metadata.dist.tarball), [
    "package/package.json", "package/supplemental/windowsZones.json"
  ]);
  const manifest = JSON.parse(files.get("package/package.json"));
  if (manifest.name !== "cldr-core" || manifest.version !== metadata.version) {
    throw new Error("The CLDR archive does not match its release metadata");
  }
  const cldr = JSON.parse(files.get("package/supplemental/windowsZones.json"));
  const mappings = new Map();
  for (const { mapZone } of cldr.supplemental.windowsZones.mapTimezones) {
    if (mapZone._territory === "001") {
      if (typeof mapZone._other !== "string" || typeof mapZone._type !== "string") {
        throw new Error("Invalid Windows time zone mapping in CLDR");
      }
      mappings.set(mapZone._other, mapZone._type);
    }
  }
  if (mappings.size === 0) throw new Error("CLDR contains no default Windows time zone mappings");
  // Retain this legacy Windows identifier, which is no longer included in CLDR.
  mappings.set("Mid-Atlantic Standard Time", "Etc/GMT+2");
  return { cldrVersion: metadata.version, windows: Object.fromEntries([...mappings].sort()) };
}

export async function downloadTimeZoneData({ fetchImpl = globalThis.fetch } = {}) {
  let definitions;
  for (let attempt = 0; attempt < 3; ++attempt) {
    try {
      definitions = await downloadDefinitions(fetchImpl);
      break;
    } catch (error) {
      if (!(error instanceof ReleaseChangedError)) throw error;
      if (attempt === 2) throw new Error("tzurl.org is updating its data. Try deploying again in a few minutes.", { cause: error });
    }
  }
  const { cldrVersion, windows } = await downloadWindowsMappings(fetchImpl);
  for (const [name, iana] of Object.entries(windows)) {
    const canonical = Object.hasOwn(definitions.aliases, iana) ? definitions.aliases[iana] : iana;
    if (!Object.hasOwn(definitions.zones, canonical)) {
      throw new Error(`CLDR maps ${name} to ${iana}, which tzurl.org does not yet provide. Try deploying again after tzurl.org updates.`);
    }
  }
  const data = { ...definitions, cldrVersion, windows };
  // Include mappings and definitions so any data correction invalidates cached repairs.
  data.revision = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  return data;
}
