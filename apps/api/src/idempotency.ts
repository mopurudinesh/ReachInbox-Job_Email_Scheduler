import { createHash } from 'node:crypto';

export function isValidIdempotencyKey(value: string | undefined): value is string {
  return value !== undefined && /^[\x21-\x7e]{1,128}$/.test(value);
}

export function fingerprintRequest(value: unknown): string {
  const canonicalize = (_key: string, item: unknown): unknown => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
      );
    }
    return item;
  };

  return createHash('sha256').update(JSON.stringify(value, canonicalize)).digest('hex');
}

export function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
