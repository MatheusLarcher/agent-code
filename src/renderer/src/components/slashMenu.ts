/**
 * As sugestões do menu "/" da caixa de texto: comandos do próprio CLI + skills.
 *
 * Sem os comandos do CLI na lista, "/compact" + Enter escolhia a primeira skill
 * cuja DESCRIÇÃO citava "compact" (a hook-development fala de PreCompact) e o
 * texto virava "/hook-development" — que o agente respondia como comando
 * inexistente. Nome igual ao digitado vem sempre primeiro.
 */

export interface SlashEntry {
  name: string
  description: string
}

/** Comandos do CLI que o app manda crus (ver `isCompactCommand` no main). */
export const BUILTIN_SLASH_COMMANDS: readonly SlashEntry[] = [
  { name: 'compact', description: 'Compacta a conversa: resume o histórico para liberar contexto (aceita instruções depois)' }
]

/** lowercase + sem acento (regra do filtro de projetos). */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/**
 * Comandos e skills que casam com o que foi digitado depois da "/", no nome ou
 * na descrição. Ordem: nome igual, nome que começa com o texto, o resto; empate
 * em ordem alfabética. Skill com o nome de um comando do CLI fica de fora: o CLI
 * resolve o comando, não a skill.
 */
export function matchSlashEntries(skills: readonly SlashEntry[], query: string): SlashEntry[] {
  const q = foldText(query.trim())
  const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name))
  const all = [...BUILTIN_SLASH_COMMANDS, ...skills.filter((s) => !builtinNames.has(s.name))]
  const rank = (s: SlashEntry): number => {
    if (!q) return 2
    const name = foldText(s.name)
    return name === q ? 0 : name.startsWith(q) ? 1 : 2
  }
  return all
    .filter((s) => !q || foldText(s.name).includes(q) || foldText(s.description).includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** Enter com o nome já digitado por inteiro envia, em vez de só repetir o nome no campo. */
export function enterSendsTyped(highlighted: string | undefined, query: string): boolean {
  return highlighted !== undefined && highlighted === query.trim()
}
