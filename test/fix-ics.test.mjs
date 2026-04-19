import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fixIcs } from "../lib/fix-ics.mjs";

const MINIMAL_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Test//Test//EN",
  "END:VCALENDAR",
].join("\r\n");

const ICS_WITH_DEFINED_TZ = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:Eastern Standard Time",
  "BEGIN:STANDARD",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Eastern Standard Time:20250101T090000",
  "SUMMARY:Test",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const ICS_MISSING_TZ = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Eastern Standard Time:20250101T090000",
  "SUMMARY:Test",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const ICS_MISSING_TZ_NO_VEVENT = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "DTSTART;TZID=Eastern Standard Time:20250101T090000",
  "END:VCALENDAR",
].join("\r\n");

const ICS_UNKNOWN_TZ = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Totally Fake Time:20250101T090000",
  "SUMMARY:Test",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const ICS_CASE_VARIATIONS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TzId:Eastern Standard Time",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;tzid=\"Eastern Standard Time\":20250101T090000",
  "SUMMARY:Test",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const ICS_WITH_VTODO = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTODO",
  "DUE;TZID=Eastern Standard Time:20250101T090000",
  "SUMMARY:Todo test",
  "END:VTODO",
  "END:VCALENDAR",
].join("\r\n");

const ICS_MIXED_KNOWN_UNKNOWN = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Eastern Standard Time:20250101T090000",
  "DTEND;TZID=Totally Fake Time:20250101T100000",
  "SUMMARY:Mixed TZIDs",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

// Mirrors the real Outlook feed: existing VTIMEZONE with sub-components,
// plus a referenced TZID (Eastern Standard Time) that has no VTIMEZONE.
const ICS_EXISTING_TZ_PLUS_MISSING = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:Customized Time Zone",
  "BEGIN:STANDARD",
  "DTSTART:16010101T000000",
  "TZOFFSETFROM:+0900",
  "TZOFFSETTO:+0900",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:16010101T000000",
  "TZOFFSETFROM:+0900",
  "TZOFFSETTO:+0900",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Customized Time Zone:20250101T090000",
  "SUMMARY:Event with custom tz",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=Eastern Standard Time:20250201T090000",
  "SUMMARY:Event with missing tz",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("fixIcs", () => {
  it("passes through ICS with no TZID references", () => {
    assert.equal(fixIcs(MINIMAL_ICS), MINIMAL_ICS);
  });

  it("passes through ICS where all TZIDs are already defined", () => {
    assert.equal(fixIcs(ICS_WITH_DEFINED_TZ), ICS_WITH_DEFINED_TZ);
  });

  it("injects VTIMEZONE for a missing Windows TZID", () => {
    const result = fixIcs(ICS_MISSING_TZ);

    assert.match(result, /BEGIN:VTIMEZONE/);
    assert.match(result, /TZID:Eastern Standard Time/);
    assert.match(result, /END:VTIMEZONE/);

    // VTIMEZONE should appear before VEVENT
    const vzIdx = result.indexOf("BEGIN:VTIMEZONE");
    const veIdx = result.indexOf("BEGIN:VEVENT");
    assert.ok(vzIdx < veIdx, "VTIMEZONE should come before VEVENT");

    // Should still be valid structure
    assert.match(result, /^BEGIN:VCALENDAR/);
    assert.match(result, /END:VCALENDAR$/);
  });

  it("injects VTIMEZONE using the no-VEVENT fallback path", () => {
    const result = fixIcs(ICS_MISSING_TZ_NO_VEVENT);

    assert.match(result, /BEGIN:VTIMEZONE/);
    assert.match(result, /TZID:Eastern Standard Time/);

    // VTIMEZONE should appear before END:VCALENDAR
    const vzIdx = result.indexOf("END:VTIMEZONE");
    const endIdx = result.indexOf("END:VCALENDAR");
    assert.ok(vzIdx < endIdx, "VTIMEZONE should come before END:VCALENDAR");

    // The line before END:VCALENDAR should not be glued together
    const lines = result.split(/\r?\n/);
    const endLine = lines.findIndex((l) => l === "END:VCALENDAR");
    assert.ok(endLine > 0);
    assert.ok(
      !lines[endLine - 1].includes("END:VCALENDAR"),
      "END:VCALENDAR should be on its own line",
    );
  });

  it("skips unknown TZIDs without crashing", () => {
    const result = fixIcs(ICS_UNKNOWN_TZ);
    // No VTIMEZONE injected since the TZID is unknown
    assert.ok(!result.includes("BEGIN:VTIMEZONE"));
    // Original content preserved
    assert.equal(result, ICS_UNKNOWN_TZ);
  });

  it("uses fallbackIANA for unknown TZIDs when provided", () => {
    const result = fixIcs(ICS_UNKNOWN_TZ, { fallbackIANA: "Asia/Tokyo" });
    assert.match(result, /BEGIN:VTIMEZONE/);
    assert.match(result, /TZID:Totally Fake Time/);
    assert.match(result, /TZOFFSETTO:\+0900/);
  });

  it("treats TZID parsing as case-insensitive and supports quoted values", () => {
    const result = fixIcs(ICS_CASE_VARIATIONS);
    assert.equal(result, ICS_CASE_VARIATIONS);
  });

  it("inserts VTIMEZONE before non-VEVENT components that reference TZID", () => {
    const result = fixIcs(ICS_WITH_VTODO);
    assert.match(result, /BEGIN:VTIMEZONE/);

    const vzIdx = result.indexOf("BEGIN:VTIMEZONE");
    const todoIdx = result.indexOf("BEGIN:VTODO");
    assert.ok(vzIdx < todoIdx, "VTIMEZONE should come before VTODO");
  });

  it("injects known TZIDs even when unknown TZIDs are also present", () => {
    const result = fixIcs(ICS_MIXED_KNOWN_UNKNOWN);
    assert.match(result, /TZID:Eastern Standard Time/);
    assert.ok(result.includes("BEGIN:VTIMEZONE"));
  });

  it("does not nest injected VTIMEZONE inside an existing VTIMEZONE", () => {
    const result = fixIcs(ICS_EXISTING_TZ_PLUS_MISSING);

    // The injected VTIMEZONE for Eastern Standard Time must not appear
    // between BEGIN:VTIMEZONE/END:VTIMEZONE of the Customized Time Zone block.
    const customTzStart = result.indexOf("TZID:Customized Time Zone");
    const customTzEnd = result.indexOf("END:VTIMEZONE", customTzStart);
    const slice = result.slice(customTzStart, customTzEnd);
    assert.ok(
      !slice.includes("Eastern Standard Time"),
      "Injected VTIMEZONE must not be nested inside existing VTIMEZONE block",
    );
  });

  it("produces well-formed lines with no glued tokens after injection", () => {
    const result = fixIcs(ICS_EXISTING_TZ_PLUS_MISSING);

    // Every line should contain at most one ICS token — no "END:VTIMEZONEBEGIN:..."
    const lines = result.split(/\r?\n/);
    for (const line of lines) {
      const beginCount = (line.match(/BEGIN:/g) || []).length;
      const endCount = (line.match(/END:/g) || []).length;
      assert.ok(
        beginCount + endCount <= 1,
        `Line contains glued tokens: "${line}"`,
      );
    }
  });
});
