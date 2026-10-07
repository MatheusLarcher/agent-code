import {
  HANDOFF_PO_HOLD_PREFIX,
  isEnvioHeldByPo,
  isEnvioRemoved,
  type HandoffEntrega,
  type HandoffEnvio
} from '@shared/handoffTracking'
import type { ToastType } from '../ui/UiProvider'
import { projectName } from './deliveryModel'

/**
 * Os avisos de mudança das entregas: o que virou concluído, incompleto, parado
 * ou atrasado entre DUAS leituras do banco, de qualquer projeto.
 *
 * - Envio que aparece pela primeira vez não avisa (não houve transição vista).
 * - A correção feita pelo usuário (corrigidoEm novo) não avisa: ela já tem o
 *   toast de sucesso/erro dela.
 * - Por envio, um aviso por tipo: com o envio inteiro concluído, a entrega que
 *   o fechou não avisa à parte; com a entrega incompleta/atrasada avisada, o
 *   envio incompleto/atrasado da mesma leitura não repete.
 */

export type DeliveryChangeKind = 'concluida' | 'incompleta' | 'parada' | 'atrasada' | 'fila'
/** A entrega não tem "parada" nem "fila": isso é do envio (a fila encalhou). */
type EntregaKind = Exclude<DeliveryChangeKind, 'parada' | 'fila'>
type EnvioKind = Exclude<DeliveryChangeKind, 'fila'>

export interface DeliveryNotice {
  kind: DeliveryChangeKind
  tipo: ToastType
  msg: string
  conversationId: string
}

const TIPO: Record<EnvioKind, ToastType> = {
  concluida: 'sucesso',
  incompleta: 'aviso',
  parada: 'aviso',
  atrasada: 'aviso'
}

const ENVIO_TEXT: Record<EnvioKind, string> = {
  concluida: 'Envio concluído',
  incompleta: 'Envio incompleto',
  parada: 'Envio parado',
  atrasada: 'Envio atrasado'
}

const ENTREGA_TEXT: Record<EntregaKind, string> = {
  concluida: 'Entrega concluída',
  incompleta: 'Entrega incompleta',
  atrasada: 'Entrega atrasada'
}

function where(envio: HandoffEnvio): string {
  const plano = envio.planTitulo || envio.planSlug
  return `${plano} · ${projectName(envio.projectCwd)}`
}

function became<T>(before: T, after: T, value: T): boolean {
  return before !== value && after === value
}

function envioKinds(prev: HandoffEnvio, next: HandoffEnvio): EnvioKind[] {
  const out: EnvioKind[] = []
  if (became(prev.status, next.status, 'concluida')) out.push('concluida')
  if (became(prev.status, next.status, 'incompleta')) out.push('incompleta')
  if (became(prev.status, next.status, 'parada')) out.push('parada')
  if (!prev.atrasado && next.atrasado) out.push('atrasada')
  return out
}

function entregaKinds(prev: HandoffEntrega | undefined, next: HandoffEntrega): EntregaKind[] {
  // Entrega nova num envio já conhecido (o roteiro mudou): sem transição vista.
  if (!prev) return []
  const out: EntregaKind[] = []
  if (became(prev.status, next.status, 'concluida')) out.push('concluida')
  if (became(prev.status, next.status, 'incompleta')) out.push('incompleta')
  if (!prev.atrasada && next.atrasada) out.push('atrasada')
  return out
}

/** Os avisos de UM envio entre a leitura anterior e a nova. */
export function envioNotices(prev: HandoffEnvio, next: HandoffEnvio): DeliveryNotice[] {
  const prevEntregas = new Map(prev.entregas.map((e) => [e.id, e]))
  // A correção é sua: nada deste envio vira aviso nesta leitura, exceto o atraso
  // (o prazo correu sozinho, não foi você quem o mudou).
  const corrected = next.entregas.some((e) => e.corrigidoEm !== null && e.corrigidoEm !== prevEntregas.get(e.id)?.corrigidoEm)
  const ofEnvio = envioKinds(prev, next).filter((k) => !corrected || k === 'atrasada')
  const out: DeliveryNotice[] = []
  const notice = (kind: EnvioKind, msg: string): void => {
    out.push({ kind, tipo: TIPO[kind], msg, conversationId: next.conversationId })
  }
  const byKind = new Map<EntregaKind, HandoffEntrega[]>()
  for (const entrega of [...next.entregas].sort((a, b) => a.ordem - b.ordem)) {
    for (const kind of entregaKinds(prevEntregas.get(entrega.id), entrega)) {
      if (corrected && kind !== 'atrasada') continue
      byKind.set(kind, [...(byKind.get(kind) ?? []), entrega])
    }
  }
  const envioClosed = ofEnvio.includes('concluida')
  for (const [kind, entregas] of byKind) {
    // O envio inteiro concluído já diz que a última entrega fechou.
    if (kind === 'concluida' && envioClosed) continue
    for (const e of entregas) notice(kind, `${ENTREGA_TEXT[kind]}: ${e.etapaTitulo} — ${where(next)}`)
  }
  for (const kind of ofEnvio) {
    // A entrega já avisada diz o mesmo, com o nome da etapa.
    if ((kind === 'incompleta' || kind === 'atrasada') && byKind.has(kind)) continue
    notice(kind, `${ENVIO_TEXT[kind]}: ${where(next)} (${next.conversationTitle || 'conversa'})`)
  }
  return out
}

/** Os prompts que ainda esperam a vez na fila do quadro da conversa. */
function waitingIn(envios: readonly HandoffEnvio[], conversationId: string): HandoffEnvio[] {
  return envios.filter((e) => e.conversationId === conversationId && e.status === 'na_fila' && !isEnvioRemoved(e))
}

const STOPPED: ReadonlySet<HandoffEnvio['status']> = new Set(['incompleta', 'parada', 'falhou'])

/**
 * Todos os avisos entre duas leituras completas (todos os projetos). A FILA
 * PARADA ganha o aviso dela: o envio corrente terminou sem concluir (ou o PO
 * segurou o próximo) com prompts esperando — no lugar do "envio incompleto/
 * parado", para não avisar duas vezes. Tirar da fila é ação sua: não avisa.
 */
export function deliveryNotices(prev: readonly HandoffEnvio[], next: readonly HandoffEnvio[]): DeliveryNotice[] {
  const before = new Map(prev.map((e) => [e.id, e]))
  const out: DeliveryNotice[] = []
  for (const envio of next) {
    const old = before.get(envio.id)
    if (!old || (isEnvioRemoved(envio) && !isEnvioRemoved(old))) continue
    const own = envioNotices(old, envio)
    const waiting = waitingIn(next, envio.conversationId)
    if (waiting.length > 0 && old.status !== envio.status && STOPPED.has(envio.status)) {
      out.push(...own.filter((n) => n.kind !== 'incompleta' && n.kind !== 'parada'))
      const n = waiting.length === 1 ? '1 prompt espera' : `${waiting.length} prompts esperam`
      out.push({ kind: 'fila', tipo: 'aviso', msg: `A fila parou: ${where(envio)} — ${n} no quadro`, conversationId: envio.conversationId })
      continue
    }
    out.push(...own)
    if (!isEnvioHeldByPo(old) && isEnvioHeldByPo(envio)) {
      const motivo = (envio.motivo ?? '').slice(HANDOFF_PO_HOLD_PREFIX.length)
      out.push({ kind: 'fila', tipo: 'aviso', msg: `O PO segurou o próximo prompt: ${motivo} — ${where(envio)}`, conversationId: envio.conversationId })
    }
  }
  return out
}
