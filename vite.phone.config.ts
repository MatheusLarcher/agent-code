import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Build do app do celular (Agent Remote): fonte em src/phone, saída em
 * smartfone-remote/www — o que o Capacitor empacota no APK e o PC serve em /app.
 *
 * Fica no projeto raiz de propósito: o que o celular importa do desktop
 * (Markdown, toolDescribe, tipos de @shared) resolve react/react-markdown do
 * node_modules da raiz — uma cópia só do React (duas quebram os hooks).
 *
 * `base: './'`: os assets carregam relativos tanto em /app/ (ponte do PC) quanto
 * no http://localhost do WebView. Nomes fixos (sem hash) porque o www/ gerado é
 * versionado: um build igual não muda arquivo nenhum no git.
 */
const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: r('./src/phone'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@renderer': r('./src/renderer/src')
    }
  },
  build: {
    outDir: r('./smartfone-remote/www'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    // Um bundle só (React + Markdown + realce do desktop), carregado do disco do aparelho.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  },
  server: {
    // `npm run phone:dev`: o cliente no navegador fala com a ponte do PC (ou a
    // ponte de teste de scripts/phone) pelo mesmo endereço — /api vai para ela.
    proxy: { '/api': process.env.PHONE_BRIDGE ?? 'http://127.0.0.1:8765' }
  }
})
