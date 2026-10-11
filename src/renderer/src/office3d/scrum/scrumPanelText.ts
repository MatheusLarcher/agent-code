/**
 * Os textos e as contas do painel do Scrum Master (ScrumPanel.tsx), sem React:
 * o status do envio ("2,1× do prazo"), a trilha 0→300%, o chip do veredito, o
 * verbo de cada item do Histórico e o agrupamento por dia.
 */
import {
  avisouVoce,
  type ScrumDecisao,
  type ScrumDecisaoTipo,
  type ScrumEnvioView,
  type ScrumGatilho,
  type ScrumHistoryItem,
  type ScrumTipoDesvio,
  type ScrumVereditoTipo
} from '@shared/scrumPanel'

const MIN_MS = 60_000
const DAY_MS = 86_400_000

export const NOW_CHIPS = [
  { id: 'todos', label: 'Todos' },
  { id: 'atrasados', label: 'Só atrasados' },
  { id: 'parados', label: 'Só parados' }
] as const
export type NowChip = (typeof NOW_CHIPS)[number]['id']

export function filterEnvios(envios: readonly ScrumEnvioView[], chip: NowChip): ScrumEnvioView[] {
  if (chip === 'atrasados') return envios.filter((e) => e.estado === 'atrasado')
  if (chip === 'parados') return envios.filter((e) => e.estado === 'parado')
  return [...envios]
}

function num(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString('pt-BR', { maximumFractionDigits: 1 })
}

/** "2,1×", "3×", "0,6×". */
export function vezesText(v: number): string {
  return `${num(v)}×`
}

/** "84 min". */
export function minText(ms: number): string {
  return `${Math.round(ms / MIN_MS)} min`
}

/** O selo do cartão: a classe e o texto ("atrasado · 2,1× do prazo"). */
export function statusOf(e: Pick<ScrumEnvioView, 'estado' | 'vezes'>): { cls: 'ok' | 'atrasado' | 'parado'; text: string } {
  const v = e.vezes === null ? null : vezesText(e.vezes)
  if (e.estado === 'parado') return { cls: 'parado', text: v ? `parado pelo Scrum · ${v} do prazo` : 'parado pelo Scrum' }
  if (e.estado === 'atrasado') return { cls: 'atrasado', text: v ? `atrasado · ${v} do prazo` : 'atrasado' }
  return { cls: 'ok', text: v ? `no prazo · ${v}` : 'no prazo' }
}

/** "Etapa 3 de 5 — título"; sem posição, só o título. */
export function etapaText(e: Pick<ScrumEnvioView, 'etapaN' | 'etapaTotal' | 'etapaTitulo'>): string {
  const titulo = e.etapaTitulo ?? ''
  if (e.etapaN === null) return titulo
  const n = e.etapaTotal > 0 ? `Etapa ${e.etapaN} de ${e.etapaTotal}` : `Etapa ${e.etapaN}`
  return titulo ? `${n} — ${titulo}` : n
}

/** Os marcos da trilha, em % do prazo. A trilha vai de 0 a 300% em linha reta. */
export const TRACK_MARKS = [0, 100, 150, 200, 300] as const
export const TRACK_MAX = 300

export function trackLeft(pct: number): number {
  return Math.max(0, Math.min(100, (pct / TRACK_MAX) * 100))
}

export interface TrackMark {
  pct: number
  left: number
  /** Aceso: o tempo já passou dele (ou o SM já o disparou). */
  hit: boolean
  /** O 300% de um envio parado. */
  bad: boolean
  glyph: string
}

export function trackOf(e: Pick<ScrumEnvioView, 'estado' | 'vezes' | 'marcos' | 'tempoAtivoMs' | 'prazoMin'>): { marks: TrackMark[]; now: { left: number; label: string } | null } {
  const pct = e.vezes === null ? null : e.vezes * 100
  const marks = TRACK_MARKS.map((m): TrackMark => {
    const fired = (e.marcos as readonly number[]).includes(m)
    const hit = m > 0 && (fired || (pct !== null && pct >= m) || (m === TRACK_MAX && e.estado === 'parado'))
    const bad = m === TRACK_MAX && e.estado === 'parado'
    return { pct: m, left: trackLeft(m), hit, bad, glyph: m === TRACK_MAX ? '⏹' : hit ? '!' : '' }
  })
  const now = pct === null || !e.prazoMin ? null : { left: trackLeft(pct), label: `${minText(e.tempoAtivoMs)} / ${e.prazoMin} min` }
  return { marks, now }
}

const DESVIO_LABEL: Record<ScrumTipoDesvio, string> = {
  reexplorando: 'reexplorando o projeto',
  'laco-de-teste': 'laço de teste',
  'fora-do-escopo': 'fora do escopo',
  'esperando-sem-avisar': 'esperando sem avisar'
}

/** O chip do veredito: "DESVIO · laço de teste", "PARAR", "JUSTIFICADO". */
export function verdictOf(v: ScrumVereditoTipo | null, tipo: ScrumTipoDesvio | null): { cls: string; text: string } | null {
  if (v === 'justificado') return { cls: 'just', text: 'JUSTIFICADO' }
  if (v === 'parar') return { cls: 'parar', text: 'PARAR' }
  if (v === 'falha') return { cls: 'falha', text: 'SEM JULGAMENTO' }
  if (v === 'desvio') return { cls: 'desvio', text: tipo ? `DESVIO · ${DESVIO_LABEL[tipo]}` : 'DESVIO' }
  return null
}

export function marcoText(m: ScrumGatilho | null): string {
  if (m === null) return ''
  return m === 'travado' ? 'travado' : `marco ${m}%`
}

