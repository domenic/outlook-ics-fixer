# ICS Timezone Fixer

A Cloudflare Worker that repairs missing timezone definitions in Outlook's published ICS calendars. Subscribe from Google Calendar or share the subscription URL with your partner. Existing timezone definitions and event content are preserved.

The subscription URL contains a secret token. Anyone you give it to can read the calendar; they do not need a separate account or password. The Worker root (`/`) returns 404.

## Set up your calendar

You need Node.js 24 or later, a Cloudflare account, and your published Outlook ICS URL.

1. Install the dependencies:

   ```sh
   npm ci
   ```

1. Copy `.dev.vars.example` to `.dev.vars` and replace `ICS_URL` with your Outlook ICS URL. This file is ignored by Git. Keep the URL private: it grants access to your calendar.

   If your feed refers to an undefined `Customized Time Zone`, also set `FALLBACK_IANA` to the IANA timezone those events use, such as `Asia/Tokyo` or `America/New_York`. This fallback applies only to that Outlook identifier. Windows names and IANA names use their own timezone definitions; other unknown identifiers produce an error instead of guessing an offset.

1. Log in, deploy, and upload your secrets:

   ```sh
   npx wrangler login
   npm run deploy
   npx wrangler secret bulk .dev.vars
   ```

   Deployment prints your Worker origin, such as `https://ics-timezone-fixer.your-subdomain.workers.dev`. Calendar requests work after the secret upload completes. `.dev.vars` supplies local development settings; deployed settings are stored as Cloudflare secrets.

1. Print the subscription URL using that origin:

   ```sh
   npm run subscription-url -- https://ics-timezone-fixer.your-subdomain.workers.dev
   ```

   The command reads `ICS_URL` from `.dev.vars`, or from the environment if set. It prints a URL ending in a 64-character token and `.ics`. Share that complete URL privately with your partner. Do not share just the Worker origin.

1. In Google Calendar, choose **Other calendars → + → From URL** and paste the complete subscription URL. Google controls its refresh schedule; changes may take time to appear.

## Sharing and revoking access

The token is a domain-separated SHA-256 hash of the exact `ICS_URL` string. It inherits its secrecy from Outlook's unguessable published URL. A hash of a public or easily guessed upstream URL would not make it private.

The Worker validates the token before reading its cache. To replace a shared subscription, regenerate the published URL in Outlook, update `.dev.vars`, upload the secrets again, and print the new subscription URL. The old subscription stops serving new responses once the updated Worker configuration takes effect. Copies already downloaded by calendar clients cannot be recalled.

The feed is cached for five minutes. `/health` returns a simple health response without fetching your calendar. Errors do not include the upstream URL or calendar contents.

## Custom domain

In `wrangler.toml`, uncomment the `[[routes]]` block and replace `cal.example.com` with your domain on Cloudflare. Redeploy and rerun `npm run subscription-url -- https://cal.example.com` to get the corresponding subscription URL.

## Development and tests

```sh
npm run dev
npm test
npm run build
```

`dev` reads `.dev.vars`. Use `subscription-url` with the origin printed by Wrangler to obtain the local subscription URL. `build` is a deployment dry run and does not publish anything.

Tests parse repaired calendars with an independent iCalendar library and exercise the Worker in Cloudflare's local runtime. They cover historical and future dates, exact DST transitions, IANA aliases, subscription authorization, cache behavior, URL rotation, HEAD requests, and upstream failures. CI runs the tests, build, and dependency audit on Node.js 24 and 26.

## Timezone data

The Worker bundles complete VTIMEZONE definitions from [tzurl.org's `zoneinfo` dataset](https://www.tzurl.org/zoneinfo/index.html), generated from the [IANA Time Zone Database](https://www.iana.org/time-zones). These retain historical transitions and future recurrence rules instead of extrapolating today's rules into the past or stopping in 2040. `data/timezones.json` records the bundled tzdb version. Windows identifiers use Unicode CLDR's default territory mappings.

No timezone downloads or day-by-day timezone scans run during calendar requests. This keeps request CPU usage low enough for the intended Cloudflare Workers free-tier workload; large calendars and account-wide request usage still count toward [Cloudflare's limits](https://developers.cloudflare.com/workers/platform/limits/).

Governments can change timezone rules. To update the bundled snapshot:

```sh
npm update tzdata cldr-core
npm run update-timezones
npm test
```

The updater requires tzurl.org and the installed `tzdata` package to use the same tzdb release. It fails without replacing the timezone snapshot if the versions differ or a download fails. Review and commit the generated changes, then redeploy. Future offsets reflect the rules in the bundled release, not changes announced after that release.

## License

The code is MIT licensed. IANA timezone data is in the public domain. Windows timezone mappings are derived from Unicode CLDR; its notice is included in `UNICODE-LICENSE.txt`.
