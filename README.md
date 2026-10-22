# Outlook ICS Fixer

I just wanted to share my Microsoft 365 Outlook calendar with my wife, who uses Google Calendar. Nothing is ever simple.

The [official way to do this](https://support.microsoft.com/en-us/outlook/calendar-sharing-in-microsoft-365) is to generate an ICS URL and share it with the Google Calendar user.

But, the ICS data that Outlook generates is invalid: [its time zone data is messed up](https://learn.microsoft.com/en-us/answers/questions/4715653/bug-in-outlook-online-calendar-export). Various people have [created](https://gist.github.com/florisvanvugt/b6ef1c67f98c20944ec3c9ebd7da76d4) | [solutions](https://github.com/bressanmarcos/ICS-Timezone-Fixer) for this. This repository is my attempt, which worked better for me than the existing ones, and which you can self-host for your own account if you'd like.

## Setup

The basic idea is to use the free tier of Cloudflare (a web hosting platform) to host a new version of your calendar, with the time zones corrected. The new version will be at a different URL, but like the original, it will be an unguessable long URL, which you only share to trusted parties.

### How to get an `.ics` link from Outlook

Follow the instructions from Microsoft's ["Share your calendar in Outlook on the web" article's "Publish your calendar" section](https://support.microsoft.com/en-us/outlook/share-your-calendar-in-outlook-on-the-web#publish-your-calendar) to get an ICS link. (The same instructions work on modern Outlook for desktop.)

This is the input calendar URL, with the broken time zones. Keep this URL private, as anyone who has it can see your calendar info.

### Deploying the fixer proxy to Cloudflare

You need [Node.js](https://nodejs.org/en) v24 or later and a [free Cloudflare account](https://www.cloudflare.com/).

1. Download and extract [the code for this repository](https://github.com/domenic/outlook-ics-fixer/archive/refs/heads/main.zip). Perform the following steps in the directory of the downloaded code.

1. Copy `.dev.vars.example` to `.dev.vars`. Then, update it like so:

   - Set the value of `ICS_URL` to the original, input calendar URL from Outlook.
   - Set the value of `FALLBACK_IANA` to the time zone configured in Outlook. It must be in the format used by the [IANA time zone database](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). If your computer is currently in that time zone, you can run the following command to find it:

      ```sh
      node -p "new Intl.DateTimeFormat().resolvedOptions().timeZone"
      ```

1. Install the dependencies, then log in to Cloudflare and deploy the fixer with the values you set above, by running the following commands:

   ```sh
   npm install
   npx wrangler login
   npm run deploy
   npx wrangler secret bulk .dev.vars
   ```

   This will print the origin for your deployment, e.g., `https://outlook-ics-fixer.your-subdomain.workers.dev`.

   Each deployment downloads the latest time zone definitions available from tzurl.org and the latest released Windows time zone mappings from Unicode CLDR. You don't need to update any data files yourself.

1. Print the subscription URL using that origin by running the following:

   ```sh
   npm run subscription-url -- https://outlook-ics-fixer.your-subdomain.workers.dev
   ```

   The resulting URL will end in a 64-character token and `.ics`. Share that complete URL privately with people who you want to receive a time zone-fixed version of your calendar, such as your partner.

### How to subscribe to `.ics` links into Google Calendar

Once you have the fixed link URL, the person you are sharing with can import it to Google Calendar by choosing **Other calendars → + → From URL** on the sidebar, and pasting the complete subscription URL. You can also test this with your own Google Calendar account, if you have one.

Note that Google controls the refresh schedule, so changes to the original Outlook calendar can take some time to appear.

## Security, sharing, and revoking access

Basically, this is all done on the Outlook side. The fixed calendar URL is derived from the original Outlook URL, so since the original Outlook URL is unguessable, so is the fixed calendar URL.

To share with more people, just give more people the URL.

To revoke access, use the controls in the Outlook settings where you originally published or shared the calendar. The fixed URL will then stop working automatically.

## Advanced configuration

### Updating the time zone data

Governments can change time zone rules over time. If this happens to any of the time zones that might appear on your calendar, redeploy to download the latest data:

```sh
npm run deploy
```

Redeploying with updated time zone data won't change the URL you've shared, so none of the people you're sharing with should notice anything wrong.

The deployed fixer keeps using its bundled data until you redeploy. If a download fails, deployment stops and the existing fixer keeps running.

### Using a custom domain

If you've configured a custom domain in Cloudflare already, then you can change the configuration of this tool to deploy onto it.

To achieve this, in `wrangler.toml`, uncomment the `[[routes]]` block and replace `cal.example.com` with your domain on Cloudflare. Redeploy and rerun `npm run subscription-url -- https://cal.example.com` to get the corresponding subscription URL.

## Development instructions

After following the setup instructions above:

- `npm run dev` starts a local Worker using `.dev.vars`. In another terminal, run `npm run subscription-url -- <origin>` with the origin printed by Wrangler to get the local subscription URL.
- `npm test` runs the tests using fixed time zone fixtures, without downloading data.
- `npm run build` downloads current data and checks the deployment bundle without publishing anything.

Wrangler runs `scripts/build-time-zones.mjs` before starting development or building a deployment. It generates `.generated/time-zones.json`, which is ignored by Git. Definitions come from [tzurl.org's `zoneinfo` dataset](https://www.tzurl.org/zoneinfo/index.html); zone names and aliases come from the matching [IANA release](https://www.iana.org/time-zones). Windows mappings come from the latest released `cldr-core` package, independently of the lockfile.

The build checks that definitions can be parsed, aliases and Windows mappings resolve, and all definitions use the same tzdb release. It retries if tzurl.org changes releases during the download. It only replaces the generated data after the downloads and checks succeed.

Tests use a small fixture in `test/fixtures/time-zones.json` to check historical transitions and future recurrence rules. Those expectations describe the fixture, so changes to real-world time zone rules don't require changing the tests.

Worker integration tests use Wrangler's test harness with Node's test runner. They run locally with test calendar responses and isolated configuration, without reading `.dev.vars`.
