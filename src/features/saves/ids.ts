/** Identifier helpers for saves and the items inside them. */

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

function getCrypto(): CryptoLike | undefined {
  const c: unknown = (globalThis as { crypto?: unknown }).crypto;
  return typeof c === 'object' && c !== null ? (c as CryptoLike) : undefined;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = getCrypto();
  if (c && typeof c.getRandomValues === 'function') {
    try {
      c.getRandomValues(out);
      return out;
    } catch {
      // fall through to Math.random
    }
  }
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** A new globally unique save id (RFC 4122 v4 UUID). */
export function newSaveId(): string {
  const c = getCrypto();
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // insecure context etc.: use the fallback below
    }
  }
  const b = randomBytes(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A short random id for things inside a save (track nodes, scenery). */
export function newItemId(prefix = 'n'): string {
  const b = randomBytes(8);
  return `${prefix}-${Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('')}`;
}
