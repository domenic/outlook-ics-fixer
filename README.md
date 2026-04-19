# ICS Timezone Fixer — Cloudflare Worker

Fixes Outlook 365's broken ICS calendar publishing by injecting missing
`VTIMEZONE` definitions. Deploys to Cloudflare Workers free tier.

## Deploy (one-time setup, ~2 minutes)

```bash
# 1. Install wrangler if you don't have it
npm install

# 2. Log in to Cloudflare (opens browser)
npx wrangler login

# 3. Deploy
npx wrangler deploy
```

That's it. Wrangler will print a URL like:

```
https://ics-timezone-fixer.<your-subdomain>.workers.dev
```

## Set up Google Calendar

1. Open Google Calendar → Other calendars → **+** → **From URL**
2. Paste: `https://ics-timezone-fixer.<your-subdomain>.workers.dev/`
3. Click **Add Calendar**

Google polls this URL every few hours and gets a fixed ICS feed.

## Optional: custom domain

If you have a domain on Cloudflare, uncomment the `[routes]` section in
`wrangler.toml` and redeploy. Then your URL would be e.g. `https://cal.domenic.me/`.

## How it works

1. Google Calendar requests the Worker URL
2. Worker fetches your Outlook ICS feed
3. Scans for `TZID=` references missing `VTIMEZONE` blocks
4. Maps Windows timezone names to IANA (140+ zones)
5. Generates correct `VTIMEZONE` definitions with DST rules
6. Returns fixed ICS — cached at Cloudflare's edge for 5 minutes

Existing correct `VTIMEZONE` blocks are never modified.

## Costs

Free. The Cloudflare Workers free tier allows 100,000 requests/day.
Google Calendar polls a few times per hour at most.
