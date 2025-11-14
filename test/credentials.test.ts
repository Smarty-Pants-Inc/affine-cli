import { describe, it, expect } from 'vitest';

import { redactValue, redactConfigDeep, readCredentialsFromEnv } from '../src/credentials';

describe('credentials redaction', () => {
  it('redactValue masks middle characters while keeping prefix/suffix', () => {
    const v = 'abcdefghij';
    const redacted = redactValue(v);
    // Default: first 4, last 2 visible
    expect(redacted.startsWith('abcd')).toBe(true);
    expect(redacted.endsWith('ij')).toBe(true);
    expect(redacted.length).toBe(v.length);
  });

  it('redactConfigDeep redacts known sensitive keys recursively', () => {
    const cfg = {
      token: 'secret-token',
      nested: {
        cookie: 'cookie-secret',
        other: 'keep-me',
      },
    };
    const out = redactConfigDeep(cfg);
    expect(out.token).not.toBe('secret-token');
    expect(out.nested.cookie).not.toBe('cookie-secret');
    expect(out.nested.other).toBe('keep-me');
  });

  it('readCredentialsFromEnv only returns non-empty token/cookie values', () => {
    const env = {
      AFFINE_TOKEN: ' tok ',
      AFFINE_COOKIE: ' ',
    } as any;
    const creds = readCredentialsFromEnv(env);
    expect(creds.token).toBe('tok');
    expect('cookie' in creds).toBe(false);
  });
});
