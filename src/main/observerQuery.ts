import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * A chamada que todo OBSERVADOR do app faz: um `query()` avulso, sem
 * ferramentas e de um turno só.
 *
 * O vigia e o PO tinham este corpo copiado byte a byte. Em duas cópias,
 * qualquer mudança no contrato do SDK (nome de campo, bloco de conteúdo novo)
 * precisa ser aplicada nas duas — e como os dois degradam em silêncio por
 * design, esquecer uma deixa aquele observador devolvendo string vazia sem
 * aparecer em log nem em teste.
 *
 * `tools: []` é parte do contrato, não economia: se a dúvida pode ser
 * respondida lendo o projeto, não é trabalho de um observador.
 */
export async function askObserver(prompt: string, model: string): Promise<string> {
  async function* single(): AsyncIterable<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      parent_tool_use_id: null
    } as SDKUserMessage
  }

  const options: Options = {
    model,
    executable: 'node',
    tools: [],
    maxTurns: 1,
    includePartialMessages: false,
    permissionMode: 'bypassPermissions'
  }

  const q = query({ prompt: single(), options })
  let text = ''
  for await (const message of q) {
    if (message.type === 'assistant') {
      const content = (message.message as { content?: Array<{ type: string; text?: string }> }).content ?? []
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') text += block.text
      }
    }
  }
  return text.trim()
}
