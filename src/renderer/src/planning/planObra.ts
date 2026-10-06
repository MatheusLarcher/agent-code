/**
 * A obra de um plano. Depois do "Enviar para implementação", a Tela de
 * Planejamento mostra o plano EM CONSTRUÇÃO: os envios dele, lidos do banco (o
 * acompanhamento de entregas — nada vem do texto do modelo), viram o estágio da
 * obra (o selo do cabeçalho), a placa da obra e os tijolos, um por etapa do
 * roteiro. PURO, sem React.
 *
 * Estágios, da prancheta à entrega das chaves:
 *   prancheta   nada enviado ainda: o plano está sendo desenhado;
 *   canteiro    enviado, o agente ainda não começou (na fila / enviado);
 *   obra        o agente está construindo (em execução);
 *   vistoria    o agente precisa de você (aguardando você);
 *   parada      sem movimento (parada);
 *   embargada   deu erro no turno (falhou);
 *   acabamento  o turno acabou com etapa por terminar (incompleta);
 *   fase        o que foi enviado está pronto, mas parte do plano nem saiu da
 *               planta (o plano mandado em partes);
 *   habitese    todas as etapas prontas: obra entregue.
 * O estágio sai do lote mais recente (cada envio do plano é um lote); os
 * tijolos e o tempo, de todos os envios do plano.
 */
import { currentEntrega, currentEnvio, deadlineLevel, type DeadlineLevel, type HandoffEntrega, type HandoffEnvio, type HandoffEnvioStatus } from '@shared/handoffTracking'
import type { PlanningRoteiroDto } from '@shared/ipc'
import { normalizePath } from '@shared/pathGuard'

export type ObraStage = 'prancheta' | 'canteiro' | 'obra' | 'vistoria' | 'parada' | 'embargada' | 'acabamento' | 'fase' | 'habitese'

/** O selo de cada estágio. */
export const OBRA_LABEL: Record<ObraStage, string> = {
  prancheta: 'Na prancheta',
  canteiro: 'Canteiro aberto',
  obra: 'Em obra',
  vistoria: 'Vistoria',
  parada: 'Obra parada',
  embargada: 'Obra embargada',
  acabamento: 'Falta acabamento',
  fase: 'Fase entregue',
  habitese: 'Habite-se'
}

/** Um tijolo por etapa: na planta (não enviada), na fila, na massa (em andamento), pronto ou trincado (incompleta). */
export type BrickState = 'planta' | 'fila' | 'massa' | 'pronto' | 'trinca'

export const BRICK_LABEL: Record<BrickState, string> = {
  planta: 'na planta',
  fila: 'na fila',
  massa: 'na massa',
  pronto: 'pronta',
  trinca: 'incompleta'
}

export interface ObraBrick {
  id: string
  titulo: string
  state: BrickState
}

export interface ObraView {
  stage: ObraStage
  /** A frase da placa. */
  headline: string
  /** O porquê gravado pelo acompanhamento (motivo), quando há. */
  detail: string | null
  bricks: ObraBrick[]
  /** A etapa de agora no roteiro (n de total), ou só o título se ela saiu do roteiro. */
  etapa: { n: number | null; total: number; titulo: string } | null
  /** Quem constrói: a conversa de implementação do envio de agora. */
  mestre: { conversationId: string; title: string } | null
  /** Tempo ativo somado × prazo somado (a estimativa do plano). */
  tempo: { ativoMs: number; prazoMin: number | null; level: DeadlineLevel }
  /** Quando a obra começou (o 1º envio que saiu), ISO. */
  inicio: string | null
}

type Etapa = Pick<PlanningRoteiroDto['etapas'][number], 'id' | 'titulo' | 'status'>

/** Os envios deste plano: o mesmo slug no mesmo projeto (caminho comparado sem caixa/barras no Windows). */
export function planEnviosOf(envios: readonly HandoffEnvio[], projectCwd: string, slug: string): HandoffEnvio[] {
  const cwd = normalizePath(projectCwd)
  return envios.filter((e) => e.planSlug === slug && normalizePath(e.projectCwd) === cwd)
}

const at = (e: HandoffEnvio): number => Date.parse(e.enviadoEm ?? e.criadoEm) || 0

/** Do mais grave/vivo ao mais quieto: o primeiro status presente no lote decide o estágio. */
const STAGE_BY_STATUS: ReadonlyArray<[HandoffEnvioStatus, ObraStage]> = [
  ['aguardando_voce', 'vistoria'],
  ['em_execucao', 'obra'],
  ['parada', 'parada'],
  ['falhou', 'embargada'],
  ['incompleta', 'acabamento'],
  ['enviado', 'canteiro'],
  ['na_fila', 'canteiro']
]

const BRICK_BY_ENTREGA: Record<HandoffEntrega['status'], BrickState> = {
  pendente: 'fila',
  em_andamento: 'massa',
  concluida: 'pronto',
  incompleta: 'trinca'
}

