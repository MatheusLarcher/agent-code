/** 262144 → "256K", 1048576 → "1M" (janelas do Kimi são potências de 2). */
export function windowLabel(tokens: number): string {
  if (tokens >= 1_048_576) return `${Math.round(tokens / 1_048_576)}M`
  return `${Math.round(tokens / 1024)}K`
}

interface Props {
  /** Janela detectada no "Testar conexão" (config.kimi.contextWindow). */
  contextWindow?: number
}

/** "Kimi · assinatura" na barra de cima: o Kimi Code é por assinatura, sem saldo nem custo por token. */
export function KimiUsageBadge({ contextWindow }: Props): JSX.Element {
  const janela = contextWindow ? ` · janela ${windowLabel(contextWindow)}` : ''
  return (
    <div
      className="usage-badge deepseek-usage kimi-usage"
      title="Conversa no Kimi Code, pela sua assinatura: sem cobrança por token. A cota do plano é a do console do Kimi."
    >
      <span className="usage-provider muted">{`Kimi · assinatura${janela}`}</span>
    </div>
  )
}
