/**
 * Quando o bibliotecário roda (D28: de 1 em 1 hora, fora da conversa).
 *
 * É um regulador com zona morta: a passada só trabalha se o acervo mudou desde a última
 * (assinatura = caminho + revisão de cada memória) ou se ficou trabalho pendente (lote da IA
 * que não coube). Sem mudança, não carrega o modelo de sentido nem chama a IA.
 * Uma passada por vez; erro numa passada não derruba o app nem a próxima.
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryProposeInput } from '../../memory/memoryModel'
import {
  aplicarPassada,
  planejarPassada,
  relatorioMarkdown,
  type EntradaBibliotecario,
  type ModoBibliotecario,
  type OpcoesPassada,
  type PerguntarIA,
  type PortaMemoria,
  type ResultadoAplicar
} from './bibliotecario'
import type { BuscaPreparada } from './preparar'

export const BIBLIOTECARIO_INTERVALO_MS = 60 * 60_000
/** Primeira passada alguns minutos depois de abrir: o app sobe sem disputar CPU/RAM. */
export const BIBLIOTECARIO_ATRASO_INICIAL_MS = 5 * 60_000
/** Passadas guardadas em `historico/` (as mais recentes). */
export const BIBLIOTECARIO_HISTORICO = 50

export interface DepsAgenda {
  modo(): ModoBibliotecario
  memory(): (PortaMemoria & { listEntries(q?: { status?: 'active' | 'retired' }): Promise<EntradaBibliotecario[]> }) | null
  memoriesDir(): string | null
  /** Onde o relatório vai (fora da pasta de memórias, senão vira memória). */
  relatorioDir(): string
  perguntar?: PerguntarIA
  sanitize(input: MemoryProposeInput): Promise<MemoryProposeInput>
  preparar(dir: string): Promise<BuscaPreparada>
  /** Data de modificação do arquivo (para memórias importadas — ver `datasConfiaveis`). */
  mtime?(relPath: string): number | null
  now?(): number
  log?(linha: string): void
  opcoes?: OpcoesPassada
}

export interface ResultadoPassada {
  status: 'desligado' | 'sem-acervo' | 'sem-mudanca' | 'ocupado' | 'feita' | 'erro'
  modo?: ModoBibliotecario
  resultado?: ResultadoAplicar
}

function assinatura(entries: readonly EntradaBibliotecario[]): string {
  return entries.map((e) => `${e.relPath}#${e.revision}`).sort().join('|')
}

export class AgendaBibliotecario {
  private ultimaAssinatura = ''
  private pendente = false
  private rodando = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private parado = false

  constructor(private readonly deps: DepsAgenda) {}

  /** Uma passada agora (também usada pelo agendador). Nunca lança. */
  async passada(): Promise<ResultadoPassada> {
    const modo = this.deps.modo()
    if (modo === 'desligado') return { status: 'desligado' }
    if (this.rodando) return { status: 'ocupado' }
    this.rodando = true
    try {
      const memory = this.deps.memory()
      const dir = this.deps.memoriesDir()
      if (!memory || !dir) return { status: 'sem-acervo' }
      const entries = (await memory.listEntries({ status: 'active' })).filter((e) => e.status === 'active')
      const sig = `${modo}::${assinatura(entries)}`
      if (sig === this.ultimaAssinatura && !this.pendente) return { status: 'sem-mudanca', modo }

      const now = this.deps.now?.() ?? Date.now()
      const prep = await this.deps.preparar(dir)
      const plano = planejarPassada(entries, prep, this.deps.opcoes)
      let resultado: ResultadoAplicar | undefined
      if (modo === 'ligado') {
        resultado = await aplicarPassada(plano, entries, {
          memory,
          perguntar: this.deps.perguntar,
          sanitize: this.deps.sanitize,
          temasExistentes: prep.ctx.sentido.temas(),
          now,
          mtime: this.deps.mtime
        }, this.deps.opcoes)
      }
      await this.relatar(modo, plano, now, resultado)
      // Depois de gravar, o acervo mudou (revisões novas): a assinatura de agora já está
      // velha e a próxima passada relê. Pendente = lote da IA que não coube nesta.
      this.ultimaAssinatura = resultado?.mudancas.length ? '' : sig
      this.pendente = (resultado?.pendentesIA ?? 0) > 0 && (resultado?.chamadasIA ?? 0) > 0
      this.deps.log?.(
        `[bibliotecario] ${modo}: ${plano.temas.length} temas, ${plano.repetidas.length} repetidas, ${plano.completar.length} no layout antigo` +
          (resultado ? `; gravou ${resultado.mudancas.length}, IA ${resultado.chamadasIA}, recusadas ${resultado.falhas}` : '')
      )
      return { status: 'feita', modo, resultado }
    } catch (error) {
      this.deps.log?.(`[bibliotecario] passada falhou: ${error instanceof Error ? error.message : String(error)}`)
      return { status: 'erro', modo }
    } finally {
      this.rodando = false
    }
  }

  iniciar(intervaloMs = BIBLIOTECARIO_INTERVALO_MS, atrasoInicialMs = BIBLIOTECARIO_ATRASO_INICIAL_MS): () => void {
    const agendar = (ms: number): void => {
      if (this.parado) return
      this.timer = setTimeout(() => {
        void this.passada().finally(() => agendar(intervaloMs))
      }, ms)
      this.timer.unref?.()
    }
    agendar(atrasoInicialMs)
    return () => {
      this.parado = true
      if (this.timer) clearTimeout(this.timer)
    }
  }

  private async relatar(modo: ModoBibliotecario, plano: ReturnType<typeof planejarPassada>, now: number, r?: ResultadoAplicar): Promise<void> {
    const dir = this.deps.relatorioDir()
    await mkdir(dir, { recursive: true })
    const md = relatorioMarkdown(modo, plano, now, r)
    await writeFile(join(dir, 'ultima-passada.md'), md, 'utf8')
    await writeFile(join(dir, 'ultima-passada.json'), JSON.stringify({ modo, quando: new Date(now).toISOString(), plano, resultado: r ?? null }, null, 2), 'utf8')
    // Histórico (monitoramento): uma cópia por passada, as últimas BIBLIOTECARIO_HISTORICO.
    // A passada só acontece quando o acervo muda, então isto cresce devagar.
    const hist = join(dir, 'historico')
    await mkdir(hist, { recursive: true })
    await writeFile(join(hist, `${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`), md, 'utf8')
    const antigos = (await readdir(hist)).filter((n) => n.endsWith('.md')).sort().slice(0, -BIBLIOTECARIO_HISTORICO)
    await Promise.all(antigos.map((n) => rm(join(hist, n), { force: true })))
  }
}
