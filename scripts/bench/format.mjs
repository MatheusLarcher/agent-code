// Formato ÚNICO da conversa, usado tanto pelo harness quanto pelo gerador de
// dataset. Treinar num formato e cobrar noutro foi exatamente o erro da primeira
// tentativa (o modelo aprendeu a narrar edições e o teste pedia arquivo inteiro),
// então os dois lados importam daqui e não podem divergir.

export const SYSTEM =
  'Você é um engenheiro sênior de TypeScript trabalhando num app Electron + React. Siga a especificação à risca e responda somente no formato pedido.'

export const PROTOCOL = `
## Formato da resposta

Um bloco de código por arquivo, e a PRIMEIRA linha de cada bloco é o caminho:

\`\`\`ts
// ARQUIVO: src/shared/archive.ts
...conteúdo COMPLETO do arquivo...
\`\`\`

Para um arquivo que já existe, reescreva-o inteiro, já com as mudanças (não use
"...resto igual", não corte nada). Nada de texto fora dos blocos. Não escreva testes.
TypeScript estrito, sem dependência nova.`

/** Bloco de contexto de um arquivo, no mesmo layout que o harness monta. */
export function contextBlock(rel, content) {
  return `--- ${rel} ---\n${content}`
}

/** A mensagem do usuário: pedido + arquivos atuais + protocolo. */
export function userMessage(pedido, arquivos) {
  const contexto = arquivos.length
    ? `\n\n## Arquivos atuais do projeto\n\n${arquivos.map(([rel, c]) => contextBlock(rel, c)).join('\n\n')}`
    : ''
  return `${pedido}${contexto}\n${PROTOCOL}`
}

/** A resposta esperada: um bloco por arquivo, conteúdo completo. */
export function assistantMessage(arquivos) {
  return arquivos.map(([rel, c]) => `\`\`\`ts\n// ARQUIVO: ${rel}\n${c.replace(/\s*$/, '')}\n\`\`\``).join('\n\n')
}
