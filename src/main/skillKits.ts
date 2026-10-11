import { join } from 'node:path'
import type { AppConfig } from '../shared/ipc'
import { directoryDigest, skillNames } from './skillDirs'

/**
 * Kits de skills embutidos que só existem com um interruptor ligado. Cada kit é
 * uma pasta irmã de `.agents/skills` (`<appRoot>/.agents/<dir>`), empacotada no
 * instalador do mesmo jeito; o skillManager só a sincroniza para o cache quando o
 * kit está ativo. Desligado, as skills dele saem do cache e da raiz nativa — não
 * aparecem no catálogo do app, na lista do SDK nem no menu "/".
 *
 * O nome de uma skill de kit pertence ao kit: a mesma pasta em `.agents/skills`
 * (um `npx skills` que restaure o lock ali) ou na semente do instalador é ignorada.
 * Kit novo: uma entrada aqui, a pasta em `.agents/` e a linha no electron-builder.yml.
 */
type KitConfig = Partial<Pick<AppConfig, 'handoff' | 'skillCatalog'>>

export const SKILL_KITS = [
  // A curadoria do ECC (docs/validation/skills-ecc-curadoria-*.md): só com o
  // catálogo em níveis, que as põe como nome por categoria em vez de inflar o prompt.
  { id: 'ecc', dir: 'skills-ecc', enabled: (config: KitConfig): boolean => config.skillCatalog?.tiered === true }
] as const

export type SkillKitId = (typeof SKILL_KITS)[number]['id']

const KIT_DIRS = Object.fromEntries(SKILL_KITS.map((kit) => [kit.id, kit.dir])) as Record<SkillKitId, string>

/** A pasta do kit dentro do app (`<appRoot>/.agents/<dir>`). */
export function skillKitRoot(appRoot: string, id: SkillKitId): string {
  return join(appRoot, '.agents', KIT_DIRS[id])
}

/** Os kits que a config liga. Config sem o grupo (mock parcial): nenhum. */
export function activeSkillKits(config: KitConfig): SkillKitId[] {
  return SKILL_KITS.filter((kit) => kit.enabled(config)).map((kit) => kit.id)
}

/** Todo nome de skill que pertence a um kit, ativo ou não. */
export function kitSkillNames(appRoot: string): Set<string> {
  return new Set(SKILL_KITS.flatMap((kit) => skillNames(skillKitRoot(appRoot, kit.id))))
}

/** As skills empacotadas a materializar (nome → pasta de origem): `.agents/skills`
 *  menos os nomes de kit, mais as skills dos kits ativos. A primeira origem vence. */
export function bundledSkillSources(
  appRoot: string,
  kits: readonly SkillKitId[],
  kitOwned: ReadonlySet<string> = kitSkillNames(appRoot)
): Map<string, string> {
  const sources = new Map<string, string>()
  const baseRoot = join(appRoot, '.agents', 'skills')
  for (const name of skillNames(baseRoot)) if (!kitOwned.has(name)) sources.set(name, join(baseRoot, name))
  for (const id of kits) {
    const root = skillKitRoot(appRoot, id)
    for (const name of skillNames(root)) if (!sources.has(name)) sources.set(name, join(root, name))
  }
  return sources
}

/** A parte dos kits ativos na versão das skills gerenciadas: ligar ou desligar um
 *  kit muda a versão, e a sessão ressincroniza no próximo envio. */
export function kitsDigest(appRoot: string, kits: readonly SkillKitId[]): string[] {
  return kits.map((id) => `${id}:${directoryDigest(skillKitRoot(appRoot, id))}`)
}
