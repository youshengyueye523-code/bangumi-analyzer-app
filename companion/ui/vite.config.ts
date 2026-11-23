import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Companion UI 原型：独立于 packages/web，不参与根 workspace 构建。
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
