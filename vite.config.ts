/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Library build: dist/bill-analyzer.js (ESM, exports mount) and dist/bill-analyzer.css (scoped under .mi-bill).
// The parsing worker is inlined, so the bundle is two files and loads nothing else.
export default defineConfig({
  build: {
    target: 'es2022',
    lib: {
      entry: 'src/ui/index.ts',
      formats: ['es'],
      fileName: () => 'bill-analyzer.js',
      cssFileName: 'bill-analyzer',
    },
    sourcemap: false,
    emptyOutDir: true,
  },
  worker: { format: 'es' },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
