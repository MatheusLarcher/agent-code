/**
 * Liga o importador (manual e automático) ao app Homol: caminhos da origem, agenda, relatório
 * e os canais da tela. Fora do index.ts para ele não crescer mais.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Channels } from '../../shared/ipc'
import type { MemoryProposeInput } from '../memory/memoryModel'
import type { PersistenceRepository } from '../persistence/types'
import {
  estadoEmArquivo,
  IMPORTACAO_ATRASO_INICIAL_MS,
  IMPORTACAO_INTERVALO_MS,
  marcaDaPasta,
  relatorioImportacao,
  rodarImportacao,
  type PortaMemoriaImportacao
} from './importacaoAutomatica'
import { ImportadorPrincipal } from './importarDoPrincipal'

const LOCAL = (): string => process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')

/** Pasta de memórias do Agent Code original: a do ponteiro `~\.agent-code\location.json`,
 *  ou a padrão em Documentos. */
export function memoriasDoOriginal(): string | null {
  try {
    const p = JSON.parse(readFileSync(join(homedir(), '.agent-code', 'location.json'), 'utf8')) as { cacheDir?: string }
    if (p.cacheDir && existsSync(join(p.cacheDir, 'memories'))) return join(p.cacheDir, 'memories')
  } catch {
    /* sem ponteiro: tenta a padrão */
  }
  const padrao = join(homedir(), 'Documents', 'agent-code', 'memories')
  return existsSync(padrao) ? padrao : null
}

export interface DepsImportacaoApp {
  handle(canal: string, fn: (_e: unknown, ...args: unknown[]) => unknown): void
  disponivel(): boolean
  binDir(): string
  tmpDir(): string
  dadosDir(): string
  repositorio(): Pick<PersistenceRepository, 'loadConversations' | 'upsertConversation'>
  memoria(): PortaMemoriaImportacao | null
  sanitize(input: MemoryProposeInput): Promise<MemoryProposeInput>
  log(linha: string): void
}

export function iniciarImportacao(d: DepsImportacaoApp): () => void {
  const pasta = join(d.dadosDir(), 'importacao')
  const estado = estadoEmArquivo(pasta)
  const origemPgdata = (): string => join(LOCAL(), 'agent-code', 'pgdata')
  const importador = new ImportadorPrincipal({
    origemPgdata,
    binDir: d.binDir,
    tmpDir: d.tmpDir,
    repositorio: d.repositorio,
    disponivel: d.disponivel,
    // A importação manual também fica registrada: a automática sabe depois se a conversa
    // foi mexida aqui (revisão) antes de atualizá-la.
    aoImportar: async (id, origemEm, revisao) => {
      const e = await estado.lerEstado()
      e.conversas[id] = { origemEm, revisao }
      await estado.gravarEstado(e)
    }
  })

  d.handle(Channels.importarPrincipalListar, () => importador.listar())
  d.handle(Channels.importarPrincipalImportar, (_e, ids) =>
    Array.isArray(ids) && ids.every((id) => typeof id === 'string') && ids.length <= 5000
      ? importador.importar(ids as string[])
      : { ok: false, error: 'Lista de conversas inválida.' }
  )
  d.handle(Channels.importarAutoStatus, async () => {
    const e = await estado.lerEstado()
    return { disponivel: d.disponivel(), ligado: e.ligado, ultimaEm: e.ultimaEm ?? null, ultimoResumo: e.ultimoResumo ?? null }
  })
  d.handle(Channels.importarAutoSet, async (_e, ligado) => {
    if (typeof ligado !== 'boolean') return { ok: false, error: 'Valor inválido.' }
    const e = await estado.lerEstado()
    e.ligado = ligado
    // Religar: a próxima passada lê a origem de novo, mesmo sem mudança no banco dela.
    if (ligado) delete e.origemMarca
    await estado.gravarEstado(e)
    if (ligado && d.disponivel()) agendar(5_000)
    return { ok: true }
  })

  if (!d.disponivel()) return () => undefined

  let rodando = false
  let parado = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const passada = async (): Promise<void> => {
    if (rodando) return
    rodando = true
    try {
      const r = await rodarImportacao({
        lerOrigem: () => importador.lerOrigem(),
        repositorio: d.repositorio,
        memoria: d.memoria,
        origemMemorias: memoriasDoOriginal,
        marcaOrigem: () => marcaDaPasta(origemPgdata()),
        sanitize: d.sanitize,
        ...estado
      })
      if (r.status === 'feita' || r.status === 'erro') {
        await mkdir(pasta, { recursive: true })
        await writeFile(join(pasta, 'ultima-importacao.md'), relatorioImportacao(r, Date.now()), 'utf8')
        d.log(`[importacao] ${r.status}: ${r.novas.length} novas, ${r.atualizadas.length} atualizadas, ${r.conflitos.length} conflitos, ${r.memoriasNovas.length} memórias novas${r.erro ? ` — ${r.erro}` : ''}`)
      }
    } catch (e) {
      d.log(`[importacao] passada falhou: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      rodando = false
    }
  }
  const agendar = (ms: number): void => {
    if (parado) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void passada().finally(() => agendar(IMPORTACAO_INTERVALO_MS)), ms)
    timer.unref?.()
  }
  agendar(IMPORTACAO_ATRASO_INICIAL_MS)
  return () => {
    parado = true
    if (timer) clearTimeout(timer)
  }
}
