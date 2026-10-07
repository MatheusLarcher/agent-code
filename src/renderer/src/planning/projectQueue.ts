import {
  projectFolderKey,
  type HandoffProjectAction,
  type HandoffProjectFolder,
  type HandoffProjectPlan,
  type HandoffProjectSnapshot
} from '@shared/handoffProject'

/**
 * A FILA DO PROJETO vista da conversa (regras puras, sem React): quando a
 * mensagem do usuário fica guardada e o aviso que a conversa mostra. A decisão
 * de verdade é do main (handoffTracking/projectQueue*.ts); aqui só se lê a foto.
 */

export interface ProjectPlace {
  folder: HandoffProjectFolder
  plan: HandoffProjectPlan
}

export function placeOf(snapshot: HandoffProjectSnapshot | null, conversationId: string): ProjectPlace | null {
  for (const folder of snapshot?.folders ?? []) {
    const plan = folder.plans.find((p) => p.conversationId === conversationId)
    if (plan) return { folder, plan }
  }
  return null
}

function otherRunning(folder: HandoffProjectFolder, plan: HandoffProjectPlan): HandoffProjectPlan | null {
  return folder.plans.find((p) => p.loteId !== plan.loteId && p.estado === 'rodando') ?? null
}

/**
 * A mensagem do usuário nesta conversa fica GUARDADA (na fila do chat): o plano
 * já começou e outro plano tem a vez, ou ainda roda o prompt atual. A e B nunca
 * rodam juntos — salvo o "Enviar agora mesmo assim".
 */
export function projectHoldsChat(snapshot: HandoffProjectSnapshot | null, conversationId: string): boolean {
  const place = placeOf(snapshot, conversationId)
  if (!place || !place.plan.comecou) return false
  const reply = place.folder.resposta
  if (reply?.conversationId === conversationId && reply.estado === 'agora') return false
  return place.plan.posicao > 1 || otherRunning(place.folder, place.plan) !== null
}

export interface ProjectNoticeAction {
  acao: HandoffProjectAction
  label: string
}

export interface ProjectNotice {
  tone: 'info' | 'warn'
  text: string
  detail?: string
  actions: ProjectNoticeAction[]
  /** A pasta do registro da avaliação do PO ("ver avaliação"). */
  registro?: string
}

const SEND_NOW: ProjectNoticeAction = { acao: 'enviar_agora', label: 'Enviar agora mesmo assim' }
const START: ProjectNoticeAction = { acao: 'comecar', label: 'Começar mesmo assim' }
const PASS: ProjectNoticeAction = { acao: 'passar', label: 'Passar a vez' }

const files = (n: number): string => (n === 1 ? '1 arquivo' : `${n} arquivos`)

/** "o PO alterou: …" quando a avaliação mexeu em algo. */
function changedDetail(folder: HandoffProjectFolder): string | undefined {
  const changed = folder.avaliacao?.alterados ?? []
  return changed.length > 0 ? `O PO alterou: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ` (+${changed.length - 8})` : ''}.` : undefined
}

function withRecord(notice: ProjectNotice, folder: HandoffProjectFolder): ProjectNotice {
  const registro = folder.avaliacao?.registro
  const detail = [notice.detail, changedDetail(folder)].filter(Boolean).join(' ')
  return { ...notice, ...(detail ? { detail } : {}), ...(registro ? { registro } : {}) }
}

function replyNotice(place: ProjectPlace, holder: HandoffProjectPlan | null): ProjectNotice | null {
  const { folder } = place
  const reply = folder.resposta
  if (!reply || reply.estado === 'agora') return null
  const b = holder && holder.loteId !== place.plan.loteId ? holder : otherRunning(folder, place.plan)
  const bName = b ? `"${b.planTitulo}"` : 'B'
  const quem = reply.por === 'usuario' ? 'Você escolheu' : 'O PO decidiu'
  if (reply.estado === 'decidindo') {
    return { tone: 'info', text: `Sua resposta está guardada: o plano ${bName} está rodando nesta pasta. O PO está decidindo…`, actions: [SEND_NOW] }
  }
  if (reply.estado === 'pergunta') {
    return {
      tone: 'warn',
      text: `O PO pergunta: ${reply.pergunta ?? 'o que fazer com a sua resposta?'}`,
      detail: `Sua resposta está guardada enquanto o plano ${bName} tem a vez.`,
      actions: [
        { acao: 'retomar_a', label: 'O A no fim do prompt do B' },
        { acao: 'esperar_b', label: 'Esperar o B terminar' },
        SEND_NOW
      ]
    }
  }
  // O motivo do PO vai junto; a escolha do usuário dispensa explicação.
  const why = reply.por === 'po' && reply.motivo ? ` — ${reply.motivo}` : '.'
  if (reply.estado === 'esperar_b') {
    const left = b?.restanteMin ? ` (~${b.restanteMin} min)` : ''
    return withRecord({ tone: 'info', text: `${quem}: esperar o plano ${bName} terminar${left}${why}`, actions: [SEND_NOW] }, folder)
  }
  // retomar_a sem decisão: é o A que já tinha a vez e só espera o prompt atual do B.
  const text = reply.por
    ? `${quem}: este plano volta no fim do prompt atual do plano ${bName}${why}`
    : `Sua resposta está guardada: ela sai quando o prompt atual do plano ${bName} terminar.`
  return withRecord({ tone: 'info', text, actions: [SEND_NOW] }, folder)
}