function bricksOf(envios: readonly HandoffEnvio[], etapas: readonly Etapa[]): ObraBrick[] {
  // A entrega mais recente de cada etapa (um plano reenviado refaz a etapa).
  const last = new Map<string, HandoffEntrega>()
  for (const envio of [...envios].sort((a, b) => at(a) - at(b) || a.ordem - b.ordem)) {
    for (const entrega of envio.entregas) last.set(entrega.etapaId, entrega)
  }
  const bricks: ObraBrick[] = etapas.map((e) => {
    const entrega = last.get(e.id)
    last.delete(e.id)
    const state: BrickState = entrega ? BRICK_BY_ENTREGA[entrega.status] : e.status === 'concluida' ? 'pronto' : 'planta'
    return { id: e.id, titulo: e.titulo, state }
  })
  // Etapa enviada que saiu do roteiro depois: continua na obra, no fim.
  for (const entrega of last.values()) bricks.push({ id: entrega.etapaId, titulo: entrega.etapaTitulo, state: BRICK_BY_ENTREGA[entrega.status] })
  return bricks
}

function headlineOf(stage: ObraStage, etapa: string | null, prontas: number, total: number): string {
  switch (stage) {
    case 'prancheta':
      return 'O plano ainda está na prancheta.'
    case 'canteiro':
      return 'O plano chegou ao mestre de obras: a obra começa já, já.'
    case 'obra':
      return etapa ? `Mão na massa: ${etapa}` : 'Mão na massa.'
    case 'vistoria':
      return 'Vistoria: o mestre de obras precisa de você para seguir.'
    case 'parada':
      return etapa ? `A obra parou em ${etapa}.` : 'A obra parou.'
    case 'embargada':
      return 'Obra embargada: deu erro no turno.'
    case 'acabamento':
      return 'O turno acabou com etapa por terminar.'
    case 'fase':
      return `Fase entregue: ${prontas} de ${total} etapas prontas — o resto do plano ainda está na planta.`
    case 'habitese':
      return `Obra entregue — chave na mão. ${prontas} etapa${prontas === 1 ? ' pronta' : 's prontas'}.`
  }
}

/** A obra do plano a partir dos envios DELE (planEnviosOf) e do roteiro. */
export function obraView(envios: readonly HandoffEnvio[], etapas: readonly Etapa[]): ObraView {
  const bricks = bricksOf(envios, etapas)
  const tempo = { ativoMs: 0, prazoMin: null as number | null, level: 'neutro' as DeadlineLevel }
  const prontas = bricks.filter((b) => b.state === 'pronto').length
  if (envios.length === 0) {
    return { stage: 'prancheta', headline: headlineOf('prancheta', null, 0, bricks.length), detail: null, bricks, etapa: null, mestre: null, tempo, inicio: null }
  }
  // O lote mais recente decide o estágio (o envio de agora é dele).
  const newest = [...envios].sort((a, b) => Date.parse(b.criadoEm) - Date.parse(a.criadoEm))[0]
  const lote = envios.filter((e) => e.loteId === newest.loteId)
  const hit = STAGE_BY_STATUS.find(([status]) => lote.some((e) => e.status === status))
  let stage: ObraStage = hit ? hit[1] : 'habitese'
  // Lote concluído não é habite-se se sobrou etapa trincada (de um lote anterior) ou ainda na planta.
  if (stage === 'habitese' && bricks.some((b) => b.state === 'trinca')) stage = 'acabamento'
  else if (stage === 'habitese' && prontas < bricks.length) stage = 'fase'
  const envio = (hit && lote.find((e) => e.status === hit[0])) || currentEnvio(lote) || newest
  const entrega = currentEntrega(envio)
  const idx = entrega ? etapas.findIndex((e) => e.id === entrega.etapaId) : -1
  const live = stage !== 'habitese' && stage !== 'fase'
  // A etapa de agora só quando alguém já pegou nela (no canteiro aberto ninguém começou).
  const etapa = entrega && live && stage !== 'canteiro' ? { n: idx >= 0 ? idx + 1 : null, total: etapas.length, titulo: entrega.etapaTitulo } : null
  for (const e of envios) {
    tempo.ativoMs += e.tempoAtivoMs
    const prazo = e.prazoTotal ?? e.estimativaTotal
    if (prazo !== null) tempo.prazoMin = (tempo.prazoMin ?? 0) + prazo
  }
  tempo.level = deadlineLevel(tempo.ativoMs, tempo.prazoMin)
  const sent = envios.map((e) => e.enviadoEm).filter((d): d is string => !!d).sort()
  const quiet = stage === 'obra' || stage === 'canteiro' || !live
  return {
    stage,
    headline: headlineOf(stage, etapa?.titulo ?? null, prontas, bricks.length),
    detail: quiet ? null : envio.motivo,
    bricks,
    etapa,
    mestre: { conversationId: envio.conversationId, title: envio.conversationTitle },
    tempo,
    inicio: sent[0] ?? null
  }
}

/** "45 min", "1 h", "1 h 05 min" (minutos inteiros, arredondados para cima como o app mede). */
export function minutosText(min: number): string {
  const m = Math.max(0, Math.ceil(min))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h} h ${String(r).padStart(2, '0')} min` : `${h} h`
}

/** "hoje, 20:51" · "ontem, 18:02" · "03/10, 14:00" (hora local). */
export function inicioText(iso: string, now: number): string {
  const d = new Date(iso)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = (t: Date): number => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  const diff = Math.round((day(new Date(now)) - day(d)) / 86_400_000)
  if (diff === 0) return `hoje, ${hm}`
  if (diff === 1) return `ontem, ${hm}`
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}, ${hm}`
}
