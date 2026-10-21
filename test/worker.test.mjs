import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { getSubscriptionPath } from "../lib/subscription.mjs";
import timezones from "../data/timezones.json" with { type: "json" };

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../lib/index.mjs", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "browser"
});
const ICS_URL = "https://example.invalid/private-calendar-token/calendar.ics";
const FEED = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:test@example.invalid",
  "DTSTAMP:20260101T000000Z", "DTSTART;TZID=America/New_York:20260701T090000",
  "SUMMARY:Private event", "END:VEVENT", "END:VCALENDAR"
].join("\r\n");

async function createWorker(t, { upstream = () => new Response(FEED), bindings = { ICS_URL } } = {}) {
  let calls = 0;
  const options = { workers: [{
    name: "ics-test", modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-21", bindings,
    outboundService: request => { calls++; return upstream(request); }
  }],
    log: new Log(LogLevel.NONE)
  };
  const worker = new Miniflare(convertV4MiniflareOptions(options));
  t.after(() => worker.dispose());
  await worker.ready;
  return {
    worker, options,
    request: (path, method = "GET") => worker.dispatchFetch(`https://calendar.example${path}`, { method }),
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
    const caches = await app.worker.getCaches();
    const cacheKey = `https://calendar.example${oldPath}?tzdb=${timezones.version}&fallback=`;
    assert.ok(await caches.default.match(cacheKey));
    const newURL = "https://example.invalid/new-private-token/calendar.ics";
    await app.worker.setOptions(convertV4MiniflareOptions({ ...app.options, workers: [{ ...app.options.workers[0], bindings: { ICS_URL: newURL } }] }));
    assert.ok(await (await app.worker.getCaches()).default.match(cacheKey));
    assert.equal((await app.request(oldPath)).status, 404);
    assert.equal(app.calls(), 1);
    assert.equal((await app.request(await getSubscriptionPath(newURL))).status, 200);
    assert.equal(app.calls(), 2);
  });

  it("invalidates cached repairs when the fallback timezone changes", async t => {
    const app = await createWorker(t, {
      upstream: () => new Response(FEED.replace("America/New_York", "Customized Time Zone")),
      bindings: { ICS_URL, FALLBACK_IANA: "Asia/Tokyo" }
    });
    const path = await getSubscriptionPath(ICS_URL);
    assert.match(await (await app.request(path)).text(), /TZOFFSETTO:\+0900/);
    await app.worker.setOptions(convertV4MiniflareOptions({ ...app.options, workers: [{ ...app.options.workers[0], bindings: { ICS_URL, FALLBACK_IANA: "Etc/UTC" } }] }));
    const body = await (await app.request(path)).text();
    assert.match(body, /TZOFFSETTO:\+0000/);
    assert.ok(!body.includes("TZOFFSETTO:+0900"));
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
    ["unknown timezones", () => new Response(FEED.replace("America/New_York", "Unknown Zone"))]
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
