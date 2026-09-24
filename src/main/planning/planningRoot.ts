import path from 'node:path'
import { migrateLegacyPlans, projectKey } from './planningMigration'
import { assertValidName } from './planningModel'

/**
 * Onde moram os planejamentos de um projeto — sem tocar o disco, exceto na
 * migração (ensureMigrated).
 *
 * - Raiz: <dataDir>/planning/<projectKey>/, na pasta de dados do app (a mesma
 *   das memórias, sincronizada pelo OneDrive): o plano acompanha o usuário
 *   entre PCs como as conversas. O index.ts configura o resolvedor com
 *   setPlanningDataRoot; sem ele (testes, ferramentas) vale a raiz legada
 *   <cwd>/docs/spec/.
 * - _sandbox: sempre no projeto, <cwd>/docs/spec/<slug>/_sandbox/ — código
 *   descartável do Agent Manager, local de cada PC e gitignorado.
 */

export class PlanningPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanningPathError'
  }
}

/** Subpasta da pasta de dados onde moram os planejamentos. */
export const PLANNING_DATA_SUBDIR = 'planning'

/**
 * Quem diz qual é a pasta de dados do app. Consultado A CADA chamada: a pasta
 * pode trocar em runtime. `null` = raiz legada (docs/spec).
 */
let dataRootResolver: (() => string) | null = null

/** Configura (ou, com null, desliga) a pasta de dados de onde sai a raiz dos planejamentos. */
export function setPlanningDataRoot(resolver: (() => string) | null): void {
  dataRootResolver = resolver
}

/** <dataDir>/planning — a pasta dos planejamentos de todos os projetos. */
export function planningDataDir(dataDir: string): string {
  return path.join(path.resolve(dataDir), PLANNING_DATA_SUBDIR)
}

/** A raiz legada, no projeto: <cwd>/docs/spec. É também onde fica o _sandbox. */
export function legacySpecRoot(projectCwd: string): string {
  if (typeof projectCwd !== 'string' || !path.isAbsolute(projectCwd)) {
    throw new PlanningPathError('projectCwd deve ser caminho absoluto')
  }
  return path.join(path.resolve(projectCwd), 'docs', 'spec')
}

/** A pasta de dados configurada, ou null (sem resolvedor: raiz legada). */
function configuredDataDir(): string | null {
  if (!dataRootResolver) return null
  const dir = dataRootResolver()
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new PlanningPathError('pasta de dados do app inválida para os planejamentos')
  }
  return dir
}

/** Raiz dos planejamentos do projeto: <dataDir>/planning/<projectKey>, ou <cwd>/docs/spec sem resolvedor. */
export function planningRootFor(projectCwd: string): string {
  const legacy = legacySpecRoot(projectCwd)
  const dataDir = configuredDataDir()
  return dataDir === null ? legacy : path.join(planningDataDir(dataDir), projectKey(projectCwd))
}

/** Pasta de um planejamento (<raiz>/<slug>), sem tocar o disco. */
export function planDirPath(projectCwd: string, slug: string): string {
  assertValidName(slug, 'slug')
  return path.join(planningRootFor(projectCwd), slug)
}

/** Pasta do _sandbox do planejamento — sempre no projeto: <cwd>/docs/spec/<slug>/_sandbox. */
export function planSandboxDirPath(projectCwd: string, slug: string): string {
  assertValidName(slug, 'slug')
  return path.join(legacySpecRoot(projectCwd), slug, '_sandbox')
}

/**
 * Traz para a raiz nova os planos que ainda estão só em docs/spec (todos, ou
 * só `slug`). Sem resolvedor, a raiz é a legada: nada a fazer. Uma falha aqui
 * não derruba a listagem/abertura — o plano segue no legado e a próxima
 * chamada tenta de novo.
 */
export async function ensureMigrated(projectCwd: string, slug?: string): Promise<void> {
  const root = planningRootFor(projectCwd)
  const legacy = legacySpecRoot(projectCwd)
  if (root === legacy) return
  try {
    await migrateLegacyPlans(legacy, root, slug)
  } catch (err) {
    console.warn(`[planning] não foi possível migrar planos de ${legacy}:`, err)
  }
}
