// ICS fixer: scans for TZID references missing VTIMEZONE blocks and injects them.

import WINDOWS_TO_IANA from "./windows-to-iana.mjs";
import { generateVtimezone } from "./vtimezone.mjs";

export function fixIcs(icsText, { fallbackIANA } = {}) {
  const unfolded = icsText.replace(/\r?\n[ \t]/g, "");

  const definedTzids = new Set();
  for (const m of unfolded.matchAll(/^TZID:(.+)$/gim)) {
    definedTzids.add(m[1].trim());
  }

  const referencedTzids = new Set();
  for (const m of unfolded.matchAll(/;TZID=([^:;]+)/gi)) {
    referencedTzids.add(m[1].replace(/^"|"$/g, "").trim());
  }

  const missing = [...referencedTzids].filter((tz) => !definedTzids.has(tz));
  if (missing.length === 0) return icsText;

  const blocks = [];
  for (const tzid of missing) {
    const iana = WINDOWS_TO_IANA[tzid] ?? fallbackIANA;
    if (!iana) {
      console.warn(`[ics-fixer] Unknown Windows TZID: "${tzid}"`);
      continue;
    }
    blocks.push(generateVtimezone(tzid, iana));
    console.log(`[ics-fixer] Injected VTIMEZONE for "${tzid}" → ${iana}`);
  }

  if (blocks.length === 0) return icsText;

  const nl = icsText.includes("\r\n") ? "\r\n" : "\n";
  const payload = blocks.join(nl);

  // Best case: insert after the last existing END:VTIMEZONE line.
  const lastEndVtz = icsText.lastIndexOf("END:VTIMEZONE");
  if (lastEndVtz !== -1) {
    const endOfLine = icsText.indexOf("\n", lastEndVtz) + 1;
    return icsText.slice(0, endOfLine) + payload + nl + icsText.slice(endOfLine);
  }

  // No existing VTIMEZONEs: insert before the first non-VCALENDAR component.
  const firstComponent = icsText.search(/\r?\nBEGIN:(?!VCALENDAR)/i);
  if (firstComponent !== -1) {
    return icsText.slice(0, firstComponent) + nl + payload + icsText.slice(firstComponent);
  }

  // Fallback: insert before END:VCALENDAR.
  const endCal = icsText.lastIndexOf("END:VCALENDAR");
  if (endCal === -1) return icsText;
  const before = icsText.slice(0, endCal);
  const needsNewline = before.length > 0 && !before.endsWith("\n");
  return before + (needsNewline ? nl : "") + payload + nl + icsText.slice(endCal);
}
