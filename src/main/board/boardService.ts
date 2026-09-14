import { resolveProjectIdentity } from '../persistence/projectIdentity'
import type {
  BoardItem,
  BoardPoCreate,
  BoardPoWrite,
  BoardSourceItem,
  PersistenceRepository
} from '../persistence/types'
import type { ChatEvent, TaskItem } from '../../shared/ipc'

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
 */

const IDENTITY_TTL_MS = 60_000

export interface BoardServiceDeps {
  /** `null` enquanto não há repositório autoritativo — o quadro simplesmente não grava. */
  repository(): PersistenceRepository | null
  /** Avisa o renderer que o quadro daquele projeto mudou. */
  onChanged?(projectId: string): void
}

interface CachedIdentity {
  projectId: string
  at: number
}

export class BoardService {
  private readonly identities = new Map<string, CachedIdentity>()
  /** Fila de escrita por conversa: a promessa da última sincronização. */
  private readonly writes = new Map<string, Promise<void>>()

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
    if (event.kind !== 'task-list') return
    this.enqueue(convId, cwd, event.items)
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
    return repository.listBoardItems({ projectIds: [projectId], ...options })
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

  dispose(convId: string): void {
    this.writes.delete(convId)
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
