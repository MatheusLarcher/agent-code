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
 * O estágio sai do envio de agora (planEnvioAtual: o lote mais recente); os
 * tijolos, a etapa de agora e as contas, de planProgress (a regra única de
 * etapas, shared/stepProgress.ts); o tempo, de todos os envios do plano.
 */
import { deadlineLevel, type DeadlineLevel, type HandoffEnvio, type HandoffEnvioStatus } from '@shared/handoffTracking'
import type { PlanningRoteiroDto } from '@shared/ipc'
import { planProgress, roteiroProgress, type PlanProgress, type StepState } from '@shared/stepProgress'

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

/** Um tijolo por etapa (o estado de planProgress): na planta (não enviada), na fila, na massa (em andamento), pronto ou trincado (incompleta). */
export type BrickState = StepState

export const BRICK_LABEL: Record<BrickState, string> = {
  planta: 'na planta',
  fila: 'na fila',
  massa: 'na massa',
  pronto: 'pronta',
  trinca: 'incompleta'
}

export interface ObraView {
  stage: ObraStage
  /** A frase da placa. */
  headline: string
  /** O porquê gravado pelo acompanhamento (motivo), quando há. */
  detail: string | null
  /** As etapas do plano (um tijolo cada) e as contas — planProgress. */
  progress: PlanProgress
  /** A etapa de agora pela posição no plano (n de total), só enquanto alguém está nela. */
  etapa: { n: number; total: number; titulo: string } | null
  /** Quem constrói: a conversa de implementação do envio de agora. */
  mestre: { conversationId: string; title: string } | null
  /** Tempo ativo somado × prazo somado (a estimativa do plano). */
  tempo: { ativoMs: number; prazoMin: number | null; level: DeadlineLevel }
  /** Quando a obra começou (o 1º envio que saiu), ISO. */
  inicio: string | null
}

type Etapa = Pick<PlanningRoteiroDto['etapas'][number], 'id' | 'titulo' | 'status'>

/** O estágio pelo status do envio de agora (planEnvioAtual já escolheu o mais vivo/grave do lote). */
const STAGE_BY_STATUS: Record<HandoffEnvioStatus, ObraStage> = {
  aguardando_voce: 'vistoria',
  em_execucao: 'obra',
  parada: 'parada',
  falhou: 'embargada',
  incompleta: 'acabamento',
  enviado: 'canteiro',
  na_fila: 'canteiro',
  concluida: 'habitese'
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
  const progress = planProgress(envios, etapas)
  const { prontas, total, atual } = progress
  const tempo = { ativoMs: 0, prazoMin: null as number | null, level: 'neutro' as DeadlineLevel }
  const envio = progress.envioAtual
  if (!envio) {
    return { stage: 'prancheta', headline: headlineOf('prancheta', null, 0, total), detail: null, progress, etapa: null, mestre: null, tempo, inicio: null }
  }
  let stage = STAGE_BY_STATUS[envio.status]
  // Lote concluído não é habite-se se sobrou etapa trincada (de um lote anterior) ou ainda na planta.
  if (stage === 'habitese' && progress.incompletas > 0) stage = 'acabamento'
  else if (stage === 'habitese' && prontas < total) stage = 'fase'
  const live = stage !== 'habitese' && stage !== 'fase'
  // A etapa de agora só quando alguém já pegou nela (no canteiro aberto ninguém começou).
  const etapa = atual && live && stage !== 'canteiro' ? { n: atual.n, total, titulo: atual.titulo } : null
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
    headline: headlineOf(stage, etapa?.titulo ?? null, prontas, total),
    detail: quiet ? null : envio.motivo,
    progress,
    etapa,
    mestre: { conversationId: envio.conversationId, title: envio.conversationTitle },
    tempo,
    inicio: sent[0] ?? null
  }
}

/** O contador do plano (cabeçalho e roteiro). */
export interface PlanCounter {
  feitas: number
  total: number
  label: 'prontas' | 'especificadas'
}

/**
 * Com a implementação começada (`impl`: o planProgress dos envios do plano), as
 * etapas prontas; antes, as especificadas no roteiro (roteiroProgress) — o
 * "concluida" do roteiro é especificada, nunca pronta.
 */
export function planCounter(etapas: ReadonlyArray<Pick<Etapa, 'status'>>, impl: Pick<PlanProgress, 'prontas' | 'total'> | null): PlanCounter {
  return impl ? { feitas: impl.prontas, total: impl.total, label: 'prontas' } : { ...roteiroProgress(etapas), label: 'especificadas' }
}

const COUNTER_SINGULAR: Record<PlanCounter['label'], string> = { prontas: 'pronta', especificadas: 'especificada' }

/** "2 de 5 prontas" · "1 de 1 especificada". */
export function counterText(c: PlanCounter): string {
  return `${c.feitas} de ${c.total} ${c.total === 1 ? COUNTER_SINGULAR[c.label] : c.label}`
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
