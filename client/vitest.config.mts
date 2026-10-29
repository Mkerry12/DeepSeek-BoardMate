import { defineConfig } from 'vitest/config';
import { buildDefines } from './build-env';

export default defineConfig({
  define: buildDefines({}),
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
