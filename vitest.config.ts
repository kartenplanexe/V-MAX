import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Advisory locks span schemas; run SQL suites sequentially.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
