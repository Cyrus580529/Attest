import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// key 只活在 dev server 进程里，绝不进浏览器代码。
const key = process.env.ATTEST_API_KEY ?? '';
const target = process.env.ATTEST_BASE_URL ?? 'https://api.deepseek.com';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: {
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
        headers: { Authorization: `Bearer ${key}` },
      },
    },
  },
});
