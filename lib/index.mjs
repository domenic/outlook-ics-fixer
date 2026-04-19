// ICS Timezone Fixer — Cloudflare Worker
//
// Proxies an Outlook 365 published ICS feed and injects missing VTIMEZONE
// definitions so Google Calendar (and others) interpret event times correctly.

import { fixIcs } from "./fix-ics.mjs";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }

    const icsUrl = env.ICS_URL;
    if (!icsUrl) {
      return new Response("ICS_URL not configured", { status: 500 });
    }

    const cacheUrl = new URL(url.pathname, url.origin);
    const cacheKey = new Request(cacheUrl);
    const cache = caches.default;

    let response = await cache.match(cacheKey);
    if (response) {
      return response;
    }

    try {
      const upstream = await fetch(icsUrl, {
        headers: { "User-Agent": "ICS-Timezone-Fixer/1.0" },
      });

      if (!upstream.ok) {
        return new Response(`Upstream returned ${upstream.status}`, {
          status: 502,
        });
      }

      const raw = await upstream.text();
      const fixed = fixIcs(raw, { fallbackIANA: env.FALLBACK_IANA });

      response = new Response(fixed, {
        status: 200,
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });

      ctx.waitUntil(cache.put(cacheKey, response.clone()));

      return response;
    } catch (err) {
      console.error("[ics-fixer] Error:", err);
      return new Response("Error fetching upstream calendar", { status: 502 });
    }
  },
};
