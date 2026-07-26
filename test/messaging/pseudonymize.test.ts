import { describe, it, expect } from 'vitest';
import { pseudonymizePhone } from '../../src/messaging/pseudonymize';

const SECRET = 'hmac-secret';

describe('pseudonymizePhone', () => {
  it('is deterministic for the same phone and secret', () => {
    const a = pseudonymizePhone('+54 9 11 0000-0000', SECRET);
    const b = pseudonymizePhone('+54 9 11 0000-0000', SECRET);
    expect(a).toBe(b);
  });

  it('normalizes formatting so equivalent phones match', () => {
    const a = pseudonymizePhone('+5491100000000', SECRET);
    const b = pseudonymizePhone('54-9-11-0000-0000', SECRET);
    expect(a).toBe(b);
  });

  it('produces a 64-char hex string', () => {
    const id = pseudonymizePhone('+5491100000000', SECRET);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when the secret changes', () => {
    const a = pseudonymizePhone('+5491100000000', SECRET);
    const b = pseudonymizePhone('+5491100000000', 'other-secret');
    expect(a).not.toBe(b);
  });

  it('never contains the raw phone digits', () => {
    const id = pseudonymizePhone('+5491100000000', SECRET);
    expect(id).not.toContain('5491100000000');
  });

  it('throws when the secret is empty', () => {
    expect(() => pseudonymizePhone('+5491100000000', '')).toThrow();
  });
});
