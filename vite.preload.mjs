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
    outDir: 'dist/preload',
    lib: {
      entry: resolve(import.meta.dirname, 'src/preload/index.ts'),
      name: 'Main',
      fileName: 'index',
      formats: ['cjs'],
    },
    rollupOptions: {
      external: builtins,
    },
  },
  resolve: {
    alias,
  },
})
