import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { builtinModules } from 'node:module'
import { alias } from './vite.config.mjs'

const builtins = builtinModules.filter((item) => !item.startsWith('_'))
builtins.push('electron', ...builtins.map((item) => `node:${item}`))

export default defineConfig({
  build: {
    minify: 'esbuild',
    target: 'node24',
    outDir: 'dist/main',
    lib: {
      entry: resolve(import.meta.dirname, 'src/main/index.ts'),
      name: 'Main',
      fileName: 'index',
      formats: ['cjs'],
    },
    rollupOptions: {
      external: builtins,
    },
  },
  resolve: {
    mainFields: ['main', 'module'],
    alias,
  },
})
