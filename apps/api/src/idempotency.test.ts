import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprintRequest, isUniqueConstraintError, isValidIdempotencyKey } from './idempotency.js';

test('accepts bounded printable idempotency keys', () => {
  assert.equal(isValidIdempotencyKey('de2177c2-42f0-4d7f-9f4b-5ed46f2117e2'), true);
  assert.equal(isValidIdempotencyKey(''), false);
  assert.equal(isValidIdempotencyKey('contains spaces'), false);
  assert.equal(isValidIdempotencyKey('x'.repeat(129)), false);
  assert.equal(isValidIdempotencyKey(undefined), false);
});

test('fingerprints object properties independent of property order', () => {
  assert.equal(
    fingerprintRequest({ senderId: 'sender', options: { limit: 3, delay: 2 } }),
    fingerprintRequest({ options: { delay: 2, limit: 3 }, senderId: 'sender' }),
  );
  assert.notEqual(fingerprintRequest({ senderId: 'sender-a' }), fingerprintRequest({ senderId: 'sender-b' }));
});

test('recognizes Prisma unique constraint errors', () => {
  assert.equal(isUniqueConstraintError({ code: 'P2002' }), true);
  assert.equal(isUniqueConstraintError({ code: 'P2025' }), false);
  assert.equal(isUniqueConstraintError(new Error('database unavailable')), false);
});
