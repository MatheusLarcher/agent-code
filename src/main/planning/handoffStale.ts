import { promises as fs } from 'node:fs'
import path from 'node:path'
import { handoffMetaName, listHandoffs, type HandoffFile } from './handoffFiles'
import { readHandoffsSent } from './handoffSent'
import { resolvePlanPath } from './planningStore'

/**
 * Prompts de handoff VELHOS: gravados antes da última mudança do plano
 * (`_roteiro.md` ou algum `cards/*.md` alterado depois da data do prompt). Quando
 * o plano muda, os prompts antigos não podem se misturar com os novos no
 * "Enviar para implementação" — e o Agent Manager não consegue apagá-los (a
 * pasta é bloqueada para ele, e as ferramentas só gravam).
 *
 * O que sai, sempre depois de perguntar ao usuário: só os velhos NÃO enviados,
 * o `.md` e o `.meta.json`, que vão para `_handoff/_descartados/`. A pasta não
 * aparece no diálogo nem para o Manager (`listHandoffs` só lê arquivos da
 * própria pasta) e os arquivos continuam no disco. Prompt já enviado (ou
 * substituído, ou marcado à mão em `enviados.json`) nunca sai: é histórico.
 */

export const HANDOFF_DISCARD_DIR = '_descartados'

/** O instante (ms) da última mudança do plano: o mtime mais novo entre o roteiro e os cards. */
export async function planLastChange(projectCwd: string, slug: string): Promise<number> {
  let latest = 0
  const seen = async (file: string): Promise<void> => {
    const stat = await fs.stat(file).catch(() => null)
    if (stat?.isFile()) latest = Math.max(latest, stat.mtimeMs)
  }
  await seen(await resolvePlanPath(projectCwd, slug, '_roteiro.md'))
  const cards = await resolvePlanPath(projectCwd, slug, 'cards')
  const entries = await fs.readdir(cards, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) await seen(path.join(cards, entry.name))
  }
  return Math.round(latest)
}

export interface StaleHandoffs {
  /** Os velhos não enviados, na ordem do `listHandoffs`. */
  stale: HandoffFile[]
  planChangedAt: number
}

/** Os prompts velhos ainda não enviados. Sem `_handoff/`, nenhum. */
export async function findStaleHandoffs(
  projectCwd: string,
  slug: string,
  known?: { handoffs: readonly HandoffFile[]; sentNames: readonly string[] }
): Promise<StaleHandoffs> {
  const [handoffs, sentNames, planChangedAt] = await Promise.all([
    known ? Promise.resolve(known.handoffs) : listHandoffs(projectCwd, slug),
    known ? Promise.resolve(known.sentNames) : readHandoffsSent(projectCwd, slug).then((read) => read.entries.map((e) => e.nome)),
    planLastChange(projectCwd, slug)
  ])
  const sent = new Set(sentNames)
  return { stale: handoffs.filter((h) => !sent.has(h.name) && h.createdAt < planChangedAt), planChangedAt }
}

/** Um nome livre em `_descartados/`: o mesmo prompt descartado duas vezes não se sobrescreve. */
async function freeTarget(dir: string, name: string, now: number): Promise<string> {
  const target = path.join(dir, name)
  if (!(await fs.stat(target).then(() => true, () => false))) return target
  const ext = name.toLowerCase().endsWith('.meta.json') ? '.meta.json' : path.extname(name)
  return path.join(dir, `${name.slice(0, name.length - ext.length)}.${now}${ext}`)
}

/**
 * Move os prompts velhos não enviados (todos, ou só os de `only`) para
 * `_handoff/_descartados/`, com o `.meta.json` de cada um. Devolve os nomes
 * movidos. Nome que não é velho, ou já foi enviado, é ignorado — nunca sai.
 */
export async function discardStaleHandoffs(
  projectCwd: string,
  slug: string,
  only?: readonly string[],
  now: number = Date.now()
): Promise<string[]> {
  const { stale } = await findStaleHandoffs(projectCwd, slug)
  const targets = only ? stale.filter((h) => only.includes(h.name)) : stale
  if (targets.length === 0) return []
  const dir = await resolvePlanPath(projectCwd, slug, '_handoff', HANDOFF_DISCARD_DIR)
  await fs.mkdir(dir, { recursive: true })
  const moved: string[] = []
  for (const handoff of targets) {
    for (const name of [handoff.name, handoffMetaName(handoff.name)]) {
      const from = await resolvePlanPath(projectCwd, slug, '_handoff', name)
      try {
        await fs.rename(from, await freeTarget(dir, name, now))
      } catch (err) {
        // Prompt sem .meta.json (antigo), ou já movido por outra janela.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
    moved.push(handoff.name)
  }
  return moved
}
