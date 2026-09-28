/**
 * `"Agent Code.exe" --minimizado`: o cliente MCP (o Forgia) abre o app sozinho,
 * achando o executável pelo registro. O app sobe minimizado e sem roubar o foco,
 * e o servidor MCP sobe normalmente. A única exceção é sem conta Claude
 * conectada: aí a janela vem para a frente, porque é a única hora em que o
 * usuário precisa ver o app (para entrar na conta).
 */
export const MINIMIZED_FLAG = '--minimizado'

export function wantsMinimized(argv: readonly string[]): boolean {
  return argv.some((a) => a.trim().toLowerCase() === MINIMIZED_FLAG)
}

/**
 * Outra instância foi aberta (a trava de instância única a encerra e avisa
 * esta). Sem `--minimizado`: traz a janela, como sempre. Com ele: só se não há
 * conta Claude conectada (`claudeReady === false`); desconhecido espera a leitura.
 */
export function secondInstanceReveal(argv: readonly string[], claudeReady: boolean | null): 'reveal' | 'stay' | 'check' {
  if (!wantsMinimized(argv)) return 'reveal'
  if (claudeReady === null) return 'check'
  return claudeReady ? 'stay' : 'reveal'
}
