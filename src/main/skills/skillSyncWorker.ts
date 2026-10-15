/**
 * Worker da sincronização de skills: digests, cópias e remoções do cache e de
 * `~/.claude/skills` fora do thread principal (com ~250 skills num cache no
 * OneDrive, o envio de uma mensagem ficava ~1 s preso nisso). Bundle próprio
 * (electron.vite.config.ts), irmão do index.js do main; não importa 'electron'.
 */
import { parentPort } from 'node:worker_threads'
import { runSkillSync, type SkillSyncRequest } from './skillSyncTask'

parentPort?.on('message', (message: { id: number; request: SkillSyncRequest }) => {
  try {
    parentPort?.postMessage({ id: message.id, ok: true, response: runSkillSync(message.request) })
  } catch (error) {
    const typed = error as { message?: unknown }
    parentPort?.postMessage({ id: message.id, ok: false, error: String(typed?.message ?? error) })
  }
})
