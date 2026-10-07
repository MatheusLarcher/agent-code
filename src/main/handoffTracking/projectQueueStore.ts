import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { HandoffProjectEvaluation, HandoffProjectReply } from '../../shared/handoffProject'
import type { StoredPlan } from './projectQueueRules'

/**
 * O estado da fila do projeto, GUARDADO NESTE PC (um JSON na pasta de dados):
 * a fila é por pasta neste PC, então ela não vai para o banco, que pode ser um
 * PostgreSQL dividido entre PCs (dois PCs com o mesmo caminho não se seguram).
 * Os envios continuam no banco; aqui ficam só a ordem dos planos, as avaliações
 * do PO e a resposta guardada.
 *
 * Arquivo ilegível ou de outro formato: começa vazio (a fila só perde a ordem
 * dos planos que esperavam — os envios seguem no banco).
 */

export interface StoredEvaluation extends HandoffProjectEvaluation {
  /** HEAD, git status e o estado do A na hora da avaliação: só reavalia se mudar. */
  signature: string
}

export interface StoredReply extends HandoffProjectReply {
  /** O texto da resposta (o PO lê); a mensagem de verdade fica na fila do chat. */
  texto: string
}

export interface FolderRecord {
  cwd: string
  plans: StoredPlan[]
  evaluation?: StoredEvaluation
  reply?: StoredReply
}

export interface ProjectQueueData {
  version: 1
  folders: Record<string, FolderRecord>
}

const Plan = z.object({
  loteId: z.string().min(1),
  conversationId: z.string().min(1),
  planTitulo: z.string(),
  addedAt: z.string(),
  startAnyway: z.object({ by: z.enum(['usuario', 'po']), at: z.string() }).optional(),
  dirtyFromPrevious: z.object({ planTitulo: z.string(), files: z.array(z.string()) }).optional()
})

const Evaluation = z.object({
  id: z.string(),
  kind: z.enum(['vez', 'resposta']),
  at: z.string(),
  decisao: z.enum(['COMECAR', 'ESPERAR', 'RETOMAR_A', 'ESPERAR_B', 'PERGUNTAR']),
  motivo: z.string(),
  pergunta: z.string().optional(),
  falhou: z.boolean(),
  alterados: z.array(z.string()),
  registro: z.string().nullable(),
  loteA: z.string(),
  loteB: z.string(),
  signature: z.string()
})

const Reply = z.object({
  conversationId: z.string(),
  at: z.string(),
  estado: z.enum(['decidindo', 'retomar_a', 'esperar_b', 'pergunta', 'agora']),
  motivo: z.string().nullable(),
  pergunta: z.string().nullable(),
  por: z.enum(['po', 'usuario']).nullable().optional(),
  texto: z.string()
})

const Data = z.object({
  version: z.literal(1),
  folders: z.record(
    z.string(),
    z.object({ cwd: z.string(), plans: z.array(Plan), evaluation: Evaluation.optional(), reply: Reply.optional() })
  )
})

const empty = (): ProjectQueueData => ({ version: 1, folders: {} })

export class ProjectQueueStore {
  private data: ProjectQueueData | null = null
  private loading: Promise<ProjectQueueData> | null = null
  private writes: Promise<void> = Promise.resolve()

  /** `file` null: só em memória (testes). */
  constructor(private readonly file: string | null) {}

  async read(): Promise<ProjectQueueData> {
    if (this.data) return this.data
    this.loading ??= this.load()
    this.data = await this.loading
    return this.data
  }

  /** Uma escrita por vez; a mudança vale em memória na hora e vai ao disco em seguida. */
  async update(mutate: (data: ProjectQueueData) => void): Promise<void> {
    const data = await this.read()
    mutate(data)
    for (const [key, folder] of Object.entries(data.folders)) {
      if (folder.plans.length === 0 && !folder.reply) delete data.folders[key]
    }
    const snapshot = JSON.stringify(data, null, 2)
    this.writes = this.writes.then(() => this.persist(snapshot)).catch(() => undefined)
    await this.writes
  }

  private async load(): Promise<ProjectQueueData> {
    if (!this.file) return empty()
    try {
      const parsed = Data.safeParse(JSON.parse(await readFile(this.file, 'utf8')))
      return parsed.success ? (parsed.data as ProjectQueueData) : empty()
    } catch {
      return empty()
    }
  }

  private async persist(snapshot: string): Promise<void> {
    if (!this.file) return
    try {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await writeFile(tmp, snapshot, 'utf8')
      await rename(tmp, this.file)
    } catch (err) {
      console.warn('[fila do projeto] não consegui gravar o estado:', err instanceof Error ? err.message : String(err))
    }
  }
}
