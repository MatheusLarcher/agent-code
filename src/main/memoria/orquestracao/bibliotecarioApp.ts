/**
 * Liga o bibliotecário ao app: serviço de memória, cofre, IA pelo caminho dos observadores
 * (login do Claude, sem chave de API — E10) e o modo escolhido em Configurações.
 * Fica fora do `index.ts` para ele não crescer mais.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { PASTAS_GENERICAS } from './bibliotecario'
import { isAutoModel, type MemoristaConfig } from '../../../shared/ipc'
import { memoryService, secretSink } from '../../memory/memoryRuntime'
import { sanitizeProposal } from '../../memory/memorySecrets'
import { runObserverAttempt } from '../../observerQuery'
import { getCacheInfo } from '../../store'
import { AgendaBibliotecario } from './bibliotecarioAgenda'
import { prepararBusca } from './preparar'

/** Modelo do bibliotecário: o do memorista; no Automático, Sonnet (lote de 10 memórias). */
export function modeloBibliotecario(cfg: MemoristaConfig): string {
  return isAutoModel(cfg.model) ? 'claude-sonnet-5-5' : cfg.model
}

export function iniciarBibliotecario(opts: { config(): MemoristaConfig; dadosDir: string; log?(linha: string): void }): { parar(): void; agenda: AgendaBibliotecario } {
  const pasta = join(opts.dadosDir, 'bibliotecario')
  const agenda = new AgendaBibliotecario({
    modo: () => {
      const cfg = opts.config()
      // Memorista desligado = o usuário não quer IA mexendo nas memórias: o bibliotecário segue.
      return cfg.enabled === false ? 'desligado' : cfg.bibliotecario ?? 'simulacao'
    },
    memory: () => memoryService(),
    memoriesDir: () => getCacheInfo().memoriesDir || null,
    relatorioDir: () => pasta,
    perguntar: async (prompt) => {
      const r = await runObserverAttempt({ prompt, model: modeloBibliotecario(opts.config()), provider: 'claude' })
      return r.state === 'completed' ? r.text : null
    },
    sanitize: async (input) => (await sanitizeProposal(input, { vault: secretSink() })).input,
    // 1ª passada: põe as soltas no tema certo antes de procurar repetidas (E4). Pasta
    // genérica (ex.: `projetos`) nunca é destino e as memórias dela contam como soltas (P38).
    preparar: (dir) => prepararBusca(dir, { cacheDir: join(pasta, 'vetores'), bibliotecario: { pastasGenericas: PASTAS_GENERICAS } }),
    mtime: (relPath) => {
      const dir = getCacheInfo().memoriesDir
      try {
        return dir ? statSync(join(dir, relPath)).mtimeMs : null
      } catch {
        return null
      }
    },
    log: opts.log
  })
  return { parar: agenda.iniciar(), agenda }
}
