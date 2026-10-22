import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { create } from "tar";
import { downloadTimeZoneData } from "../scripts/time-zone-data.mjs";
import { buildTimeZones } from "../scripts/build-time-zones.mjs";

const tzurl = "https://www.tzurl.org/zoneinfo/";
const originalLicense = "Project license\n";
const names = ["Etc/UTC", "Etc/GMT+2", "Test/New_Zone"];

function calendar(name, version) {
  return [
    "BEGIN:VCALENDAR", `PRODID:-//tzurl.org//NONSGML Olson ${version}//EN`, "VERSION:2.0",
    "BEGIN:VTIMEZONE", `TZID:${name}`, "BEGIN:STANDARD", "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0000", "TZOFFSETTO:+0000", "END:STANDARD", "END:VTIMEZONE", "END:VCALENDAR"
  ].join("\r\n");
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "outlook-ics-fixer-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function archive(t, files) {
  const directory = await temporaryDirectory(t);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  const chunks = [];
  for await (const chunk of create({ gzip: true, cwd: directory }, Object.keys(files))) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function sources(t, version = "2036z", mappings = { "Future Standard Time": "Old/Name" }) {
  const cldrVersion = "99.0.0";
  const cldrTarball = `https://registry.npmjs.org/cldr-core/-/cldr-core-${cldrVersion}.tgz`;
  const iana = await archive(t, {
    version, africa: "", antarctica: "", asia: "", australasia: "", europe: "", northamerica: "", southamerica: "",
    etcetera: names.map(name => `Zone ${name} 0 - UTC`).join("\n"),
    backward: "Link Old/Intermediate Old/Name\nLink Test/New_Zone Old/Intermediate\n"
  });
  const cldr = await archive(t, {
    "package/package.json": JSON.stringify({ name: "cldr-core", version: cldrVersion }),
    "package/supplemental/windowsZones.json": JSON.stringify({ supplemental: { windowsZones: {
      mapTimezones: [
        ...Object.entries(mappings).map(([name, target]) => ({ mapZone: { _territory: "001", _other: name, _type: target } })),
        { mapZone: { _territory: "US", _other: "Future Standard Time", _type: "Unused/Regional_Zone" } }
      ]
    } } })
  });
  const routes = new Map([
    [`https://data.iana.org/time-zones/releases/tzdata${version}.tar.gz`, () => new Response(iana)],
    ["https://registry.npmjs.org/cldr-core/latest", () => Response.json({ name: "cldr-core", version: cldrVersion, dist: { tarball: cldrTarball } })],
    [cldrTarball, () => new Response(cldr)],
    ...names.map(name => [`${tzurl}${name}`, () => new Response(calendar(name, version))])
  ]);
  const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    const route = decodeURIComponent(url);
    assert.ok(routes.has(route), `Unexpected download: ${url}`);
    return routes.get(route)();
  };
  return { routes, requests, fetchImpl };
}

it("discovers future tzdb and CLDR releases, including new zones and chained aliases", async t => {
  const source = await sources(t);
  const data = await downloadTimeZoneData(source);
  assert.equal(data.version, "2036z");
  assert.equal(data.cldrVersion, "99.0.0");
  assert.equal(data.aliases["Old/Name"], "Test/New_Zone");
  assert.equal(data.aliases["Old/Intermediate"], "Test/New_Zone");
  assert.equal(data.windows["Future Standard Time"], "Old/Name");
  assert.equal(data.windows["Mid-Atlantic Standard Time"], "Etc/GMT+2");
  assert.deepEqual(Object.keys(data.zones), [...names].sort());
  assert.match(data.revision, /^[a-f0-9]{64}$/);
  assert.ok(source.requests.includes("https://data.iana.org/time-zones/releases/tzdata2036z.tar.gz"));
});

it("changes the cache revision when mappings change within the same releases", async t => {
  const first = await downloadTimeZoneData(await sources(t));
  const second = await downloadTimeZoneData(await sources(t, "2036z", { "Future Standard Time": "Etc/UTC" }));
  assert.equal(first.version, second.version);
  assert.equal(first.cldrVersion, second.cldrVersion);
  assert.notEqual(first.revision, second.revision);
});

