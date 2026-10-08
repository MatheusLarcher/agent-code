import { appRestart } from './appRestartRuntime'
import { devDataDir } from './devDataDir'

/**
 * Ganchos do roteiro de validação, SÓ na instância isolada de teste: app não
 * empacotado, `AGENT_CODE_DEV_DATA_DIR` e `AGENT_CODE_DEV_HOOKS=1`. Ficam em
 * `globalThis.__agentCodeDev` para o Playwright (`electronApp.evaluate`) dirigir
 * o main sem modelo nem conta: uma conversa "no meio de um turno" para a guarda
 * da troca/restauração, e as ferramentas do agente chamadas como ele chamaria.
 */
export interface DevHookDeps {
  /** A ferramenta app_postgres_nuvem, pelo mesmo caminho do servidor MCP `app`. */
  cloudTool?: (input: unknown) => Promise<unknown>
  /** Guarda um segredo no cofre da instância isolada (para o {{secret:nome}}). */
  putSecret?: (name: string, value: string) => Promise<unknown>
}

export function installDevHooks(deps: DevHookDeps = {}): boolean {
  if (!devDataDir() || process.env['AGENT_CODE_DEV_HOOKS'] !== '1') return false
  const busy = new Map<string, () => void>()
  const hooks = {
    /** Uma conversa fictícia ocupada (ou livre de novo) no coordenador do app_restart. */
    setBusy(id: string, on: boolean): boolean {
      if (!appRestart) return false
      if (on && !busy.has(id)) busy.set(id, appRestart.register(id, () => ({ busy: true })).remove)
      if (!on) {
        busy.get(id)?.()
        busy.delete(id)
        appRestart.changed()
      }
      return true
    },
    cloudTool: (input: unknown) => (deps.cloudTool ? deps.cloudTool(input) : Promise.reject(new Error('sem ferramenta'))),
    putSecret: (name: string, value: string) => (deps.putSecret ? deps.putSecret(name, value) : Promise.reject(new Error('sem cofre')))
  }
  ;(globalThis as Record<string, unknown>)['__agentCodeDev'] = hooks
  console.warn('[dev] ganchos de validação ligados (instância isolada, AGENT_CODE_DEV_HOOKS=1)')
  return true
}
