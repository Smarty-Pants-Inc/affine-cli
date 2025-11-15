import { describe, it, expect } from 'vitest';

import { isEnabled, captureEvent } from '../src/telemetry';

describe('telemetry', () => {
  it('isEnabled respects AFFINE_CLI_TELEMETRY env', () => {
    expect(isEnabled({ AFFINE_CLI_TELEMETRY: '1' } as any)).toBe(true);
    expect(isEnabled({ AFFINE_CLI_TELEMETRY: '0' } as any)).toBe(false);
    expect(isEnabled({} as any)).toBe(false);
  });

  it('captureEvent is a no-op when disabled or URL missing', async () => {
    // Should not throw even when no telemetry URL is configured.
    await captureEvent({ name: 'test', props: { token: 'secret', other: 'value' } });
  });
});
