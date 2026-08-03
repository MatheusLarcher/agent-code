// Config isolada só para os testes de aceitação do benchmark — a config principal
// do projeto só enxerga `src/**`, e os testes do bench moram em docs/bench.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export default defineConfig({
  root: repo,
  plugins: [react()],
  resolve: {
    alias: { '@shared': resolve(repo, 'src/shared') }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['docs/bench/acceptance/**/*.acceptance.test.{ts,tsx}']
  }
})
