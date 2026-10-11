/** O mínimo do `webContents` que interessa para saber quando a tela some. */
export interface RendererEvents {
  on(
    event: 'did-start-navigation',
    listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void
  ): unknown
  on(event: 'render-process-gone', listener: () => void): unknown
}

/**
 * Chama `onGone` só quando a tela some de verdade: recarga/navegação do frame
 * principal (F5) ou o processo do renderer morreu. Não usa `did-start-loading`:
 * ele dispara também quando a página insere um iframe (prévia de HTML, mockup,
 * srcdoc) ou faz `history.pushState`, sem recarga nenhuma — e aí o renderer
 * nunca reavisa que está pronto e as entregas do MCP ficam presas para sempre.
 */
export function watchRendererGone(wc: RendererEvents, onGone: () => void): void {
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) onGone()
  })
  wc.on('render-process-gone', () => onGone())
}
