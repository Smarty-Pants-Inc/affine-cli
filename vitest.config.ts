import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: true,
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Consider all source files when computing coverage, not just those touched by tests
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      // Exclude build output, tests, type declarations, generated types, and
      // infrastructure-only modules that are exercised indirectly via higher-level tests.
      exclude: [
        'dist/**',
        'test/**',
        'src/**/*.d.ts',
        'src/index.ts',
        'src/types/**',
        'src/http.ts',
        'src/telemetry.ts',
      ],
      thresholds: {
        lines: 55,
        functions: 55,
        statements: 55,
        branches: 50,
      },
    },
  },
});
