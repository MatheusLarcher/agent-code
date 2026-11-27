import { getSessionInfo, getSessionMessages, importSessionToStore } from '@anthropic-ai/claude-agent-sdk'
import type { PersistenceRepository } from './persistence/types'
import { hashJson, normalizeJson } from './persistence/hashes'
import { loadOnce } from './persistence/mirrorReplay'

/** 'ready': a sessão pode ser retomada (já estava pronta ou passou na verificação).
 *  'missing': não há transcript em lugar nenhum (nem no disco, nem no Postgres) —
 *  quem chama começa uma sessão nova em vez de travar a conversa. Qualquer outra
 *  falha (armazenamento, leitura, marcação) continua lançando. */
export async function prepareSessionResume(
  repository: PersistenceRepository,
  convId: string,
  cwd: string,
  sessionId: string
): Promise<'ready' | 'missing'> {
  if (await repository.sessionResumeReady(convId, sessionId)) return 'ready'
  const store = repository.createSessionStore(convId)
  await importSessionToStore(sessionId, store, { dir: cwd, includeSubagents: true }).catch(() => undefined)
  // Depois da importação: as três leituras abaixo dividem UM download da sessão (loadOnce).
  const reader = loadOnce(store)
  const [info, entries] = await Promise.all([
    getSessionInfo(sessionId, { dir: cwd, sessionStore: reader }),
    reader.load({ projectKey: convId, sessionId })
  ])
  if (!info || !entries?.length) return 'missing'
  const verifiedHash = hashJson(normalizeJson(entries))
  await getSessionMessages(sessionId, { dir: cwd, sessionStore: reader })
  await repository.markSessionResumeReady(convId, sessionId, true, verifiedHash)
  return 'ready'
}
