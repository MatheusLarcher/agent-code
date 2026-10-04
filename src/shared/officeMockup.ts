/**
 * O HTML do agente no Escritório (Fase 2, dec-rede-html): contrato entre o main
 * (protocolo `agent-mockup`, janela escondida de captura) e o renderer (a TV e o
 * foco dentro dela).
 *
 * URL: `agent-mockup://<token>/<caminho relativo ao cwd>` — o token aponta para o
 * cwd da conversa no main, então a página (e o que ela pede de relativo) só
 * alcança arquivos dali. A CSP deixa carregar recursos da internet (CDN, fontes,
 * imagens) mas não deixa sair nada: fetch/XHR/WebSocket só para a própria origem.
 */
export const MOCKUP_SCHEME = 'agent-mockup'

/** A CSP de toda resposta do protocolo (não afrouxar: é o "sem sair" escolhido). */
export const MOCKUP_CSP = "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self'"

/** Tamanho da captura (a proporção ~2:1 da TV) e quanto ela espera. */
export const MOCKUP_CAPTURE_W = 1280
export const MOCKUP_CAPTURE_H = 640
export const MOCKUP_CAPTURE_TIMEOUT_MS = 5_000

/** Um HTML do agente: o cwd da conversa e o caminho absoluto do arquivo. */
export interface MockupRequest {
  cwd: string
  path: string
}

/** O endereço do mockup no protocolo (para o iframe do foco), ou por que não. */
export type MockupUrlResult = { ok: true; url: string } | { ok: false; error: string }

/** A captura (PNG) para a TV em 3D, ou por que não (a TV mostra o esqueleto com o nome do arquivo). */
export type MockupCaptureResult = { ok: true; url: string; png: Uint8Array } | { ok: false; error: string }
