import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ICAL from "ical.js";
import { fixICS } from "../lib/fix-ics.mjs";
import { generateVTimezone, resolveIANA } from "../lib/vtimezone.mjs";
import WINDOWS_TO_IANA from "../lib/windows-to-iana.mjs";
import timezones from "../data/timezones.json" with { type: "json" };

function eventOffset(tzid, date, options) {
  const input = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:test@example.invalid",
    "DTSTAMP:20260101T000000Z", `DTSTART;TZID=${tzid}:${date}`,
    "END:VEVENT", "END:VCALENDAR"
  ].join("\r\n");
  const calendar = new ICAL.Component(ICAL.parse(fixICS(input, options)));
  const event = new ICAL.Event(calendar.getFirstSubcomponent("vevent"));
  return event.startDate.utcOffset();
}

describe("timezone semantics", () => {
  for (const year of [1999, 2026, 2041, 2100]) {
    it(`preserves New York summer and winter offsets in ${year}`, () => {
      assert.equal(eventOffset("Eastern Standard Time", `${year}0701T090000`), -4 * 3600);
      assert.equal(eventOffset("Eastern Standard Time", `${year}0101T090000`), -5 * 3600);
    });
  }

  it("uses the historical US DST schedule before 2007", () => {
    assert.equal(eventOffset("Eastern Standard Time", "19990320T090000"), -5 * 3600);
    assert.equal(eventOffset("Eastern Standard Time", "20260320T090000"), -4 * 3600);
  });

  it("switches London and Sydney offsets at the exact second", () => {
    assert.equal(eventOffset("GMT Standard Time", "20261025T020000"), 0);
    assert.equal(eventOffset("GMT Standard Time", "20260329T020000"), 3600);
    assert.equal(eventOffset("AUS Eastern Standard Time", "20260405T030000"), 10 * 3600);
    assert.equal(eventOffset("AUS Eastern Standard Time", "20261004T030000"), 11 * 3600);
  });

  it("recognizes IANA names and aliases before consulting the fallback", () => {
    for (const tzid of ["America/New_York", "US/Eastern"]) {
      assert.equal(eventOffset(tzid, "20260701T090000", { fallbackIANA: "Asia/Tokyo" }), -4 * 3600);
    }
    assert.equal(eventOffset("Asia/Kolkata", "20260701T090000"), 5.5 * 3600);
    assert.equal(eventOffset("Asia/Katmandu", "20260701T090000"), 5.75 * 3600);
    assert.equal(eventOffset("Etc/UTC", "20260701T090000"), 0);
  });

  it("handles southern hemisphere and half-hour daylight saving time", () => {
    assert.equal(eventOffset("Lord Howe Standard Time", "20260101T090000"), 11 * 3600);
    assert.equal(eventOffset("Lord Howe Standard Time", "20260701T090000"), 10.5 * 3600);
  });

  it("validates every bundled timezone and Windows mapping", () => {
    for (const iana of Object.values(WINDOWS_TO_IANA)) assert.ok(resolveIANA(iana), iana);
    for (const name of [...Object.keys(timezones.zones), ...Object.keys(timezones.aliases)]) {
      const component = new ICAL.Component(ICAL.parse(generateVTimezone(name, name)));
      assert.equal(component.name, "vtimezone", name);
      assert.equal(component.getFirstPropertyValue("tzid"), name);
      assert.ok(component.getAllSubcomponents().length > 0, name);
    }
  });

  it("escapes and folds timezone names without altering their value", () => {
    const name = 'Custom; Zone: "東京",\\'.repeat(8);
    const definition = generateVTimezone(name, "Asia/Tokyo");
    assert.ok(definition.split("\r\n").every(line => Buffer.byteLength(line) <= 75));
    const component = new ICAL.Component(ICAL.parse(definition));
    assert.equal(component.getFirstPropertyValue("tzid"), name);
  });
});

describe("calendar parsing", () => {
  const calendar = content => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n${content}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

  it("does not treat property values as timezone parameters", () => {
    const input = calendar("DESCRIPTION:Example: use ;TZID=Fake:date");
    assert.equal(fixICS(input), input);
  });

  it("unfolds references and preserves the original event content", () => {
    const input = calendar('DTSTART;TZID="Eastern Stan\r\n dard Time":20260701T090000');
    const output = fixICS(input);
    assert.ok(output.endsWith(input.slice(input.indexOf("BEGIN:VEVENT"))));
    assert.match(output, /TZID:Eastern Standard Time/);
    assert.equal(fixICS(output), output);
  });

  it("supports quoted parameters containing colons and semicolons", () => {
    const input = calendar('ATTENDEE;CN="Example: Name; Other";ROLE=REQ-PARTICIPANT:mailto:test@example.invalid\r\nDTSTART;TZID=Asia/Tokyo:20260701T090000');
    assert.match(fixICS(input), /TZID:Asia\/Tokyo/);
  });

  it("supports LF feeds without introducing mixed line endings", () => {
    const input = calendar("DTSTART;TZID=Asia/Tokyo:20260701T090000").replaceAll("\r\n", "\n");
    assert.ok(!fixICS(input).includes("\r"));
  });

  it("does not mistake inherited object properties for timezone names", () => {
    for (const name of ["toString", "constructor", "__proto__"]) {
      assert.throws(() => fixICS(calendar(`DTSTART;TZID=${name}:20260701T090000`)), /unsupported timezone/);
    }
  });

  it("rejects HTML, incomplete calendars, and multiple calendars", () => {
    for (const input of ["<html>Sign in</html>", "BEGIN:VCALENDAR", "BEGIN:VCALENDAR\nEND:VEVENT", calendar("") + calendar("")]) {
      assert.throws(() => fixICS(input));
    }
  });
});
