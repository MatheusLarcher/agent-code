import { join } from 'node:path'

/** `=1` liga o feed local de atualização na instância de desenvolvimento. */
export const DEV_UPDATE_FEED_ENV = 'AGENT_CODE_DEV_UPDATE_FEED'
/** O yml do feed local (gitignored), na raiz do repositório: `provider: generic`, `url: http://127.0.0.1:<porta>/`. */
export const DEV_UPDATE_CONFIG_FILENAME = 'dev-app-update.yml'
/** `=1`: o ensaio faz o fechamento ordenado inteiro e sai do app SEM chamar o instalador. */
export const DEV_UPDATE_DRY_INSTALL_ENV = 'AGENT_CODE_DEV_UPDATE_DRY_INSTALL'

/**
 * Só em desenvolvimento (app não empacotado) e só com AGENT_CODE_DEV_UPDATE_FEED=1:
 * o electron-updater passa a ler `dev-app-update.yml` da raiz do repositório em
 * vez do `app-update.yml` do instalador. O app instalado ignora a variável.
 */
export function devUpdateFeedConfigPath(env: NodeJS.ProcessEnv, isPackaged: boolean, repoRoot: string): string | null {
  if (isPackaged) return null
  if (env[DEV_UPDATE_FEED_ENV]?.trim() !== '1') return null
  return join(repoRoot, DEV_UPDATE_CONFIG_FILENAME)
}

/** Ensaio sem instalar: só na instância de desenvolvimento. */
export function devUpdateDryInstall(env: NodeJS.ProcessEnv, isPackaged: boolean): boolean {
  return !isPackaged && env[DEV_UPDATE_DRY_INSTALL_ENV]?.trim() === '1'
}
