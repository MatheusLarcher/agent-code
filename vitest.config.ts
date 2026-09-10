import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Rodando os testes a partir do app EMPACOTADO, o processo herda o
// PLAYWRIGHT_BROWSERS_PATH que ele aponta para o Chromium embutido. Esse
// pacote traz só o `chromium-<rev>` (o app usa o navegador em modo headed);
// o `chrome-headless-shell` que os testes pedem não está lá, e o launch falha
// com "Executable doesn't exist". Os testes usam o cache da própria máquina.
delete process.env.PLAYWRIGHT_BROWSERS_PATH

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    environment: 'jsdom',
    // Mounting the whole app dozens of times under the parallel suite can take
    // well over the 5s default while still passing in isolation.
    testTimeout: 20_000,
    globals: true,
    include: ['src/**/*.test.{ts,tsx}']
  }
})