function planNotice(place: ProjectPlace): ProjectNotice | null {
  const { folder, plan } = place
  const holder = folder.plans[0] ?? null
  if (folder.resposta?.conversationId === plan.conversationId) return replyNotice(place, holder)
  const running = otherRunning(folder, plan)
  const evaluation = folder.avaliacao
  if (!plan.comecou) {
    if (plan.posicao > 1 && holder) {
      const waitingPo = folder.avaliando === 'vez' ? 'O PO está avaliando se este plano pode começar.' : undefined
      const evaluated =
        evaluation?.kind === 'vez' && evaluation.decisao === 'ESPERAR' && evaluation.loteB === plan.loteId
          ? `O PO avaliou: esperar você — ${evaluation.motivo}`
          : undefined
      return withRecord(
        {
          tone: 'info',
          text: `Na fila do projeto (${plan.posicao}º): esperando o plano "${holder.planTitulo}" terminar.`,
          ...(waitingPo || evaluated ? { detail: waitingPo ?? evaluated } : {}),
          actions: holder.estado === 'parado' ? [START] : []
        },
        folder
      )
    }
    if (running) return { tone: 'info', text: `Esperando o prompt atual do plano "${running.planTitulo}" terminar.`, actions: [] }
    if (plan.sujo) {
      return {
        tone: 'warn',
        text: `Segurado: ${files(plan.sujo)} sem commit nesta pasta.`,
        detail: 'Commite ou descarte antes de começar — ou comece mesmo assim, se as mudanças são suas e você sabe o que são.',
        actions: [START]
      }
    }
    return null
  }
  if (plan.posicao > 1 && holder) {
    return {
      tone: 'info',
      text: `O plano "${holder.planTitulo}" está com a vez nesta pasta: este espera ele terminar.`,
      detail: 'Se você escrever aqui, a mensagem fica guardada e o PO decide a vez.',
      actions: []
    }
  }
  if (running) return { tone: 'info', text: `Este plano recuperou a vez: segue quando o prompt atual do plano "${running.planTitulo}" terminar.`, actions: [] }
  if (evaluation?.kind === 'vez' && evaluation.decisao === 'COMECAR' && evaluation.loteB === plan.loteId && plan.comecarMesmoAssim === 'po') {
    const dirty = plan.arquivosDoAnterior.length
    return withRecord(
      {
        tone: 'info',
        text: `O PO começou este plano: ${evaluation.motivo}`,
        ...(dirty > 0 ? { detail: `O PO começou com ${files(dirty)} do plano anterior sem commit (a lista foi no 1º prompt, para não mexer neles).` } : {}),
        actions: []
      },
      folder
    )
  }
  const next = folder.plans[1]
  if (plan.estado === 'parado' && next) {
    const evaluated = evaluation?.kind === 'vez' && evaluation.decisao === 'ESPERAR' && evaluation.loteA === plan.loteId
    const text =
      folder.avaliando === 'vez'
        ? `Este plano está parado e o plano "${next.planTitulo}" espera a vez: o PO está avaliando se ele começa.`
        : evaluated
          ? `O PO avaliou: esperar você — ${evaluation.motivo}`
          : `O plano "${next.planTitulo}" espera a vez atrás deste. Parado 30 min, o PO decide se ele começa.`
    return withRecord({ tone: 'info', text, actions: [PASS] }, folder)
  }
  return null
}

/** O aviso da conversa: o plano na fila do projeto, ou a conversa avulsa numa pasta com implantação. */
export function projectNotice(snapshot: HandoffProjectSnapshot | null, conv: { id: string; cwd: string } | null | undefined): ProjectNotice | null {
  if (!snapshot || !conv) return null
  const place = placeOf(snapshot, conv.id)
  if (place) return planNotice(place)
  const key = projectFolderKey(conv.cwd, snapshot.caseInsensitive)
  const folder = snapshot.folders.find((f) => f.key === key)
  if (!folder?.implantacaoEmCurso) return null
  return { tone: 'warn', text: 'Uma implantação está rodando neste projeto — mexer nos mesmos arquivos mistura as mudanças.', actions: [] }
}
