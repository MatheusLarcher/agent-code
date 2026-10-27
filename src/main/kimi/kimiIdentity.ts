/**
 * Endereços do Kimi Code e a identidade com que o Agent Code se apresenta.
 *
 * Identidade honesta, sempre: as chamadas do próprio app (Testar conexão) vão
 * com o User-Agent do Agent Code; as do CLI passam pelo roteador com o
 * User-Agent do claude-cli que as fez. Nenhum cabeçalho de outro cliente
 * (`X-Msh-*`), nenhum client_id de cliente oficial. Fonte: docs do Kimi Code
 * (kimi.ai/code/docs), sondado ao vivo em 26/10/2026 — a chave vale nas duas
 * regiões, com `Authorization: Bearer` ou `x-api-key`, e com o UA do app.
 */
export type KimiRegion = 'intl' | 'cn'

/** Endpoint compatível com a Anthropic: o CLI acrescenta `/v1/messages`. */
export function kimiCodingBase(region: KimiRegion): string {
  return region === 'cn' ? 'https://api.kimi.com/coding' : 'https://api.kimi.ai/coding'
}

/** Cabeçalhos das chamadas que o próprio app faz ao Kimi (`appVersion` =
 *  `app.getVersion()`, passado por quem chama para o módulo não depender do Electron). */
export function kimiHeaders(apiKey: string, appVersion = 'dev'): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'anthropic-version': '2023-06-01',
    'user-agent': `AgentCode/${appVersion}`
  }
}
