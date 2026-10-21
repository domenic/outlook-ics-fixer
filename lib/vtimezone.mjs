import timezones from "../data/timezones.json" with { type: "json" };

export function resolveIANA(name) {
  const canonical = Object.hasOwn(timezones.aliases, name) ? timezones.aliases[name] : name;
  return Object.hasOwn(timezones.zones, canonical) ? canonical : undefined;
}

export function generateVTimezone(tzid, ianaName) {
  const canonical = resolveIANA(ianaName);
  if (!canonical) {
    throw new RangeError(`Unsupported IANA timezone: ${ianaName}`);
  }

  const escaped = tzid.replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replace(/\r?\n/g, "\\n");
  // A timezone identifier is a TEXT property here, and a parameter on event dates.
  const block = timezones.zones[canonical].replace(/^TZID:.*$/m, () => `TZID:${escaped}`);
  return block.split("\n").map(foldLine).join("\r\n");
}

function foldLine(text) {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= 75) return text;
  let line = "";
  let bytes = 0;
  for (const character of text) {
    const length = encoder.encode(character).length;
    if (bytes + length > 75) {
      line += "\r\n ";
      bytes = 1;
    }
    line += character;
    bytes += length;
  }
  return line;
}
