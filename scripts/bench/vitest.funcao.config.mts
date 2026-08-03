// Config isolada dos testes de aceitação do desafio de função.
import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export default defineConfig({
  root: repo,
  resolve: { alias: { '@shared': resolve(repo, 'src/shared') } },
  test: {
    environment: 'node',
    globals: true,
    include: ['docs/bench/acceptance-funcao/**/*.acceptance.test.ts']
  }
})
