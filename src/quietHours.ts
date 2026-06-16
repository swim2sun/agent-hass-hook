export interface QuietWindow { start: string; end: string; }

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

export function isWithinQuietHours(
  now: Date,
  windows: QuietWindow[],
): { active: boolean; window?: string } {
  const m = now.getHours() * 60 + now.getMinutes();
  for (const w of windows) {
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    if (start === end) continue; // zero-length window never matches
    const active = start < end ? m >= start && m < end : m >= start || m < end;
    if (active) return { active: true, window: `${w.start}-${w.end}` };
  }
  return { active: false };
}
