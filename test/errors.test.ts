import { describe, it, expect } from 'vitest';

import { withHints } from '../src/errors';

describe('errors.withHints', () => {
  it('returns message unchanged when no hints are provided', () => {
    const msg = 'Something went wrong';
    expect(withHints(msg)).toBe(msg);
    expect(withHints(msg, [])).toBe(msg);
  });

  it('appends a Hints section with each hint on its own line', () => {
    const msg = 'Semantic search failed';
    const out = withHints(msg, ['First hint', 'Second hint']);
    const lines = out.split(/\r?\n/);
    expect(lines[0]).toBe(msg);
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('Hints:');
    expect(lines).toContain(' - First hint');
    expect(lines).toContain(' - Second hint');
  });
});
