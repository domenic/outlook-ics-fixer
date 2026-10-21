import { fixICS } from "./fix-ics.mjs";
import { getSubscriptionPath } from "./subscription.mjs";
import timezones from "../data/timezones.json" with { type: "json" };

function respond(request, body, init) {
  return new Response(request.method === "HEAD" ? null : body, init);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    if (url.pathname === "/health") return respond(request, "ok", { status: 200 });
    if (!env.ICS_URL) return respond(request, "ICS_URL not configured", { status: 500 });

    // Check the subscription token before touching the cache, including after a URL rotation.
    if (url.pathname !== await getSubscriptionPath(env.ICS_URL)) {
      return respond(request, "Not found", { status: 404 });
    }

    const cacheURL = new URL(url.pathname, url.origin);
    cacheURL.searchParams.set("tzdb", timezones.version);
    cacheURL.searchParams.set("fallback", env.FALLBACK_IANA ?? "");
    const cacheKey = new Request(cacheURL);
    const cache = caches.default;

    try {
      const cached = await cache.match(cacheKey);
      if (cached) return respond(request, cached.body, cached);

      const upstream = await fetch(env.ICS_URL, {
        headers: { "User-Agent": "ICS-Timezone-Fixer/1.0" },
        signal: AbortSignal.timeout(15_000)
      });
      if (!upstream.ok) return respond(request, "Upstream calendar unavailable", { status: 502 });

      const fixed = fixICS(await upstream.text(), { fallbackIANA: env.FALLBACK_IANA });
      const response = new Response(fixed, {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Cache-Control": "public, max-age=300",
          "X-Robots-Tag": "noindex, nofollow",
          "X-Content-Type-Options": "nosniff"
        }
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return respond(request, response.body, response);
    } catch {
      // Upstream errors can contain the secret URL; do not log their text.
      console.error("[ics-fixer] Unable to fetch or repair the upstream calendar");
      return respond(request, "Unable to fetch or repair the upstream calendar", { status: 502 });
    }
  }
};
