import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationRecord } from '../types'

/** O último instantâneo de uma conversa que ainda não chegou ao banco. */
export interface JournalEntry {
  id: string
  deleted: boolean
  doc: ConversationRecord | null
  /** Quando a mudança mais antiga ainda não gravada chegou (ms). */
  since: number
}

/**
 * O diário da fila de gravação (`%LOCALAPPDATA%\agent-code\fila`): o que não drenou
 * em poucos segundos (banco lento ou fora do ar) e o que sobrou no fechamento. Um
 * arquivo por conversa, com o último instantâneo — a fila já coalesceu, então só a
 * versão mais nova importa. Reaplicar é idempotente: a gravação compara pelo hash
 * do conteúdo e rebaseia pela revisão.
 */
export class ConversationJournal {
  constructor(private readonly dir: string) {}

  private fileOf(id: string): string {
    return join(this.dir, `${createHash('sha256').update(id).digest('hex').slice(0, 40)}.json`)
  }

  async save(entry: JournalEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const target = this.fileOf(entry.id)
    const temp = `${target}.tmp-${process.pid}`
    await writeFile(temp, JSON.stringify({ v: 1, ...entry }), 'utf8')
    // O antivírus costuma segurar por instantes o arquivo recém-escrito.
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(temp, target)
        return
      } catch (error) {
        if (attempt >= 5) {
          await rm(temp, { force: true }).catch(() => undefined)
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
      }
    }
  }

  async remove(id: string): Promise<void> {
    await rm(this.fileOf(id), { force: true })
  }

  /** Tudo o que está no diário. Arquivo ilegível é posto de lado, nunca apagado. */
  async loadAll(): Promise<JournalEntry[]> {
    const names = await readdir(this.dir).catch(() => [] as string[])
    const entries: JournalEntry[] = []
    for (const name of names) {
      const path = join(this.dir, name)
      if (name.includes('.tmp-')) {
        await rm(path, { force: true }).catch(() => undefined)
        continue
      }
      if (!name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<JournalEntry> & { v?: unknown }
        const valid =
          parsed.v === 1 &&
          typeof parsed.id === 'string' &&
          typeof parsed.deleted === 'boolean' &&
          (parsed.deleted || (typeof parsed.doc === 'object' && parsed.doc !== null && parsed.doc.id === parsed.id))
        if (!valid) throw new Error('entrada inválida')
        entries.push({
          id: parsed.id as string,
          deleted: parsed.deleted as boolean,
          doc: parsed.deleted ? null : (parsed.doc as ConversationRecord),
          since: typeof parsed.since === 'number' ? parsed.since : Date.now()
        })
      } catch {
        await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => undefined)
      }
    }
    return entries
  }
}
