import {
  boardItemsToExpire,
  boardItemsToReopenBefore,
  boardItemsToResume,
  DISMISS_BY_USER,
  EXPIRE_BY,
  toSourceItems
} from './boardModel'
import { resolveProjectIdentity } from '../persistence/projectIdentity'
import type { BoardDismissBy, BoardItem, BoardItemEvent, BoardPoCreate, BoardPoWrite, PersistenceRepository } from '../persistence/types'
import {
  boardItemStatus,
  boardItemTitle,
  boardTurnEndReason,
  parseBoardTurnEndReason,
  type BoardItemStatus,
  type BoardTurnEndKind,
  type ChatEvent,
  type TaskItem
} from '../../shared/ipc'

// A regra pura mora em boardModel.ts; sai daqui também para quem já importava.
export { toSourceItems } from './boardModel'

/**
 * O serviço do quadro: liga o esqueleto determinístico do agente à tabela
 * `board_items`.
 *
 * A entrada é o evento `task-list` — o snapshot AUTORITATIVO que a sessão lê
 * dos arquivos do próprio CLI (`sessionTasks.ts`). Ele foi escolhido em vez dos
 * eventos incrementais (`TaskCreate`/`TaskUpdate`) pelo mesmo motivo que o card
 * do chat passou a usá-lo: incremento perdido deixa o quadro congelado num
 * estado antigo, e o quadro do projeto é justamente o que precisa continuar
 * certo depois de o app ter ficado fechado.
 *
 * Duas invariantes, herdadas do vigia:
 *
 * 1. **Nunca derruba a conversa.** Toda falha (banco fora do ar, identidade de
 *    projeto que não resolve) degrada em silêncio; o chat não pode quebrar
 *    porque o quadro não conseguiu gravar.
 * 2. **Uma escrita por vez por conversa.** O snapshot chega em rajada; duas
 *    sincronizações concorrentes da mesma conversa se atropelariam no
 *    `DELETE` do que sumiu.
 *
 * E um fechamento de turno determinístico: no `result`/`error`, o que continuou
 * "fazendo" volta para "a fazer". Ver `closeTurn`.
 */

const IDENTITY_TTL_MS = 60_000

/** Teto da espera pelo PO — 30 s DE PROPÓSITO, mesmo com o PO às vezes levando
 *  mais (54 s e 46 s na conversa "Cadastro no sistema"): esperar mais deixaria
 *  o quadro mostrando "fazendo" o que ninguém faz, e não é preciso, porque o
 *  veredito que chega depois do teto não se perde. Ver `waitForPo`. */
const PO_WAIT_MS = 30_000

/** O motivo da promoção determinística — ver `resumeTurn`. */
export const RESUME_REASON = 'o usuário retomou a conversa'

export interface BoardServiceDeps {
  /** `null` enquanto não há repositório autoritativo — o quadro simplesmente não grava. */
  repository(): PersistenceRepository | null
  /** Avisa o renderer que o quadro daquele projeto mudou. */
  onChanged?(projectId: string): void
  /**
   * Espera a análise do PO daquela conversa terminar, quando existe um PO.
   *
   * Dependência INJETADA e opcional porque o PO já depende deste serviço:
   * importá-lo aqui fecharia um ciclo. Sem ela o fechamento roda assim mesmo —
   * o que se perde é só a ordem: o cartão que o PO ia concluir passa antes por
   * "a fazer", e o "concluído" dele chega depois e grava por cima.
   */
  poSettled?(convId: string): Promise<void>
  /** Teto da espera pelo PO, em ms. Existe para o teste não esperar 30s. */
  poWaitMs?: number
  /**
   * Manda uma mensagem para o agente da conversa (o drag-and-drop para
   * "fazendo"). Enfileira sozinho se o agente já estiver ocupado — é o mesmo
   * `AgentSession.send` que o Composer usa, sem fila nova. Devolve `false`
   * quando a sessão nunca foi iniciada nesta execução do processo (não tenta
   * iniciar uma nova); `true` quando a mensagem foi de fato entregue/enfileirada.
   */
  sendToSession?(convId: string, text: string): Promise<boolean>
  /**
   * Interrompe de verdade o turno em andamento da conversa (o drag-and-drop
   * saindo de "fazendo") — o mesmo caminho de `Channels.agentInterrupt`.
   * Devolve `false` quando não há sessão viva (nada a interromper).
   */
  interruptSession?(convId: string): Promise<boolean>
}

const MOVE_STATUS_LABEL: Record<BoardItemStatus, string> = {
  pending: 'a fazer',
  in_progress: 'fazendo',
  completed: 'concluído'
}