/** "13:12" na hora local. */
export function hhmm(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** O nome do projeto: a última pasta do caminho. */
export function projectName(cwd: string | null): string {
  if (!cwd) return 'sem projeto'
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

export interface HistKind {
  verbo: string
  /** O resto da frase antes do título ("o envio", "agente travado em"). */
  ligacao: string
  cls: 'corte' | 'cobra' | 'aviso' | 'ok'
  ico: string
  corte: boolean
}

const HIST_KIND: Partial<Record<ScrumDecisaoTipo, HistKind>> = {
  parou: { verbo: 'Cortou', ligacao: 'o envio', cls: 'corte', ico: '✂', corte: true },
  interrompeu: { verbo: 'Interrompeu', ligacao: 'agente travado em', cls: 'corte', ico: '⏸', corte: true },
  cobrou: { verbo: 'Cobrou', ligacao: '', cls: 'cobra', ico: '!', corte: false },
  falha: { verbo: 'Cobrou', ligacao: '', cls: 'cobra', ico: '!', corte: false },
  avisou: { verbo: 'Avisou você', ligacao: 'sobre', cls: 'aviso', ico: '✉', corte: false },
  'deixou-seguir': { verbo: 'Deixou seguir', ligacao: '', cls: 'ok', ico: '✓', corte: false }
}

export function histKind(tipo: ScrumDecisaoTipo): HistKind {
  return HIST_KIND[tipo] ?? { verbo: tipo, ligacao: '', cls: 'aviso', ico: '·', corte: false }
}

/** O tempo do item: "96 min de 30 min", ou o declarado × decorrido do travado. */
export function histTempo(d: ScrumDecisao): string {
  if (d.declaradoMin !== null && d.decorridoMs !== null) return `declarou ${d.declaradoMin} min, passou ${minText(d.decorridoMs)} sem chamar ferramenta`
  if (d.tempoAtivoMs !== null && d.prazoMin !== null) return `${minText(d.tempoAtivoMs)} de ${d.prazoMin} min`
  return ''
}

/** A meta do item, sem o chip: hora, marco, tempo e "avisou você". */
export function histMeta(d: ScrumDecisao): { antes: string; depois: string } {
  const antes = [hhmm(d.at), marcoText(d.marco)].filter(Boolean).join(' · ')
  const depois = [histTempo(d), d.tipo !== 'avisou' && avisouVoce(d) ? 'avisou você' : ''].filter(Boolean).join(' · ')
  return { antes, depois }
}

/** O rótulo da decisão no "Sobre: …" da conversa: "Cortou Funil de vendas · crm · 12:48". */
export function sobreText(d: ScrumDecisao): string {
  const k = histKind(d.tipo)
  return [`${k.verbo} ${d.conversationTitle ?? 'o envio'}`, projectName(d.projectCwd), hhmm(d.at)].join(' · ')
}

/** A etiqueta curta acima do campo: "corte em crm", "cobrança em agent-code". */
export function sobreChip(d: ScrumDecisao | undefined, cwd: string | null): string {
  const what = !d ? 'decisão' : d.tipo === 'parou' ? 'corte' : d.tipo === 'interrompeu' ? 'interrupção' : d.tipo === 'deixou-seguir' ? 'deixou seguir' : d.tipo === 'avisou' ? 'aviso' : 'cobrança'
  return `${what} em ${projectName(d?.projectCwd ?? cwd)}`
}

function dayStart(t: number): number {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** "Hoje", "Ontem" ou a data. */
export function dayLabel(iso: string, now: number): string {
  const t = Date.parse(iso)
  const diff = Math.round((dayStart(now) - dayStart(t)) / DAY_MS)
  if (diff === 0) return 'Hoje'
  if (diff === 1) return 'Ontem'
  return new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export interface HistDay {
  label: string
  items: ScrumHistoryItem[]
}

/** Os itens (já do mais novo para o mais antigo) agrupados por dia local. */
export function groupByDay(items: readonly ScrumHistoryItem[], now: number): HistDay[] {
  const out: HistDay[] = []
  for (const item of items) {
    const label = dayLabel(item.decisao.at, now)
    const last = out[out.length - 1]
    if (last && last.label === label) last.items.push(item)
    else out.push({ label, items: [item] })
  }
  return out
}

/** O resumo de um dia fechado: "4 cobranças · 1 justificada · 0 cortes". */
export function daySummary(items: readonly ScrumHistoryItem[]): string {
  const n = (f: (d: ScrumDecisao) => boolean): number => items.filter((i) => f(i.decisao)).length
  const cobrancas = n((d) => d.tipo === 'cobrou' || d.tipo === 'falha')
  const just = n((d) => d.veredito === 'justificado')
  const cortes = n((d) => d.tipo === 'parou' || d.tipo === 'interrompeu')
  const pl = (k: number, um: string, varios: string): string => `${k} ${k === 1 ? um : varios}`
  return [pl(cobrancas, 'cobrança', 'cobranças'), pl(just, 'justificada', 'justificadas'), pl(cortes, 'corte', 'cortes')].join(' · ')
}

/** A mensagem do "Retomar com o aviso" (a nota da parada o main põe na frente — scrumStopNote). */
export function resumeText(e: Pick<ScrumEnvioView, 'etapaN' | 'paradoMotivo'>): string {
  const etapa = e.etapaN !== null ? `a etapa ${e.etapaN}` : 'a etapa'
  const motivo = e.paradoMotivo ? ` O motivo da parada foi: ${e.paradoMotivo.replace(/[.\s]+$/u, '')}.` : ''
  return `Pode retomar ${etapa} de onde parou.${motivo} Leve o aviso em conta, diga em uma linha o que falta e siga.`
}
