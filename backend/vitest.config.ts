import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Keep Fastify's request log out of the test output.
    env: { LOG_LEVEL: 'silent' },
  },
});
