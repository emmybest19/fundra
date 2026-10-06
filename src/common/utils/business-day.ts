// Fundra's business day is the Africa/Lagos calendar day (WAT, UTC+1, no daylight saving):
// daily limits reset, and ages tick over, at Lagos midnight, not UTC's (docs/DATABASE.md).

const LAGOS_OFFSET_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Today's Lagos calendar date, `YYYY-MM-DD`. */
export function lagosDate(now: number): string {
  return new Date(now + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The Lagos day containing `now`, as UTC instants: `[start, end)`. Lagos midnight is 23:00
 * UTC the evening before. Use as `createdAt >= start AND createdAt < end`.
 */
export function lagosDayBounds(now: number): { start: Date; end: Date } {
  const start = Date.parse(`${lagosDate(now)}T00:00:00Z`) - LAGOS_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}
