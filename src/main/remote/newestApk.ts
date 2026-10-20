import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * O APK que o celular baixa pelo PC: o mais novo da pasta `dist` do
 * smartfone-remote (o release `Agent-Remote-<versão>-release.apk` ou o
 * `agent-remote.apk` do botão "Gerar APK"), não um nome fixo que fica velho.
 * Sem nenhum, devolve o caminho padrão (o servidor responde 404).
 */
export function newestApk(distDir: string, fallback = 'agent-remote.apk'): string {
  let best = ''
  let bestTime = -1
  try {
    for (const name of readdirSync(distDir)) {
      if (!name.toLowerCase().endsWith('.apk')) continue
      const full = join(distDir, name)
      const t = statSync(full).mtimeMs
      if (t > bestTime) {
        best = full
        bestTime = t
      }
    }
  } catch {
    /* pasta ainda não existe */
  }
  return best || join(distDir, fallback)
}
