/**
 * Botão que não rouba o foco do campo de texto: com o teclado aberto, o toque não
 * dispara o `focusout` (que fecharia o teclado e faria a tela pular entre o toque e
 * o click). O click continua normal. Uso: `<button {...noFocusSteal} onClick={...}>`.
 */
const keep = (e: { preventDefault: () => void }): void => e.preventDefault()

export const noFocusSteal = { onPointerDown: keep, onMouseDown: keep } as const
