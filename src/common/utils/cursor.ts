// Opaque keyset cursors for newest-first lists ordered by (created_at, id). The client passes
// `meta.nextCursor` back as `?cursor=`; it only positions the list, and every query still
// applies the caller's own filters, so a hand-made cursor can't reach anyone else's data.

export interface CursorPosition {
  createdAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.createdAt.toISOString(), position.id])).toString(
    'base64url',
  );
}

/** The position, or null if the cursor isn't one of ours (malformed or tampered with). */
export function decodeCursor(cursor: string): CursorPosition | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [time, id] = parsed as unknown[];
    if (typeof time !== 'string' || typeof id !== 'string' || !UUID.test(id)) return null;
    const createdAt = new Date(time);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== time) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
