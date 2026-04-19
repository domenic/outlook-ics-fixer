// VTIMEZONE generation using runtime tzdata and explicit transition dates.

const DAY_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

function getUtcOffsetMinutes(ianaName, date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaName,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = fmt.formatToParts(date);
  const get = type => Number.parseInt(parts.find(p => p.type === type).value, 10);
  const localAsUtcMs = Date.UTC(
    get("year"), get("month") - 1, get("day"),
    get("hour"), get("minute"), get("second"),
  );

  return Math.round((localAsUtcMs - date.getTime()) / 60_000);
}

function fmtOffset(minutes) {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `${sign}${h}${m}`;
}

function fmtLocalDateTime(date) {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${mo}${d}T${h}${mi}${s}`;
}

function findTransition(ianaName, fromMs, toMs, fromOffset) {
  let lo = fromMs;
  let hi = toMs;

  while (hi - lo > 60_000) {
    const mid = Math.floor((lo + hi) / 2);
    if (getUtcOffsetMinutes(ianaName, new Date(mid)) === fromOffset) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return hi;
}

function listTransitions(ianaName, startYear, endYear) {
  const startMs = Date.UTC(startYear, 0, 1, 12, 0, 0);
  const endMs = Date.UTC(endYear + 1, 0, 1, 12, 0, 0);
  const transitions = [];

  let prevMs = startMs;
  let prevOffset = getUtcOffsetMinutes(ianaName, new Date(prevMs));

  for (let currentMs = startMs + DAY_MS; currentMs <= endMs; currentMs += DAY_MS) {
    const currentOffset = getUtcOffsetMinutes(ianaName, new Date(currentMs));
    if (currentOffset === prevOffset) {
      prevMs = currentMs;
      continue;
    }

    const transitionUtcMs = findTransition(ianaName, prevMs, currentMs, prevOffset);
    transitions.push({
      utcMs: transitionUtcMs,
      fromOffset: prevOffset,
      toOffset: currentOffset,
    });

    prevMs = currentMs;
    prevOffset = currentOffset;
  }

  return transitions;
}

export function generateVtimezone(windowsTzid, ianaName) {
  const cacheKey = `${windowsTzid}|${ianaName}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const startYear = 2000;
  const endYear = 2040;
  const transitions = listTransitions(ianaName, startYear, endYear);
  const lines = ["BEGIN:VTIMEZONE", `TZID:${windowsTzid}`];

  if (transitions.length === 0) {
    const offset = fmtOffset(getUtcOffsetMinutes(ianaName, new Date()));
    lines.push("BEGIN:STANDARD");
    lines.push("DTSTART:16010101T000000");
    lines.push(`TZOFFSETFROM:${offset}`);
    lines.push(`TZOFFSETTO:${offset}`);
    lines.push("END:STANDARD");
  } else {
    for (const t of transitions) {
      const type = t.toOffset > t.fromOffset ? "DAYLIGHT" : "STANDARD";
      const local = new Date(t.utcMs + t.fromOffset * 60_000);

      lines.push(`BEGIN:${type}`);
      lines.push(`DTSTART:${fmtLocalDateTime(local)}`);
      lines.push(`TZOFFSETFROM:${fmtOffset(t.fromOffset)}`);
      lines.push(`TZOFFSETTO:${fmtOffset(t.toOffset)}`);
      lines.push(`END:${type}`);
    }
  }

  lines.push("END:VTIMEZONE");
  const serialized = lines.join("\r\n");
  cache.set(cacheKey, serialized);
  return serialized;
}
