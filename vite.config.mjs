import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs-extra'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export const alias = {
  common: path.resolve(rootDir, 'src/common'),
  share: path.resolve(rootDir, 'src/share'),
}

export default defineConfig(async () => {
  const pkg = await fs.readJSON(path.resolve(rootDir, 'package.json'))
  return {
    base: '',
    plugins: [react()],
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          app: './index.html',
        },
        output: {
          manualChunks(id) {
            if (id.includes('/@xterm/')) return 'xterm'
            if (id.includes('/@yume-chan/')) return 'cast'
            if (id.includes('/luna-')) return 'luna'
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/mobx')
            ) {
              return 'ui-runtime'
            }
          },
        },
      },
    },
    css: {
      modules: {
        localsConvention: 'camelCaseOnly',
      },
      preprocessorOptions: {
        scss: {
          api: 'modern',
        },
      },
    },
    server: {
      hmr: false,
      port: 8080,
    },
    define: {
      PRODUCT_NAME: JSON.stringify(pkg.productName),
      VERSION: JSON.stringify(pkg.version),
    },
    optimizeDeps: {
      exclude: ['@yume-chan/pcm-player'],
    },
    resolve: {
      alias,
    },
  }
})
