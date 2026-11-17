import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Onde a janela reaparece quando o perfil ficou guardado fora da tela. */
export const VISIBLE_WINDOW_ARGS = ['--window-position=80,60', '--window-size=1280,900'] as const

/** Abaixo disso a janela não está em monitor nenhum: é o estacionamento antigo (-32000). */
const PARKED_LIMIT = -20000

/**
 * As versões antigas abriam o Chrome do agente em -32000,-32000 e o Chrome grava
 * essa posição no perfil. Sem a flag, ele reabre o perfil encostado na borda de
 * um monitor, com poucos pixels à vista (medido: left -3186 num monitor que
 * começa em -1920). Só nesses perfis a janela é reposicionada; nos demais vale
 * o lugar onde o usuário a deixou.
 */
export function wasParkedOffscreen(userDataDir: string): boolean {
  try {
    const prefs = JSON.parse(readFileSync(join(userDataDir, 'Default', 'Preferences'), 'utf8')) as {
      browser?: { window_placement?: { left?: unknown; top?: unknown } }
    }
    const place = prefs.browser?.window_placement
    if (!place) return false
    return [place.left, place.top].some((v) => typeof v === 'number' && v <= PARKED_LIMIT)
  } catch {
    return false // perfil novo ou Preferences ilegível: o Chrome escolhe o lugar
  }
}

export function windowPlacementArgs(userDataDir: string): string[] {
  return wasParkedOffscreen(userDataDir) ? [...VISIBLE_WINDOW_ARGS] : []
}
