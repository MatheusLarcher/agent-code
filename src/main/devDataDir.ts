import { app } from 'electron'
import { join, resolve } from 'node:path'

/**
 * Só em desenvolvimento (app NÃO empacotado): `AGENT_CODE_DEV_DATA_DIR` isola uma
 * instância de teste — o `userData` (devDataDirBoot.ts, antes de qualquer outro
 * módulo), o ponteiro e a pasta de dados padrão (store.ts) e a "home" onde a
 * sincronia de skills escreve (skillManager.ts) ficam dentro dela. Sem isso, uma
 * segunda instância abriria a pasta de dados REAL pelo ponteiro em
 * `~/.agent-code` e mexeria nas skills de `~/.claude`. O app instalado ignora a
 * variável.
 */
export function devDataDir(): string | null {
  const dir = process.env['AGENT_CODE_DEV_DATA_DIR']?.trim()
  if (!dir) return null
  try {
    if (app.isPackaged) return null
  } catch {
    return null
  }
  return resolve(dir)
}

/** A "home" da instância isolada (`<dir>/home`); `null` fora dela. */
export function devUserHome(): string | null {
  const dev = devDataDir()
  return dev ? join(dev, 'home') : null
}
