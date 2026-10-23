import test from 'node:test';
import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import { uuid } from '../shared/uuid.js';

test('HTTP LAN ID generation works without randomUUID and produces valid unique UUID v4 IDs', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: (bytes) => randomFillSync(bytes) },
  });
  try {
    const ids = Array.from({ length: 1000 }, () => uuid());
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids)
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});
