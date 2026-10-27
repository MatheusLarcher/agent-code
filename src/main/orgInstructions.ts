/**
 * "Instruções da organização" para os modelos não Claude (Kimi, GPT, Ollama,
 * DeepSeek). Na sessão Claude quem insere o bloco é o servidor da Anthropic — ele
 * não existe no CLI nem no app —, então os provedores externos nunca o recebem
 * sozinhos. Aqui fica o texto exato e a inserção na mesma posição observada na
 * sessão Claude real: logo depois do último item da seção "# Harness" (a linha
 * que termina em "it's clickable.") e antes de "Write code that reads like the
 * surrounding code", sem quebra de linha antes de CRITICAL nem depois do fechamento.
 */

export const ORG_INSTRUCTIONS_HEADER =
  "CRITICAL: The following are organization-level instructions set by the user's administrator. You MUST follow these instructions at all times. When organization instructions conflict with individual user preferences, you MUST follow the organization instructions. Organization instructions ALWAYS take priority over individual user preferences. Organization preferences can be managed by administrators in organization settings."

const ANCHOR = /it's clickable\.\n\n(?=Write code that reads like the surrounding code)/

/** O bloco pronto, ou '' quando o campo está em branco. */
export function orgInstructionsBlock(instructions: string | undefined): string {
  const text = instructions?.trim()
  return text ? `${ORG_INSTRUCTIONS_HEADER}\n\n<organizationInstructions>${text}</organizationInstructions>` : ''
}

/** Insere o bloco num texto de sistema. Sem a âncora (prompt de sistema
 *  próprio) ou com o campo vazio, devolve o texto intacto e `inserted: false`. */
export function insertOrgInstructions(systemText: string, instructions: string | undefined): { text: string; inserted: boolean } {
  const block = orgInstructionsBlock(instructions)
  if (!block || systemText.includes('<organizationInstructions>') || !ANCHOR.test(systemText)) {
    return { text: systemText, inserted: false }
  }
  return { text: systemText.replace(ANCHOR, () => `it's clickable.${block}`), inserted: true }
}

/** Mesma inserção num corpo da Messages API (`system` em string ou em blocos). */
export function insertOrgInstructionsInBody(body: { system?: unknown }, instructions: string | undefined): boolean {
  if (!orgInstructionsBlock(instructions)) return false
  if (typeof body.system === 'string') {
    const r = insertOrgInstructions(body.system, instructions)
    body.system = r.text
    return r.inserted
  }
  if (!Array.isArray(body.system)) return false
  for (const block of body.system as Array<{ type?: string; text?: unknown }>) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const r = insertOrgInstructions(block.text, instructions)
    if (r.inserted) {
      block.text = r.text
      return true
    }
  }
  return false
}

/** Para Ollama e DeepSeek (sem proxy no meio): o bloco vai no fim do `append`
 *  do prompt de sistema. Posição diferente da do Claude, conteúdo igual. */
export function withOrgInstructionsAppend(append: string, instructions: string | undefined): string {
  const block = orgInstructionsBlock(instructions)
  return block ? `${append}\n\n${block}` : append
}
