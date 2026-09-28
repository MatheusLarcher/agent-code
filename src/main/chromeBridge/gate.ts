/** Ferramentas do servidor chrome que só leem — liberadas sem perguntar com o toggle ligado. */
export const CHROME_READ_TOOLS: ReadonlySet<string> = new Set(
  ['chrome_status', 'chrome_list_tabs', 'chrome_snapshot', 'chrome_screenshot', 'chrome_scroll', 'chrome_wait'].map(
    (t) => `mcp__chrome__${t}`
  )
)

export const CHROME_DISABLED_MESSAGE =
  'Controle do Chrome desativado. Ative “Permitir controle do Chrome” nas Configurações.'

/**
 * Gate do controle do Chrome, avaliado ANTES do "Permitir tudo":
 * - 'deny'  → toggle desligado (ou config corrompida): nega sempre;
 * - 'allow' → ferramenta de leitura com toggle ligado;
 * - null    → não é do chrome, ou é escrita: segue o fluxo normal de permissão.
 */
export function chromeGateDecision(toolName: string, enabled: unknown): 'allow' | 'deny' | null {
  if (!toolName.startsWith('mcp__chrome__')) return null
  if (enabled !== true) return 'deny'
  return CHROME_READ_TOOLS.has(toolName) ? 'allow' : null
}
