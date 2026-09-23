import { cp, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * Cache, log e backup que versões anteriores gravavam na pasta de dados
 * escolhida pelo usuário. Essa pasta costuma ficar no OneDrive/Drive e é só para
 * o que é permanente e muda pouco (memórias, skills, cofre); o resto mora na
 * raiz local (`userData/agent-code-local`). `[origem, destino]`, relativos às
 * duas raízes.
 */
export const LOCAL_LEFTOVERS: ReadonlyArray<readonly [string, string]> = [
  ['cli-config-sem-login', 'cli-config-sem-login'],
  ['memorias-longo-praso', 'memorias-longo-praso'],
  ['migration-manifests', 'migration-manifests'],
  ['tmp-audio', 'tmp-audio'],
  ['auth-debug.log', join('logs', 'auth-debug.log')]
]

export interface LeftoverRelocation { moved: string[]; failed: string[] }

let pending: Promise<LeftoverRelocation> = Promise.resolve({ moved: [], failed: [] })

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null
}

async function relocateOne(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  if (!(await exists(to))) {
    try {
      await rename(from, to)
      return
    } catch {
      /* outro volume (D: → C:): cai na cópia abaixo */
    }
  }
  // Copia sem sobrescrever: o que já está no destino é mais novo (o app já
  // gravou lá depois da mudança). A origem só sai depois da cópia inteira.
  await cp(from, to, { recursive: true, force: false, errorOnExist: false })
  await rm(from, { recursive: true, force: true })
}

/** Move o que sobrou na pasta sincronizada. Idempotente e nunca lança: o que
 *  falhar fica onde está e é tentado de novo na próxima abertura. */
export function relocateLocalLeftovers(syncRoot: string, localRoot: string): Promise<LeftoverRelocation> {
  pending = pending.then(async () => {
    const result: LeftoverRelocation = { moved: [], failed: [] }
    if (resolve(syncRoot) === resolve(localRoot)) return result
    for (const [fromRel, toRel] of LOCAL_LEFTOVERS) {
      const from = join(syncRoot, fromRel)
      if (!(await exists(from))) continue
      try {
        await relocateOne(from, join(localRoot, toRel))
        result.moved.push(fromRel)
      } catch {
        result.failed.push(fromRel)
      }
    }
    return result
  })
  return pending
}

/** Quem usa uma dessas pastas espera a mudança em curso terminar — por exemplo,
 *  não abrir uma sessão GPT no meio da cópia da transcrição que ela vai retomar. */
export function localLeftoversSettled(): Promise<unknown> {
  return pending
}
