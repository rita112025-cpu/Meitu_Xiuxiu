import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    // 只收錄 Vitest 測試（*.test.js）；Node 內建測試（*.test.mjs）與瀏覽器測試由 npm 指令分別執行
    include: ['tests/**/*.test.js'],
  },
});