it("restarts the download if tzurl.org switches releases partway through", async t => {
  const before = await sources(t, "2036z");
  const after = await sources(t, "2037a");
  let utcRequests = 0;
  after.routes.set(`${tzurl}Etc/UTC`, () => new Response(calendar("Etc/UTC", ++utcRequests === 1 ? "2036z" : "2037a")));
  after.routes.set("https://data.iana.org/time-zones/releases/tzdata2036z.tar.gz",
    before.routes.get("https://data.iana.org/time-zones/releases/tzdata2036z.tar.gz"));
  const data = await downloadTimeZoneData(after);
  assert.equal(data.version, "2037a");
  assert.equal(utcRequests, 2);
  assert.ok(Object.values(data.zones).every(block => block.includes("BEGIN:VTIMEZONE")));
});

it("stops with an actionable error if releases keep changing", async t => {
  const source = await sources(t);
  source.routes.set(`${tzurl}Test/New_Zone`, () => new Response(calendar("Test/New_Zone", "2037a")));
  await assert.rejects(downloadTimeZoneData(source), /Try deploying again in a few minutes/);
  assert.equal(source.requests.filter(url => url === `${tzurl}Etc/UTC`).length, 3);
});

it("retries a transient download failure", async t => {
  const source = await sources(t);
  let calls = 0;
  source.routes.set(`${tzurl}Test/New_Zone`, () => ++calls === 1 ? new Response("Unavailable", { status: 503 }) :
    new Response(calendar("Test/New_Zone", "2036z")));
  assert.equal((await downloadTimeZoneData(source)).version, "2036z");
  assert.equal(calls, 2);
});

it("rejects a Windows mapping whose target is not available from tzurl.org", async t => {
  const source = await sources(t, "2036z", { "Future Standard Time": "Missing/Zone" });
  await assert.rejects(downloadTimeZoneData(source), /CLDR maps Future Standard Time to Missing\/Zone/);
});

for (const [description, change, error] of [
  ["a different time zone", text => text.replace("TZID:Test/New_Zone", "TZID:Wrong/Zone"), /Invalid time zone definition/],
  ["a missing offset", text => text.replace("TZOFFSETTO:+0000\r\n", ""), /Invalid time zone observance/],
  ["an invalid recurrence rule", text => text.replace("END:STANDARD", "RRULE:FREQ=UNKNOWN\r\nEND:STANDARD"), /invalid frequency/i]
]) {
  it(`rejects a downloaded definition with ${description}`, async t => {
    const source = await sources(t);
    source.routes.set(`${tzurl}Test/New_Zone`, () => new Response(change(calendar("Test/New_Zone", "2036z"))));
    await assert.rejects(downloadTimeZoneData(source), error);
  });
}

it("writes validated data without changing the project license", async t => {
  const root = await temporaryDirectory(t);
  await writeFile(join(root, "LICENSE.txt"), originalLicense);
  const source = await sources(t);
  const data = await buildTimeZones({ ...source, rootURL: pathToFileURL(root + "/") });
  const output = JSON.parse(await readFile(join(root, ".generated/time-zones.json"), "utf8"));
  assert.deepEqual(output, data);
  assert.equal(await readFile(join(root, "LICENSE.txt"), "utf8"), originalLicense);
  assert.deepEqual(await readdir(join(root, ".generated")), ["time-zones.json"]);
});

for (const [description, configure] of [
  ["a missing definition", source => source.routes.set(`${tzurl}Test/New_Zone`, () => new Response("Missing", { status: 404 }))],
  ["a broken archive", source => source.routes.set("https://data.iana.org/time-zones/releases/tzdata2036z.tar.gz", () => new Response("not a tar archive"))],
  ["unavailable CLDR metadata", source => source.routes.set("https://registry.npmjs.org/cldr-core/latest", () => new Response("Missing", { status: 404 }))]
]) {
  it(`preserves existing build data after ${description}`, async t => {
    const root = await temporaryDirectory(t);
    await mkdir(join(root, ".generated"));
    await writeFile(join(root, ".generated/time-zones.json"), "previous data");
    const source = await sources(t);
    configure(source);
    await assert.rejects(buildTimeZones({ ...source, rootURL: pathToFileURL(root + "/") }));
    assert.equal(await readFile(join(root, ".generated/time-zones.json"), "utf8"), "previous data");
    assert.deepEqual(await readdir(join(root, ".generated")), ["time-zones.json"]);
  });
}
