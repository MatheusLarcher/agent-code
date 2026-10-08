import { homedir } from 'node:os'
import { join } from 'node:path'
import { devDataDir } from './devDataDir'

/**
 * Raiz do que é desta máquina e muda o tempo todo — os dados do PostgreSQL
 * embutido e o SQLite da configuração: `%LOCALAPPDATA%\agent-code`. Nunca a pasta
 * de dados escolhida pelo usuário (costuma ser o OneDrive, que trava e sincroniza
 * arquivo no meio da escrita) nem o `%APPDATA%` (perfil móvel). Na instância
 * isolada de desenvolvimento (`AGENT_CODE_DEV_DATA_DIR`), dentro dela.
 */
export function machineLocalDir(): string {
  const dev = devDataDir()
  if (dev) return join(dev, 'localappdata', 'agent-code')
  const base = process.env['LOCALAPPDATA']?.trim() || join(homedir(), 'AppData', 'Local')
  return join(base, 'agent-code')
}
