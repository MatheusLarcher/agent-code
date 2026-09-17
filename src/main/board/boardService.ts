import { boardItemsToExpire, boardItemsToReopenBefore } from './boardModel'
import { resolveProjectIdentity } from '../persistence/projectIdentity'
import type {
  BoardItem,
  BoardItemEvent,
  BoardPoCreate,
  BoardPoWrite,
  BoardSourceItem,
  PersistenceRepository
} from '../persistence/types'
import { boardItemStatus, boardItemTitle, type BoardItemStatus, type ChatEvent, type TaskItem } from '../../shared/ipc'

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

/** Teto da espera pelo PO. Ver `poSettled`. */
const PO_WAIT_MS = 30_000

/** O motivo gravado no cartão reaberto, por como o turno acabou. Diz o FATO —
 *  o quadro não sabe (nem tem como saber) se o agente desistiu ou esqueceu. */
const REOPEN_REASON = {
  result: 'o turno terminou sem concluir esta tarefa',
  error: 'o turno foi interrompido com esta tarefa em andamento'
} as const

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
   * o que se perde é só a ordem, e a ordem importa: reabrir ANTES do PO
   * desfaria o "concluído" que ele ainda ia gravar.
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
    // Os dois jeitos de um turno acabar: `result` é o fim normal, `error` é o
    // que morreu no meio. Nos dois casos ninguém está mais trabalhando.
    if (event.kind === 'result' || event.kind === 'error') this.closeTurn(convId, cwd, REOPEN_REASON[event.kind])
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
   * estado velho), depois o PO (reabrir antes desfaria o "concluído" que ele
   * ainda ia gravar), e só então a reabertura. O que NÃO acontece aqui: uma
   * varredura de todo cartão `in_progress` do banco — com PostgreSQL
   * compartilhado, isso apagaria o "fazendo" de um agente rodando em outro PC.
   *
   * `closedAt` é capturado AQUI, na hora do evento `result`/`error` — não no
   * momento em que `reopenStale` finalmente executa. Entre os dois pode haver
   * segundos (a espera pelo PO), tempo em que o usuário já mandou a próxima
   * mensagem e a rodada de ABERTURA do PO já promoveu o mesmo cartão de volta
   * para "em andamento". Sem o carimbo do instante REAL de fim do turno,
   * `reopenStale` releria esse cartão já promovido e o derrubaria de novo —
   * ver `boardItemsToReopenBefore`.
   */
  private closeTurn(convId: string, cwd: string, reason: string): void {
    const closedAt = Date.now()
    const previous = this.closures.get(convId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.settled(convId)
        await this.waitForPo(convId)
        await this.reopenStale(convId, cwd, reason, closedAt)
      })
      .catch(() => undefined)
    this.closures.set(convId, next)
  }

  /** A espera pelo PO com teto: análise que trava (modelo pendurado, rede
   *  parada) não pode segurar o fechamento para sempre — o quadro fica errado,
   *  que é justamente o que esta correção veio consertar. */
  private async waitForPo(convId: string): Promise<void> {
    const wait = this.deps.poSettled?.(convId)
    if (!wait) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.deps.poWaitMs ?? PO_WAIT_MS)
      timer.unref?.()
      void wait.then(() => resolve(), () => resolve()).finally(() => clearTimeout(timer))
    })
  }

  private async reopenStale(convId: string, cwd: string, reason: string, closedAt: number): Promise<void> {
    // Relê depois de todo mundo ter escrito: o que o PO acabou de corrigir só
    // aparece aqui, e `null` é quadro indisponível — não há o que reabrir.
    const cards = await this.list(cwd, { conversationId: convId })
    if (!cards) return
    for (const card of boardItemsToReopenBefore(cards, closedAt)) {
      try {
        await this.applyPo({ id: card.id, poStatus: 'pending', poReason: reason })
      } catch {
        // Cartão que sumiu entre a leitura e a escrita não derruba os outros.
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
          await this.dismiss(item.id, true)
        } catch {
          // Um cartão que falhou não impede a faxina dos outros.
        }
      }
    } catch {
      // Sem lista fresca, não há o que expirar agora — a próxima passada tenta de novo.
    }
  }

  async applyPo(input: BoardPoWrite): Promise<BoardItem | null> {
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

  async dismiss(id: string, dismissed: boolean): Promise<BoardItem | null> {
    const repository = this.deps.repository()
    if (!repository) return null
    const item = await repository.dismissBoardItem(id, dismissed)
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
  }
}

/** `TaskItem` (o que a sessão publica) → a forma que o quadro grava. */
export function toSourceItems(items: TaskItem[]): BoardSourceItem[] {
  return items.map((item, index) => ({
    sourceId: String(item.id ?? index),
    title: typeof item.content === 'string' ? item.content : '',
    status: item.status,
    activeForm: typeof item.activeForm === 'string' && item.activeForm.trim() ? item.activeForm : null,
    seq: index
  }))
}
