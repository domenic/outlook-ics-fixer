import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { getSubscriptionPath } from "../lib/subscription.mjs";
import timeZones from "./fixtures/time-zones.json" with { type: "json" };

const timeZoneAlias = {
  "../.generated/time-zones.json": fileURLToPath(new URL("./fixtures/time-zones.json", import.meta.url))
};
const ICS_URL = "https://example.invalid/private-calendar-token/calendar.ics";
const FEED = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:test@example.invalid",
  "DTSTAMP:20260101T000000Z", "DTSTART;TZID=America/New_York:20260701T090000",
  "SUMMARY:Private event", "END:VEVENT", "END:VCALENDAR"
].join("\r\n");

async function createWorker(t, { upstream = () => new Response(FEED), bindings = { ICS_URL } } = {}) {
  let calls = 0;
  // Wrangler routes outbound Worker requests through Node's `fetch()`.
  const fetchImpl = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "example.invalid") {
      calls++;
      return upstream(new Request(input, init));
    }
    return fetchImpl(input, init);
  });
  // Isolate Wrangler's local state and secrets from the project's `.dev.vars`.
  const root = await mkdtemp(join(tmpdir(), "ics-worker-test-"));
  const server = createTestHarness({ root, workers: [{ config: {
    name: "ics-test",
    main: fileURLToPath(new URL("../lib/index.mjs", import.meta.url)),
    compatibility_date: "2026-10-21",
    vars: bindings,
    alias: timeZoneAlias
  } }] });
  t.after(async () => {
    try {
      await server.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await server.listen();
  return {
    root,
    update: config => server.update(options => ({
      ...options, workers: [{ config: { ...options.workers[0].config, ...config } }]
    })),
    request: (path, method = "GET") => server.fetch(`https://calendar.example${path}`, { method }),
    calls: () => calls
  };
}

describe("calendar Worker", () => {
  it("requires the secret path before fetching or serving a cached calendar", async t => {
    const app = await createWorker(t);
    const path = await getSubscriptionPath(ICS_URL);
    for (const invalid of ["/", "/wrong.ics", `${path.slice(0, -5)}0.ics`]) {
      assert.equal((await app.request(invalid)).status, 404);
    }
    assert.equal(app.calls(), 0);
    const first = await app.request(path);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "text/calendar; charset=utf-8");
    const body = await first.text();
    assert.match(body, /SUMMARY:Private event/);
    assert.match(body, /TZID:America\/New_York/);
    assert.ok(!body.includes(ICS_URL));
    assert.equal(await (await app.request(path + "?ignored=yes")).text(), body);
    assert.equal(app.calls(), 1);
    assert.equal((await app.request("/")).status, 404);
    assert.equal((await app.request("/wrong.ics")).status, 404);
    assert.equal(app.calls(), 1);
  });

  it("revokes the old subscription after changing ICS_URL, even with a populated cache", async t => {
    const app = await createWorker(t);
    const oldPath = await getSubscriptionPath(ICS_URL);
    await (await app.request(oldPath)).text();
    assert.equal(app.calls(), 1);
    const newURL = "https://example.invalid/new-private-token/calendar.ics";
    await app.update({ vars: { ICS_URL: newURL } });
    assert.equal((await app.request(oldPath)).status, 404);
    assert.equal(app.calls(), 1);
    assert.equal((await app.request(await getSubscriptionPath(newURL))).status, 200);
    assert.equal(app.calls(), 2);
    // Restoring the original URL proves its cached response survived the reloads.
    await app.update({ vars: { ICS_URL } });
    assert.match(await (await app.request(oldPath)).text(), /SUMMARY:Private event/);
    assert.equal(app.calls(), 2);
  });

  it("invalidates cached repairs when the fallback time zone changes", async t => {
    const app = await createWorker(t, {
      upstream: () => new Response(FEED.replace("America/New_York", "Customized Time Zone")),
      bindings: { ICS_URL, FALLBACK_IANA: "Asia/Tokyo" }
    });
    const path = await getSubscriptionPath(ICS_URL);
    assert.match(await (await app.request(path)).text(), /TZOFFSETTO:\+0900/);
    await app.update({ vars: { ICS_URL, FALLBACK_IANA: "Etc/UTC" } });
    const body = await (await app.request(path)).text();
    assert.match(body, /TZOFFSETTO:\+0000/);
    assert.ok(!body.includes("TZOFFSETTO:+0900"));
    assert.equal(app.calls(), 2);
    await app.update({ vars: { ICS_URL, FALLBACK_IANA: "Asia/Tokyo" } });
    assert.match(await (await app.request(path)).text(), /TZOFFSETTO:\+0900/);
    assert.equal(app.calls(), 2);
  });

  it("keeps the subscription URL but refreshes cached repairs after a data update", async t => {
    const app = await createWorker(t);
    const path = await getSubscriptionPath(ICS_URL);
    await (await app.request(path)).text();
    assert.equal(app.calls(), 1);
    const updatedData = join(app.root, "updated-time-zones.json");
    await writeFile(updatedData, JSON.stringify({ ...timeZones, revision: "new-data-revision" }));
    await app.update({ alias: { "../.generated/time-zones.json": updatedData } });
    assert.match(await (await app.request(path)).text(), /SUMMARY:Private event/);
    assert.equal(app.calls(), 2);
    assert.match(await (await app.request(path)).text(), /SUMMARY:Private event/);
    assert.equal(app.calls(), 2);
    await app.update({ alias: timeZoneAlias });
    assert.match(await (await app.request(path)).text(), /SUMMARY:Private event/);
    assert.equal(app.calls(), 2);
  });

  it("serves HEAD without a body on cold and cached requests", async t => {
    const app = await createWorker(t);
    const path = await getSubscriptionPath(ICS_URL);
    for (let i = 0; i < 2; i++) {
      const response = await app.request(path, "HEAD");
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "");
      assert.equal(response.headers.get("content-type"), "text/calendar; charset=utf-8");
    }
    assert.match(await (await app.request(path)).text(), /SUMMARY:Private event/);
    assert.equal(app.calls(), 1);
    assert.equal(await (await app.request("/health", "HEAD")).text(), "");
  });

  it("handles health checks, unsupported methods, and missing configuration", async t => {
    const app = await createWorker(t, { bindings: {} });
    assert.equal(await (await app.request("/health")).text(), "ok");
    assert.equal((await app.request("/")).status, 500);
    const rejected = await app.request("/", "POST");
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get("allow"), "GET, HEAD");
    assert.equal(app.calls(), 0);
  });

  for (const [name, upstream] of [
    ["upstream HTTP errors", () => new Response("Unavailable", { status: 503 })],
    ["HTML login pages", () => new Response("<!doctype html><title>Sign in</title>")],
    ["malformed calendars", () => new Response("BEGIN:VCALENDAR")],
    ["unknown time zones", () => new Response(FEED.replace("America/New_York", "Unknown Zone"))]
  ]) {
    it(`returns 502 without caching ${name}`, async t => {
      const app = await createWorker(t, { upstream });
      const path = await getSubscriptionPath(ICS_URL);
      for (let i = 0; i < 2; i++) {
        const response = await app.request(path);
        assert.equal(response.status, 502);
        assert.ok(!(await response.text()).includes(ICS_URL));
      }
      assert.equal(app.calls(), 2);
    });
  }
});
