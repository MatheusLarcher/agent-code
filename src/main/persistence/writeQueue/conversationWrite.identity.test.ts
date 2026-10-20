// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { ConversationRecord } from '../types'
import { writeConversationDoc, type WriteContext } from './conversationWrite'
import { inlinePreparer, type ConversationPreparer } from './preparer'
import { conversation, fakeRepository } from './queueTestKit'

/** Identidade de antes do `git remote add origin` e a de depois, da mesma pasta. */
const OLD = { projectId: 'projeto-antigo', signature: 'assinatura-antiga', remoteGit: '' }
const NEW = { projectId: 'projeto-novo', signature: 'assinatura-nova', remoteGit: 'github.com/org/repo' }
const FOLDER = resolve('C:/GitHub/agent-financeiro')

function setup(storedCwd?: string) {
  const db = fakeRepository()
  if (storedCwd !== undefined) {
    db.rows.set('c1', {
      payload: conversation('c1', ['oi'], { cwd: storedCwd, projectId: OLD.projectId, projectSignature: OLD.signature }) as ConversationRecord,
      revision: 3,
      contentHash: 'h3'
    })
  }
  const prepared: ConversationRecord[] = []
  const preparer: ConversationPreparer = {
    prepare: async (doc, scope) => {
      prepared.push(doc)
      return inlinePreparer.prepare(doc, scope)
    },
    dispose: () => undefined
  }
  const ctx: WriteContext = { repository: db.repository, preparer, identity: async () => NEW, installationId: 'pc-a' }
  return { db, ctx, prepared }
}

const staleDoc = (cwd: string): ConversationRecord =>
  conversation('c1', ['oi', 'de novo'], { cwd, projectId: OLD.projectId, projectSignature: OLD.signature }) as ConversationRecord

describe('identidade do projeto na gravação da conversa', () => {
  it('mesma pasta com remote novo grava com a identidade atual', async () => {
    const { db, ctx, prepared } = setup(FOLDER)
    const outcome = await writeConversationDoc(ctx, staleDoc(FOLDER.toUpperCase()), { revision: 3, contentHash: 'h3', deleted: false })
    expect(outcome.kind).toBe('written')
    expect(prepared.at(-1)).toMatchObject({ projectId: NEW.projectId, projectSignature: NEW.signature, projectRemoteGit: NEW.remoteGit })
    expect(db.rows.get('c1')?.revision).toBe(4)
  })

  it('pasta diferente da gravada continua recusada', async () => {
    const { db, ctx } = setup(resolve('C:/GitHub/outro-projeto'))
    await expect(writeConversationDoc(ctx, staleDoc(FOLDER), undefined))
      .rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA', message: 'A pasta selecionada não corresponde ao projeto desta conversa.' })
    expect(db.rows.get('c1')?.revision).toBe(3)
  })

  it('conversa sem registro no banco continua recusada', async () => {
    const { db, ctx } = setup()
    await expect(writeConversationDoc(ctx, staleDoc(FOLDER), undefined))
      .rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
    expect(db.rows.size).toBe(0)
  })

  it('divergência só de projectId também segue a pasta gravada', async () => {
    const { ctx, prepared } = setup(FOLDER)
    const doc = conversation('c1', ['oi'], { cwd: FOLDER, projectId: OLD.projectId }) as ConversationRecord
    await expect(writeConversationDoc(ctx, doc, undefined)).resolves.toMatchObject({ kind: 'written' })
    expect(prepared.at(-1)).toMatchObject({ projectId: NEW.projectId, projectSignature: NEW.signature })
  })
})
