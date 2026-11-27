/**
 * Importação automática do Agent Code original para a Homol (aprovada pelo Erick, 27/11).
 *
 * De 30 em 30 minutos (e ao abrir), se ligada:
 *  - conversas NOVAS da origem entram aqui;
 *  - conversa já trazida que mudou na origem é ATUALIZADA só se não foi mexida aqui desde a
 *    importação (mesma revisão); mexida nos dois lados = conflito, a daqui fica como está;
 *  - conversa apagada aqui não volta;
 *  - as MEMÓRIAS que essas conversas usaram (context_turn.memories_json da origem) vêm junto,
 *    sem duplicar: igual (ou quase) a uma daqui é pulada; mesmo caminho com texto diferente não
 *    sobrescreve; nova entra com `origem: importada do Agent Code` e o tema da pasta. A separação
 *    fina por tema é do bibliotecário, que roda de hora em hora.
 * Zona morta: se a pasta do banco da origem não mudou desde a última passada, nem copia.
 * Nunca apaga nada; toda escrita de memória passa pelo serviço (CAS + varredura de segredos).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryProposeInput } from '../memory/memoryModel'
import type { PersistenceRepository } from '../persistence/types'
import { comCampos, separar } from '../memoria/cabecalho'
import type { LeituraOrigem } from './importarDoPrincipal'

export const IMPORTACAO_AGENT = 'importacao'
export const IMPORTACAO_INTERVALO_MS = 30 * 60_000
export const IMPORTACAO_ATRASO_INICIAL_MS = 2 * 60_000

export interface EstadoImportacao {
  ligado: boolean
  /** Marca da pasta do banco da origem na última passada (zona morta). */
  origemMarca?: string
  ultimaEm?: string
  ultimoResumo?: string
  conversas: Record<string, { origemEm: string | null; revisao: number }>
}

/** Estado novo a cada chamada (o mapa de conversas é mutado durante a passada). */
export const estadoInicial = (): EstadoImportacao => ({ ligado: true, conversas: {} })

export interface PortaMemoriaImportacao {
  listEntries(q?: { status?: 'active' | 'retired' }): Promise<Array<{ relPath: string; body: string; status: string }>>
  propose(input: MemoryProposeInput): Promise<unknown>
  applyPending(): Promise<unknown>
}

export interface DepsImportacao {
  lerOrigem(): Promise<LeituraOrigem>
  repositorio(): Pick<PersistenceRepository, 'loadConversations' | 'upsertConversation'>
  memoria(): PortaMemoriaImportacao | null
  /** Pasta de memórias do app de origem; null se não achar. */
  origemMemorias(): string | null
  /** Marca da pasta do banco da origem (muda quando o banco muda); null = origem ausente. */
  marcaOrigem(): string | null
  sanitize(input: MemoryProposeInput): Promise<MemoryProposeInput>
  lerEstado(): Promise<EstadoImportacao>
  gravarEstado(e: EstadoImportacao): Promise<void>
  now?(): number
}

export interface ResultadoImportacao {
  status: 'desligada' | 'sem-origem' | 'sem-mudanca' | 'feita' | 'erro'
  novas: string[]
  atualizadas: string[]
  conflitos: string[]
  memoriasNovas: string[]
  memoriasJaExistiam: number
  memoriasDiferentes: string[]
  erro?: string
}

const vazio = (status: ResultadoImportacao['status'], erro?: string): ResultadoImportacao => ({
  status, novas: [], atualizadas: [], conflitos: [], memoriasNovas: [], memoriasJaExistiam: 0, memoriasDiferentes: [], ...(erro ? { erro } : {})
})

