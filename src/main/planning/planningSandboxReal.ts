import { promises as fs } from 'node:fs'
import path from 'node:path'
import { planSandboxDirPath } from './planningRoot'

/**
 * A conferência do _sandbox do Agent Manager pelo caminho REAL. O escopo do
 * writeScopeGuard compara caminhos como texto: `_sandbox/x/a.ts` casa o glob
 * mesmo se `_sandbox/x` for uma junction (ou symlink) para `src/`, e a escrita
 * cairia fora. Aqui cada destino é resolvido pelo ancestral existente mais
 * profundo (o alvo em si pode ainda não existir) e tem de continuar dentro do
 * realpath do _sandbox — o mesmo molde do `resolvePlanPath` do store.
 *
 * Falha fechada: link quebrado, erro de disco diferente de "não existe" e
 * _sandbox que não está no lugar esperado viram recusa com o motivo.
 */

/** O caminho não pôde ser conferido de forma segura. */
export class SandboxRealPathError extends Error {}

const ABSENT = new Set(['ENOENT', 'ENOTDIR'])

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * O realpath do ancestral existente mais profundo de `p`, com os segmentos que
 * ainda não existem reanexados. Uma entrada que existe mas cujo realpath falha
 * (link quebrado: gravar nela criaria o arquivo onde o link aponta) é recusada.
 */
export async function realpathDeepest(p: string): Promise<string> {
  let probe = path.resolve(p)
  const missing: string[] = []
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      return path.join(real, ...missing.reverse())
    } catch (err) {
      if (!ABSENT.has((err as NodeJS.ErrnoException).code ?? '')) throw err
      const dangling = await fs.lstat(probe).then(
        (st) => st.isSymbolicLink(),
        () => false
      )
      if (dangling) throw new SandboxRealPathError(`"${probe}" é um link quebrado`)
      const parent = path.dirname(probe)
      if (parent === probe) return path.resolve(p)
      missing.push(path.basename(probe))
      probe = parent
    }
  }
}

/**
 * `null` = todos os destinos ficam dentro do _sandbox real. Texto = motivo da
 * recusa, legível pelo modelo. `targets` relativos resolvem contra o projeto
 * (é como o Write e o Bash sem `cd` os interpretam).
 */
export async function sandboxRealPathDenial(
  projectCwd: string,
  slug: string,
  toolName: string,
  targets: readonly string[]
): Promise<string | null> {
  if (!targets.length) return null
  // O _sandbox mora no projeto (docs/spec/<slug>/_sandbox), não na pasta do
  // plano — esta vive na pasta de dados do app, onde o Manager não grava.
  const sandbox = planSandboxDirPath(projectCwd, slug)
  const planDir = path.dirname(sandbox)
  const refuse = (why: string): string =>
    `${toolName} recusado no Agent Manager: ${why}. A escrita só vale dentro da pasta real ${sandbox} — ` +
    'junction, symlink ou link quebrado que aponte para fora dela não conta como _sandbox.'
  try {
    // O _sandbox tem de ser uma pasta real no lugar dele: se ele (ou a pasta do
    // plano) for um link, "dentro do _sandbox real" seria dentro de outro lugar.
    const realSpec = await realpathDeepest(path.dirname(planDir))
    const realSandbox = await realpathDeepest(sandbox)
    if (!samePath(realSandbox, path.join(realSpec, slug, '_sandbox'))) {
      return refuse(`o próprio _sandbox resolve para ${realSandbox}`)
    }
    for (const target of targets) {
      const abs = path.isAbsolute(target) ? target : path.resolve(projectCwd, target)
      const real = await realpathDeepest(abs)
      if (!isInside(realSandbox, real)) return refuse(`"${target}" resolve para ${real}, fora do _sandbox`)
    }
    return null
  } catch (err) {
    return refuse(`não deu para conferir o caminho real (${err instanceof Error ? err.message : String(err)})`)
  }
}
