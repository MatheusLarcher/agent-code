/**
 * Harness DEV do Escritório 3D: serve só o <Office3DWorkspace> (sem Electron,
 * sem banco, sem o app em uso) para ver e exercitar o 3D num navegador.
 * O modo demonstração (Ctrl+Alt+Shift+D) liga o feed e o Quadro falsos;
 * Ctrl+Alt+Shift+P abre o HUD de desempenho.
 *
 *   npx vite --config scripts/office3d-harness/vite.config.mts
 *
 * `HARNESS_SRC` aponta para outra cópia do src/ (ex.: um worktree da versão
 * anterior, para medir o "antes" no mesmo navegador).
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const repo = resolve(__dirname, '../..')
const src = process.env.HARNESS_SRC ? resolve(process.env.HARNESS_SRC) : resolve(repo, 'src')

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@shared': resolve(src, 'shared'),
      '@harness-renderer': resolve(src, 'renderer/src')
    }
  },
  plugins: [react()],
  server: { port: Number(process.env.HARNESS_PORT ?? 6611), strictPort: true, fs: { allow: [repo, src] } }
})
