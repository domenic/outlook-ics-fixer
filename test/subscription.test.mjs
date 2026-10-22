import { it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { getSubscriptionPath } from "../lib/subscription.mjs";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/subscription-url.mjs", import.meta.url));
const upstreamURL = "https://example.invalid/private-calendar-token/calendar.ics";
const expectedPath = "/b6f9817597b118793ea3bd4fa867e7c43b5f85049fa90702cf6974934766bba4.ics";

it("keeps subscription URLs stable for an unchanged upstream URL", async () => {
  assert.equal(await getSubscriptionPath(upstreamURL), expectedPath);
  assert.notEqual(await getSubscriptionPath(upstreamURL + "?new-token"), expectedPath);
});

it("prints a usable sharing URL without exposing the upstream secret", async () => {
  const { stdout } = await execute(process.execPath, [script, "https://calendar.example"], {
    env: { ...process.env, ICS_URL: upstreamURL }
  });
  assert.equal(stdout, `https://calendar.example${expectedPath}\n`);
  assert.ok(!stdout.includes(upstreamURL));
});

it("explains how to supply the Worker origin", async () => {
  await assert.rejects(execute(process.execPath, [script]), error => {
    assert.match(error.stderr, /Usage: npm run subscription-url/);
    return true;
  });
});
