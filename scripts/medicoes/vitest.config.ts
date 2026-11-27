// Testes dos scripts de medição. Ficam fora do `npm test` (o vitest da raiz só
// olha src/). Rodar com: npx vitest run -c scripts/medicoes/vitest.config.ts
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['**/*.test.ts'],
    environment: 'node'
  }
})
