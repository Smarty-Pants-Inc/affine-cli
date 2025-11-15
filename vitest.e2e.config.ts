import { defineConfig } from 'vitest/config';

// E2E configuration for running against a live AFFiNE server.
// Tests are gated by AFFINE_E2E and AFFINE_* env vars via loadE2EEnv().
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    globals: true,
    // E2E tests talk to a real server, so give them a bit more time by default.
    testTimeout: 60000,
    globalSetup: ['./test/e2e/global-setup.ts'],
  },
});
