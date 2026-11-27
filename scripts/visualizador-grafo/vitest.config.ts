import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Testes do visualizador ficam fora do `vitest.config` da raiz (que só cobre src/).
// Rodar: npx vitest run -c scripts/visualizador-grafo/vitest.config.ts
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['**/*.test.ts'],
    environment: 'node'
  }
})