interface CachedIdentity {
  projectId: string
  at: number
}

export class BoardService {
  private readonly identities = new Map<string, CachedIdentity>()
  /** Fila de escrita por conversa: a promessa da última sincronização. */
  private readonly writes = new Map<string, Promise<void>>()
  /**
   * Fila dos fechamentos de turno, SEPARADA da de escrita de propósito: o PO
   * espera por `settled()` antes de analisar, e o fechamento espera pelo PO.
   * Na mesma fila, um estaria esperando o outro pelos dois lados.
   */
  private readonly closures = new Map<string, Promise<void>>()
  /** Quantos fins de turno cada conversa já teve neste processo — é como a
   *  promoção sabe que o turno que ela ia retomar já acabou. */
  private readonly turnEnds = new Map<string, number>()
  /** Os ids que o ÚLTIMO fechamento de cada conversa rebaixou (vazio quando
   *  não rebaixou nada). Ver `boardItemsToResume`. */
  private readonly lastReopened = new Map<string, ReadonlySet<string>>()
  /** As reaberturas em andamento, de qualquer conversa. Ver `applyPo`. */
  private readonly reopening = new Set<Promise<void>>()
  /** Quantas tarefas cada conversa tem rodando em SEGUNDO PLANO, segundo o
   *  último snapshot `background-tasks` (ausente = nenhuma). Ver `closeTurn`. */
  private readonly background = new Map<string, number>()

  constructor(private readonly deps: BoardServiceDeps) {}

  /**
   * Identidade estável do projeto, com o MESMO critério do registro de tarefas.
   *
   * Devolve `''` quando não dá para resolver — e isso só acontece quando a
   * PASTA sumiu (`resolveProjectIdentity` já degrada sozinha para um id estável
   * derivado do nome quando o projeto não tem git). Inventar um id aqui seria
   * pior do que não ter nenhum: ele não casaria com nada gravado, e a tela
   * mostraria "nenhuma tarefa ainda" — um diagnóstico errado — no lugar de
   * dizer que o quadro está indisponível.
   */
  async projectId(cwd: string, now = Date.now()): Promise<string> {
    if (!cwd) return ''
    const cached = this.identities.get(cwd)
    if (cached && now - cached.at < IDENTITY_TTL_MS) return cached.projectId
    let projectId = ''
    try {
      projectId = (await resolveProjectIdentity(cwd)).projectId
    } catch {
      return '' // pasta fora do ar: sem quadro, e sem cachear o fracasso
    }
    this.identities.set(cwd, { projectId, at: now })
    return projectId
  }

  /** Alimentado pelo tee de eventos do main. Nunca lança. */
  observe(convId: string, cwd: string, event: ChatEvent): void {
    if (event.kind === 'task-list') {
      this.enqueue(convId, cwd, event.items)
      return
    }
    if (event.kind === 'background-tasks') {
      if (event.tasks.length > 0) this.background.set(convId, event.tasks.length)
      else this.background.delete(convId)
      return
    }
    // Os dois jeitos de um turno acabar: `result` é o fim normal, `error` é o
    // que morreu no meio. No `error` ninguém está mais trabalhando; no `result`,
    // um subagente delegado pode estar (ver `closeTurn`).
    if (event.kind === 'result' || event.kind === 'error') {
      const delegated = event.kind === 'result' && this.background.has(convId)
      this.closeTurn(convId, cwd, event.kind, delegated)
    }
  }

  private enqueue(convId: string, cwd: string, items: TaskItem[]): void {
    const previous = this.writes.get(convId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => this.sync(convId, cwd, items))
      .catch(() => undefined)
    this.writes.set(convId, next)
  }

  private async sync(convId: string, cwd: string, items: TaskItem[]): Promise<void> {
    const repository = this.deps.repository()
    if (!repository) return
    const projectId = await this.projectId(cwd)
    if (!projectId) return
    await repository.syncBoardItems({
      projectId,
      projectCwd: cwd,
      conversationId: convId,
      items: toSourceItems(items)
    })
    this.deps.onChanged?.(projectId)
  }

  /** Espera a fila de escrita daquela conversa — existe para o teste não
   *  depender de `setTimeout`, e para o `list` logo após um evento não ler
   *  um quadro pela metade. */
  async settled(convId: string): Promise<void> {
    await this.writes.get(convId)?.catch(() => undefined)
  }

  /** Espera o fechamento de turno daquela conversa. Igual a `settled`, mas da
   *  outra fila — e, como ela, existe para o teste não depender de relógio. */
  async turnClosed(convId: string): Promise<void> {
    await this.closures.get(convId)?.catch(() => undefined)
  }

