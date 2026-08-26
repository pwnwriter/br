import type { MouseInput } from "./types";

export const ESC = "\x1b";
export const DEFAULT_URL = "about:blank";

export function toUrl(value: string) {
  const trimmed = value.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  if (
    /^[^\s]+\.[^\s]+/.test(trimmed) ||
    trimmed === "localhost" ||
    trimmed.startsWith("localhost:")
  )
    return "https://" + trimmed;
  return "https://www.google.com/search?q=" + encodeURIComponent(trimmed);
}

export function parseMouseEvents(input: string) {
  const events: MouseInput[] = [];
  const re =
    /\x1b\[<(\d+);(\d+);(\d+)([mM])|\x1b\[M([\x20-\xff])([\x20-\xff])([\x20-\xff])|\x1b\[(\d+);(\d+);(\d+)M/g;
  let rest = "";
  let cursor = 0;
  for (const m of input.matchAll(re)) {
    rest += input.slice(cursor, m.index);
    cursor = (m.index || 0) + m[0].length;
    const code =
      m[1] != null
        ? Number(m[1])
        : m[5] != null
          ? m[5].charCodeAt(0) - 32
          : Number(m[8]);
    const wheel = (code & 64) !== 0 ? ((code & 1) === 0 ? "up" : "down") : null;
    events.push({
      code,
      button: code & 3,
      wheel,
      x:
        m[2] != null
          ? Number(m[2])
          : m[6] != null
            ? m[6].charCodeAt(0) - 32
            : Number(m[9]),
      y:
        m[3] != null
          ? Number(m[3])
          : m[7] != null
            ? m[7].charCodeAt(0) - 32
            : Number(m[10]),
      down: m[4] != null ? m[4] === "M" : true,
    });
  }
  rest += input.slice(cursor);
  return { events, rest };
}

export function describeBytes(input: string) {
  return [...Buffer.from(input)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ")
    .slice(0, 90);
}
