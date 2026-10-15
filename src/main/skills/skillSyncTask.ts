/**
 * O trabalho de disco da sincronização de skills, sem nada de Electron: roda no
 * worker (skillSyncWorker.ts) e, sem o bundle dele (testes), no próprio thread.
 * Tudo que dependeria do app (home do dev, máquina, kits, raiz) vem no pedido.
 */
import {
  exposeCacheSkills,
  managedSkillsFilesystemVersion,
  syncCacheSkills,
  type SkillSyncResult
} from '../skillManager'
import type { SkillKitId } from '../skillKits'

/**
 * - `full`: copia o kit gerenciado (e os kits ligados) para o cache e expõe;
 * - `expose`: completa se a origem mudou, senão só expõe o cache em `~/.claude/skills`;
 * - `check`: completa se a origem mudou, senão não toca no disco.
 */
export type SkillSyncMode = 'full' | 'expose' | 'check'

export interface SkillSyncRequest {
  mode: SkillSyncMode
  appRoot: string
  cacheDir: string
  skillsDir: string
  userHome: string
  machine: string
  kits: SkillKitId[]
  /** Versão da origem já copiada para este cache; diferente = sincronização completa. */
  knownVersion: string
}

export interface SkillSyncResponse {
  /** Versão de conteúdo da origem gerenciada (managedSkillsFilesystemVersion). */
  version: string
  /** Rodou a sincronização completa (syncCacheSkills). */
  full: boolean
  /** Tocou no disco (completa ou exposição). */
  ran: boolean
  result: SkillSyncResult
}

export function runSkillSync(request: SkillSyncRequest): SkillSyncResponse {
  const { appRoot, cacheDir, skillsDir, userHome, machine, kits } = request
  const version = managedSkillsFilesystemVersion(appRoot, kits)
  if (request.mode === 'full' || version !== request.knownVersion) {
    return { version, full: true, ran: true, result: syncCacheSkills(appRoot, cacheDir, userHome, kits, machine) }
  }
  if (request.mode === 'expose') {
    return { version, full: false, ran: true, result: exposeCacheSkills(skillsDir, userHome, machine) }
  }
  return { version, full: false, ran: false, result: { skillsDir, available: [], errors: [] } }
}
