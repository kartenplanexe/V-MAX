import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // SQL suites intentionally exercise the same database-wide capacity locks.
    // Separate schemas do not isolate PostgreSQL advisory locks; run those suites
    // sequentially while preserving explicit concurrency checks inside each test.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