  /**
   * Fim de turno: o que ficou "fazendo" volta para "a fazer".
   *
   * Determinístico, sem depender do LLM — o PO é quem julga o que ficou pronto,
   * e ele pode não estar configurado, falhar ou simplesmente não ver o cartão.
   * Aqui não há julgamento nenhum: acabou o turno, ninguém está trabalhando,
   * então nada pode continuar em andamento.
   *
   * A ordem é a parte delicada. Primeiro a fila de escrita (o último snapshot
   * do turno precisa estar gravado, senão a releitura reabre em cima de um
   * estado velho), depois o PO até o teto (o cartão que ele está concluindo
   * não passa por "a fazer"; o veredito que estoura o teto prevalece assim
   * mesmo — ver `waitForPo`), e só então a reabertura. O que NÃO acontece
   * aqui: uma varredura de todo cartão `in_progress` do banco — com PostgreSQL
   * compartilhado, isso apagaria o "fazendo" de um agente rodando em outro PC.
   *
   * `closedAt` é capturado AQUI, na hora do evento `result`/`error` — não no
   * momento em que `reopenStale` finalmente executa. Entre os dois pode haver
   * segundos (a espera pelo PO), tempo em que o usuário já mandou a próxima
   * mensagem e a rodada de ABERTURA do PO já promoveu o mesmo cartão de volta
   * para "em andamento". Sem o carimbo do instante REAL de fim do turno,
   * `reopenStale` releria esse cartão já promovido e o derrubaria de novo —
   * ver `boardItemsToReopenBefore`.
   *
   * A exceção é o trabalho DELEGADO (`delegated`): o `result` chegou com tarefa
   * em segundo plano — o subagente continua no cartão, então nada é reaberto e o
   * "último rebaixamento" fica vazio. O `error` não entra: turno que morreu pode
   * ter deixado o snapshot velho, e o erro seguro é rebaixar.
   */
  private closeTurn(convId: string, cwd: string, reason: BoardTurnEndKind, delegated = false): void {
    const closedAt = Date.now()
    this.turnEnds.set(convId, (this.turnEnds.get(convId) ?? 0) + 1)
    const previous = this.closures.get(convId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (delegated) {
          this.lastReopened.set(convId, new Set())
          return
        }
        await this.settled(convId)
        await this.waitForPo(convId)
        await this.reopenStale(convId, cwd, reason, closedAt)
      })
      .catch(() => undefined)
    this.closures.set(convId, next)
  }

  /**
   * A espera pelo PO com teto: análise que trava (modelo pendurado, rede
   * parada) não pode segurar o fechamento para sempre.
   *
   * Passado o teto, a reabertura roda sem o veredito, e o que chega DEPOIS
   * continua valendo por cima do "a fazer" (`rejectUnsafeOps` aceita "a fazer";
   * a corrida com a reabertura é fechada em `applyPo`). O PO nunca rebaixa: no
   * fechamento ele conclui, renomeia, justifica (PENDENTE) ou cria.
   */
  private async waitForPo(convId: string): Promise<void> {
    const wait = this.deps.poSettled?.(convId)
    if (!wait) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.deps.poWaitMs ?? PO_WAIT_MS)
      timer.unref?.()
      void wait.then(() => resolve(), () => resolve()).finally(() => clearTimeout(timer))
    })
  }

  private reopenStale(convId: string, cwd: string, kind: BoardTurnEndKind, closedAt: number): Promise<void> {
    const work = this.demoteStale(convId, cwd, kind, closedAt)
    this.reopening.add(work)
    return work.finally(() => this.reopening.delete(work))
  }

  /** Actor `system` (regra, não julgamento); mantém a justificativa do PENDENTE. */
  private async demoteStale(convId: string, cwd: string, kind: BoardTurnEndKind, closedAt: number): Promise<void> {
    // Relê depois de todo mundo ter escrito: o que o PO acabou de corrigir só
    // aparece aqui, e `null` é quadro indisponível — não há o que reabrir.
    const reopened = new Set<string>()
    this.lastReopened.set(convId, reopened)
    const cards = await this.list(cwd, { conversationId: convId })
    if (!cards) return
    for (const card of boardItemsToReopenBefore(cards, closedAt)) {
      try {
        // A escrita crua: `applyPo` esperaria por esta mesma reabertura.
        const justification = parseBoardTurnEndReason(card.poReason)?.justification
        const poReason = boardTurnEndReason(kind, justification)
        await this.writePo({ id: card.id, poStatus: 'pending', poReason, actor: 'system' })
        reopened.add(card.id)
      } catch {
        // Cartão que sumiu entre a leitura e a escrita não derruba os outros.
      }
    }
  }

  /**
   * A mensagem do usuário chegou: o que o fim do turno ANTERIOR devolveu para
   * "a fazer" volta para "em andamento", sem modelo nenhum.
   *
   * A rodada de abertura do PO deveria fazer isso, mas ela passa por gate,
   * cooldown e modelo — e falhou em silêncio justamente no "pode fazer" depois
   * de o agente perguntar. Aqui não há julgamento: o usuário respondeu, o
   * trabalho retomou. Se o assunto for outro, o próximo fim de turno devolve o
   * cartão para "a fazer" (vai-e-vem inofensivo), e a abertura do PO continua
   * livre para criar o cartão do assunto novo.
   *
   * Entra na MESMA fila dos fechamentos: o do turno anterior pode ainda estar
   * esperando o PO (até 30 s), e promover antes dele terminar seria promover
   * sobre uma lista que ele ainda vai rebaixar. Depois dele, a promoção grava
   * um `poAt` posterior ao `closedAt` daquele turno — e `reopenStale` já
   * respeita escrita mais nova. Se, enquanto esperava, o PRÓPRIO turno desta
   * mensagem já acabou (`turnEnds` mudou), não promove: ninguém está mais
   * trabalhando, e o fechamento dele não desfaria uma promoção mais nova.
   *
   * Nunca rejeita: o quadro não pode derrubar o envio da mensagem.
   */
  resumeTurn(convId: string, cwd: string): Promise<void> {
    const endsAtCall = this.turnEnds.get(convId) ?? 0
    const previous = this.closures.get(convId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => this.promoteReopened(convId, cwd, endsAtCall))
      .catch(() => undefined)
    this.closures.set(convId, next)
    return next
  }

  private async promoteReopened(convId: string, cwd: string, endsAtCall: number): Promise<void> {
    const sameTurn = (): boolean => (this.turnEnds.get(convId) ?? 0) === endsAtCall
    if (!sameTurn()) return
    const cards = await this.list(cwd, { conversationId: convId })
    if (!cards) return
    for (const card of boardItemsToResume(cards, this.lastReopened.get(convId) ?? null)) {
      if (!sameTurn()) return
      try {
        await this.applyPo({ id: card.id, poStatus: 'in_progress', poReason: RESUME_REASON, actor: 'system' })
      } catch {
        // Um cartão que falhou não impede os outros.
      }
    }
  }

  /**
   * Os cartões do projeto, ou `null` quando o quadro está INDISPONÍVEL (sem
   * repositório autoritativo, ou pasta do projeto fora do ar). A distinção
   * existe porque a tela diz coisas diferentes: "nenhuma tarefa ainda" é um
   * quadro vazio de verdade; `null` é "não consegui ler", e mostrar vazio nesse
   * caso seria mentir sobre o trabalho que está gravado.
   */
  async list(
    cwd: string,
    options: { conversationId?: string; includeDismissed?: boolean } = {}
  ): Promise<BoardItem[] | null> {
    const repository = this.deps.repository()
    if (!repository) return null
    const projectId = await this.projectId(cwd)
    if (!projectId) return null
    // A faxina de concluídos velhos é escopada ao PROJETO INTEIRO, não ao
    // recorte pedido aqui (`options.conversationId` pode filtrar uma única
    // conversa) — senão a mesma contagem de "mais de 5 concluídos" daria
    // respostas diferentes conforme quem perguntou. Pulada quando o pedido já
    // é por dispensados: não faz sentido expirar o que se está tentando ver.
    if (!options.includeDismissed) await this.expireOldCompleted(repository, projectId)
    return repository.listBoardItems({ projectIds: [projectId], ...options })
  }

  /**
   * Dispensa (soft) os concluídos velhos demais deste projeto — ver
   * `boardItemsToExpire`. Checado sob demanda, a cada `list()`, em vez de um
   * scheduler de fundo: mais simples, e o quadro só precisa estar certo
   * quando alguém de fato olha para ele. Nunca lança: faxina não pode
   * derrubar a leitura do quadro que a chamou.
   */
  private async expireOldCompleted(repository: PersistenceRepository, projectId: string): Promise<void> {
    try {
      const all = await repository.listBoardItems({ projectIds: [projectId] })
      for (const item of boardItemsToExpire(all, Date.now())) {
        try {
          await this.dismiss(item.id, true, EXPIRE_BY)
        } catch {
          // Um cartão que falhou não impede a faxina dos outros.
        }
      }
    } catch {
      // Sem lista fresca, não há o que expirar agora — a próxima passada tenta de novo.
    }
  }

  /**
   * A escrita que chega DURANTE uma reabertura espera ela terminar. A
   * reabertura lê e só depois escreve; o veredito atrasado que caísse entre as
   * duas (no PostgreSQL são idas e voltas de rede) seria sobrescrito pelo "a
   * fazer" decidido sobre a leitura de antes. Esperando, grava por último e
   * prevalece. Espera curta, e global porque aqui só se tem o id do cartão.
   */
  async applyPo(input: BoardPoWrite): Promise<BoardItem | null> {
    if (this.reopening.size > 0) await Promise.all([...this.reopening].map((work) => work.catch(() => undefined)))
    return this.writePo(input)
  }

  private async writePo(input: BoardPoWrite): Promise<BoardItem | null> {
    const repository = this.deps.repository()
    if (!repository) return null
    const item = await repository.applyBoardPo(input)
    this.deps.onChanged?.(item.projectId)
    return item
  }

  async createPoItem(input: BoardPoCreate): Promise<BoardItem | null> {
    const repository = this.deps.repository()
    if (!repository) return null
    const item = await repository.createBoardPoItem(input)
    this.deps.onChanged?.(item.projectId)
    return item
  }

  /** `by` omitido: é o clique do usuário (o IPC chama com dois argumentos). */
  async dismiss(id: string, dismissed: boolean, by?: BoardDismissBy): Promise<BoardItem | null> {
    const repository = this.deps.repository()
    if (!repository) return null
    const item = await repository.dismissBoardItem(id, dismissed, by ?? DISMISS_BY_USER[dismissed ? 'dismiss' : 'restore'])
    this.deps.onChanged?.(item.projectId)
    return item
  }

  /**
   * O drag-and-drop do usuário: além de gravar o novo status pelo MESMO
   * caminho do PO (`applyPo`, `actor: 'user'`), faz o quadro controlar o
   * agente de verdade:
   *
   * - destino "fazendo" e o cartão não estava lá: manda uma mensagem para o
   *   agente da conversa começar. Sem sessão viva (nunca iniciada nesta
   *   execução do processo), NADA é gravado — a UI mostra a mensagem e desfaz
   *   a posição do cartão.
   * - saindo de "fazendo" para qualquer outro destino: interrompe o turno de
   *   verdade.
   * - troca direta "a fazer" ↔ "concluído" (nenhum dos dois lados é
   *   "fazendo"): só grava.
   */
  async move(id: string, toStatus: BoardItemStatus): Promise<{ ok: boolean; message?: string }> {
    const repository = this.deps.repository()
    if (!repository) return { ok: false, message: 'O quadro está indisponível agora.' }
    const current = await repository.getBoardItem(id)
    if (!current) return { ok: false, message: 'Cartão não encontrado.' }
    const fromStatus = boardItemStatus(current)
    if (fromStatus === toStatus) return { ok: true }
    const convId = current.conversationId

    if (toStatus === 'in_progress') {
      const sent =
        (await this.deps.sendToSession?.(convId, `Comece a trabalhar nesta tarefa: "${boardItemTitle(current)}"`)) ??
        false
      if (!sent) {
        return {
          ok: false,
          message: 'Abra esta conversa e mande uma mensagem para o agente começar antes de mover pelo quadro.'
        }
      }
    } else if (fromStatus === 'in_progress') {
      await this.deps.interruptSession?.(convId)
    }

    const item = await this.applyPo({
      id,
      poStatus: toStatus,
      poReason: `o usuário moveu o cartão para "${MOVE_STATUS_LABEL[toStatus]}" pelo quadro`,
      actor: 'user'
    })
    return item ? { ok: true } : { ok: false, message: 'Não foi possível gravar a mudança no quadro.' }
  }

  /** A linha do tempo de um cartão. Sem repositório, ou se a consulta falhar,
   *  devolve `[]` — a timeline é aditiva, nunca derruba o detalhe do cartão. */
  async listItemEvents(boardItemId: string): Promise<BoardItemEvent[]> {
    const repository = this.deps.repository()
    if (!repository) return []
    try {
      return await repository.listBoardItemEvents(boardItemId)
    } catch {
      return []
    }
  }

  dispose(convId: string): void {
    this.writes.delete(convId)
    this.closures.delete(convId)
    this.turnEnds.delete(convId)
    this.lastReopened.delete(convId)
    this.background.delete(convId)
  }
}
