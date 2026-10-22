import timeZones from "../.generated/time-zones.json" with { type: "json" };
import { generateVTimeZone, resolveIANA } from "./time-zones.mjs";

function parseContentLine(text) {
  const parts = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; ++i) {
    if (text[i] === '"') quoted = !quoted;
    if (!quoted && (text[i] === ";" || text[i] === ":")) {
      parts.push(text.slice(start, i));
      if (text[i] === ":") {
        return { name: parts[0].toUpperCase(), params: parts.slice(1), value: text.slice(i + 1) };
      }
      start = i + 1;
    }
  }
  throw new Error("Invalid iCalendar content line");
}

export function fixICS(icsText, { fallbackIANA } = {}) {
  const lines = [];
  for (const match of icsText.matchAll(/([^\r\n]*)(?:\r\n|\n|$)/g)) {
    const text = match[1];
    if (/^[ \t]/.test(text) && lines.length > 0) {
      lines.at(-1).text += text.slice(1);
    } else if (text !== "") {
      lines.push({ text, position: match.index });
    }
  }

  const definedTZIDs = new Set();
  const referencedTZIDs = new Set();
  const stack = [];
  let insertionPoint;
  let calendars = 0;
  for (const { text, position } of lines) {
    const { name, params, value } = parseContentLine(text);
    if (name === "BEGIN") {
      const component = value.toUpperCase();
      if (stack.length === 0) {
        if (component !== "VCALENDAR" || calendars++ !== 0) throw new Error("Expected one VCALENDAR");
      } else if (component === "VCALENDAR") {
        throw new Error("Nested VCALENDAR");
      } else if (stack.length === 1 && insertionPoint === undefined) {
        insertionPoint = position;
      }
      stack.push(component);
    } else if (name === "END") {
      if (stack.pop() !== value.toUpperCase()) throw new Error("Unbalanced iCalendar components");
      if (stack.length === 0 && insertionPoint === undefined) insertionPoint = position;
    } else {
      if (stack.length === 0) throw new Error("Property outside VCALENDAR");
      if (name === "TZID" && stack.at(-1) === "VTIMEZONE") {
        definedTZIDs.add(value.replace(/\\([nN,;\\])/g, (_, character) => /n/i.test(character) ? "\n" : character));
      }
      for (const param of params) {
        const equals = param.indexOf("=");
        if (param.slice(0, equals).toUpperCase() === "TZID") {
          let tzid = param.slice(equals + 1);
          if (tzid.startsWith('"') && tzid.endsWith('"')) tzid = tzid.slice(1, -1);
          referencedTZIDs.add(tzid.replace(/\^(\^|n|')/gi, (_, character) => character === "^" ? "^" : character === "'" ? '"' : "\n"));
        }
      }
    }
  }
  if (calendars !== 1 || stack.length !== 0 || insertionPoint === undefined) {
    throw new Error("Incomplete VCALENDAR");
  }

  const blocks = [];
  for (const tzid of referencedTZIDs) {
    if (definedTZIDs.has(tzid)) continue;
    const mapped = Object.hasOwn(timeZones.windows, tzid) ? timeZones.windows[tzid] : undefined;
    const iana = mapped ?? resolveIANA(tzid) ?? (tzid === "Customized Time Zone" ? fallbackIANA : undefined);
    if (!iana) throw new Error("Calendar contains an unsupported time zone");
    blocks.push(generateVTimeZone(tzid, iana));
  }
  if (blocks.length === 0) return icsText;

  const newline = icsText.includes("\r\n") ? "\r\n" : "\n";
  const payload = blocks.join("\r\n").replaceAll("\r\n", newline) + newline;
  return icsText.slice(0, insertionPoint) + payload + icsText.slice(insertionPoint);
}
