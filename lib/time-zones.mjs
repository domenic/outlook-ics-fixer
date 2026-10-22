import timeZones from "../.generated/time-zones.json" with { type: "json" };

export function resolveIANA(name) {
  const canonical = Object.hasOwn(timeZones.aliases, name) ? timeZones.aliases[name] : name;
  return Object.hasOwn(timeZones.zones, canonical) ? canonical : undefined;
}

export function generateVTimeZone(tzid, ianaName) {
  const canonical = resolveIANA(ianaName);
  if (!canonical) {
    throw new RangeError(`Unsupported IANA time zone: ${ianaName}`);
  }

  const escaped = tzid.replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replace(/\r?\n/g, "\\n");
  // A time zone identifier is a TEXT property here, and a parameter on event dates.
  const block = timeZones.zones[canonical].replace(/^TZID:.*$/m, () => `TZID:${escaped}`);
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