/** Corpo comparável: sem cabeçalho, sem acento, minúsculo, espaços juntos. */
export function normalizarCorpo(conteudo: string): string {
  return separar(conteudo).corpo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Semelhança de Jaccard entre as palavras (≥ 3 letras) de dois textos normalizados. */
export function jaccard(a: string, b: string): number {
  const pa = new Set(a.split(/[^a-z0-9]+/).filter((w) => w.length >= 3))
  const pb = new Set(b.split(/[^a-z0-9]+/).filter((w) => w.length >= 3))
  if (!pa.size || !pb.size) return 0
  let comum = 0
  for (const w of pa) if (pb.has(w)) comum++
  return comum / (pa.size + pb.size - comum)
}

/** Caminho em kebab-case (o serviço exige para memória nova); mantém as pastas. */
export function caminhoKebab(rel: string): string {
  const slug = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'memoria'
  const partes = rel.replace(/\\/g, '/').split('/').filter(Boolean)
  const arq = partes.pop() ?? 'memoria.md'
  return [...partes.map(slug), `${slug(arq.replace(/\.md$/i, ''))}.md`].join('/')
}

function tituloEGancho(conteudo: string, rel: string): { title: string; hook: string } {
  const { front, corpo } = separar(conteudo)
  const title = /^#\s+(.+)$/m.exec(corpo)?.[1]?.trim() || rel.split('/').pop()!.replace(/\.md$/i, '').replace(/-/g, ' ')
  const hook = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() || title
  return { title: title.slice(0, 120), hook: hook.slice(0, 200) }
}

/** Uma passada. Nunca lança: erro vira status 'erro'. */
export async function rodarImportacao(deps: DepsImportacao): Promise<ResultadoImportacao> {
  let estado: EstadoImportacao
  try {
    estado = await deps.lerEstado()
  } catch {
    estado = estadoInicial()
  }
  if (!estado.ligado) return vazio('desligada')
  const marca = deps.marcaOrigem()
  if (!marca) return vazio('sem-origem')
  if (marca === estado.origemMarca) return vazio('sem-mudanca')
  const r = vazio('feita')
  try {
    const leitura = await deps.lerOrigem()
    const repo = deps.repositorio()
    const ids = leitura.linhas.map((l) => l.id)
    const aqui = new Map((ids.length ? await repo.loadConversations({ ids, includeDeleted: true }) : []).map((c) => [c.id, c]))
    const trazer: string[] = []
    for (const l of leitura.linhas) {
      const origemEm = l.updated_at ? new Date(l.updated_at).toISOString() : null
      const titulo = typeof l.payload.title === 'string' && l.payload.title.trim() ? l.payload.title : l.id
      const existente = aqui.get(l.id)
      const reg = estado.conversas[l.id]
      if (!existente) {
        const g = await repo.upsertConversation({ id: l.id, payload: l.payload as never })
        estado.conversas[l.id] = { origemEm, revisao: g.revision }
        r.novas.push(titulo)
        trazer.push(l.id)
        continue
      }
      if (existente.deletedAt || !reg || !origemEm || (reg.origemEm && origemEm <= reg.origemEm)) continue
      if (existente.revision !== reg.revisao) {
        r.conflitos.push(titulo)
        continue
      }
      const g = await repo.upsertConversation({ id: l.id, payload: l.payload as never, expectedRevision: existente.revision })
      estado.conversas[l.id] = { origemEm, revisao: g.revision }
      r.atualizadas.push(titulo)
      trazer.push(l.id)
    }
    await trazerMemorias(deps, leitura, trazer, r)
    estado.origemMarca = marca
  } catch (e) {
    r.status = 'erro'
    r.erro = e instanceof Error ? e.message : String(e)
  }
  estado.ultimaEm = new Date(deps.now?.() ?? Date.now()).toISOString()
  estado.ultimoResumo = resumoCurto(r)
  await deps.gravarEstado(estado).catch(() => undefined)
  return r
}

async function trazerMemorias(deps: DepsImportacao, leitura: LeituraOrigem, convs: string[], r: ResultadoImportacao): Promise<void> {
  const caminhos = new Set<string>()
  for (const id of convs) for (const p of leitura.memorias.get(id) ?? []) caminhos.add(p)
  const dir = deps.origemMemorias()
  const memoria = deps.memoria()
  if (!caminhos.size || !dir || !memoria) return
  const entradas = (await memoria.listEntries({ status: 'active' })).filter((e) => e.status === 'active')
  const porCaminho = new Map(entradas.map((e) => [e.relPath.toLowerCase(), e]))
  const corpos = entradas.map((e) => normalizarCorpo(e.body))
  const usados = new Set(entradas.map((e) => e.relPath.toLowerCase()))
  let gravou = false
  for (const rel of [...caminhos].sort()) {
    const arquivo = join(dir, ...rel.split('/'))
    if (!existsSync(arquivo)) continue
    const conteudo = readFileSync(arquivo, 'utf8')
    const corpo = normalizarCorpo(conteudo)
    const mesmo = porCaminho.get(rel.toLowerCase())
    if (mesmo) {
      if (normalizarCorpo(mesmo.body) === corpo) r.memoriasJaExistiam++
      else r.memoriasDiferentes.push(rel) // mesmo caminho, texto diferente: não sobrescreve
      continue
    }
    if (corpos.some((c) => c === corpo || jaccard(c, corpo) >= 0.85)) {
      r.memoriasJaExistiam++
      continue
    }
    let destino = caminhoKebab(rel)
    for (let n = 2; usados.has(destino.toLowerCase()); n++) destino = destino.replace(/(-\d+)?\.md$/, `-${n}.md`)
    usados.add(destino.toLowerCase())
    const pasta = destino.includes('/') ? destino.split('/')[0] : undefined
    const { title, hook } = tituloEGancho(conteudo, rel)
    const body = comCampos(conteudo, { origem: 'importada do Agent Code', ...(pasta && !/^tema:/m.test(separar(conteudo).front) ? { tema: pasta } : {}) })
    try {
      await memoria.propose(await deps.sanitize({ op: 'create', relPath: destino, title, hook, body, scope: 'user', proposedBy: IMPORTACAO_AGENT, originAgent: IMPORTACAO_AGENT }))
      corpos.push(corpo)
      r.memoriasNovas.push(destino)
      gravou = true
    } catch {
      /* uma recusada não derruba as outras */
    }
  }
  if (gravou) await memoria.applyPending()
}

export function resumoCurto(r: ResultadoImportacao): string {
  if (r.status === 'erro') return `falhou: ${r.erro ?? ''}`
  return `${r.novas.length} nova(s), ${r.atualizadas.length} atualizada(s), ${r.conflitos.length} em conflito; memórias: ${r.memoriasNovas.length} nova(s), ${r.memoriasJaExistiam} já existiam, ${r.memoriasDiferentes.length} diferente(s)`
}

export function relatorioImportacao(r: ResultadoImportacao, quando: number): string {
  const l = [`# Importação do Agent Code — ${new Date(quando).toLocaleString('pt-BR')}`, '', `Resultado: **${r.status}** — ${resumoCurto(r)}`, '']
  const bloco = (titulo: string, itens: string[]): void => {
    if (itens.length) l.push(`## ${titulo} (${itens.length})`, ...itens.map((x) => `- ${x}`), '')
  }
  bloco('Conversas novas', r.novas)
  bloco('Conversas atualizadas', r.atualizadas)
  bloco('Em conflito (mexidas aqui e lá; a daqui ficou como está)', r.conflitos)
  bloco('Memórias novas', r.memoriasNovas)
  bloco('Memórias com o mesmo caminho e texto diferente (não sobrescritas)', r.memoriasDiferentes)
  return l.join('\n')
}

/** Marca da pasta do banco: o mtime mais recente do WAL e do controle (muda quando o banco grava). */
export function marcaDaPasta(pgdata: string): string | null {
  if (!existsSync(join(pgdata, 'PG_VERSION'))) return null
  let max = 0
  try {
    max = statSync(join(pgdata, 'global', 'pg_control')).mtimeMs
    for (const n of readdirSync(join(pgdata, 'pg_wal'))) max = Math.max(max, statSync(join(pgdata, 'pg_wal', n)).mtimeMs)
  } catch {
    return String(Date.now()) // sem como medir: trata como mudou
  }
  return String(Math.floor(max))
}

/** Estado em arquivo JSON (pasta do app). */
export function estadoEmArquivo(dir: string): Pick<DepsImportacao, 'lerEstado' | 'gravarEstado'> {
  const arq = join(dir, 'estado.json')
  return {
    lerEstado: async () => {
      try {
        const lido = JSON.parse(await readFile(arq, 'utf8')) as Partial<EstadoImportacao>
        return { ...estadoInicial(), ...lido, conversas: { ...(lido.conversas ?? {}) } }
      } catch {
        return estadoInicial()
      }
    },
    gravarEstado: async (e) => {
      await mkdir(dir, { recursive: true })
      await writeFile(arq, JSON.stringify(e, null, 2), 'utf8')
    }
  }
}
