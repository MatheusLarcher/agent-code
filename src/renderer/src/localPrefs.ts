/**
 * Escolhas da interface lembradas entre sessões, no localStorage — síncrono,
 * então a tela já abre do jeito que o usuário deixou (a aba principal, o chat
 * minimizado, o roteiro do Planejamento…). Sem storage (modo privado, cota),
 * nada quebra: a leitura volta null e a escolha vale só nesta sessão.
 */

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Sem storage (modo privado, cota): a escolha vale só nesta sessão.
  }
}

/** Liga/desliga gravado como '1'/'0'. Padrão (nada gravado ou outro valor): desligado. */
export function loadFlag(key: string): boolean {
  return readPref(key) === '1'
}

export function saveFlag(key: string, on: boolean): void {
  writePref(key, on ? '1' : '0')
}
