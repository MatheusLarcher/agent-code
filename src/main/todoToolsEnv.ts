/**
 * O CLI embutido só oferece TodoWrite/TaskCreate numa sessão do SDK quando o
 * modelo está numa lista interna dele OU com `CLAUDE_CODE_ENABLE_TODO_TOOLS`
 * ligado. Com os modelos novos (Opus 5.5…) as ferramentas somem, e sem elas o
 * plano do agente não vira cartão no Quadro — a fila de handoffs trava em "sem
 * cartão no Quadro com o prefixo [etapa]".
 *
 * `env` undefined = a sessão herda o processo (conta padrão): parte dele.
 */
export function withTodoTools(env: NodeJS.ProcessEnv | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...(env ?? base), CLAUDE_CODE_ENABLE_TODO_TOOLS: 'true' }
}
