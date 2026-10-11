import { readFileSync } from 'node:fs'
import path from 'node:path'
import { planDirPath } from './planningRoot'

/**
 * A autonomia da conversa de handoff, decidida no planejamento e gravada no
 * card `decisao-autonomia-handoff` do plano:
 *
 *   Perguntas: nenhuma | só o que listar | como hoje
 *   Permissões: permitir tudo, exceto destrutivo | pedir como hoje
 *
 * Card ausente ou ilegível = o padrão autônomo (o usuário quer ser questionado
 * no planejamento, não na execução). Lida UMA vez, na subida da sessão.
 */

export const HANDOFF_AUTONOMY_CARD = 'decisao-autonomia-handoff'

export type HandoffQuestionPolicy = 'nenhuma' | 'como_hoje' | { lista: string[] }
export type HandoffPermissionPolicy = 'tudo_exceto_destrutivo' | 'como_hoje'

export interface HandoffAutonomy {
  perguntas: HandoffQuestionPolicy
  permissoes: HandoffPermissionPolicy
}

export const DEFAULT_HANDOFF_AUTONOMY: HandoffAutonomy = { perguntas: 'nenhuma', permissoes: 'tudo_exceto_destrutivo' }

/** Minúsculas, sem acento: "Só o que listar" e "so o que listar" são a mesma coisa. */
const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/gu, '').toLowerCase().trim()

/** Lê o texto do card. Tolerante: linha ausente ou valor desconhecido cai no padrão daquele campo. */
export function parseHandoffAutonomy(text: string): HandoffAutonomy {
  const lines = text.replace(/\r/gu, '').split('\n')
  let perguntas: HandoffQuestionPolicy = DEFAULT_HANDOFF_AUTONOMY.perguntas
  let permissoes: HandoffPermissionPolicy = DEFAULT_HANDOFF_AUTONOMY.permissoes
  for (let i = 0; i < lines.length; i++) {
    const line = fold(lines[i]).replace(/^[-*\s]*/u, '').replace(/\*\*/gu, '')
    const q = /^perguntas\s*:\s*(.*)$/u.exec(line)
    if (q) {
      const value = q[1]
      if (value.startsWith('como hoje')) perguntas = 'como_hoje'
      else if (value.startsWith('nenhuma')) perguntas = 'nenhuma'
      else if (value.includes('listar')) {
        const lista: string[] = []
        for (let j = i + 1; j < lines.length; j++) {
          const item = /^\s*[-*]\s+(.+)$/u.exec(lines[j])
          if (!item) {
            if (lines[j].trim() === '' && lista.length === 0) continue
            break
          }
          lista.push(item[1].trim())
        }
        perguntas = lista.length ? { lista } : 'nenhuma'
      }
      continue
    }
    const p = /^permiss(?:oes|ao)\s*:\s*(.*)$/u.exec(line)
    if (p) {
      if (p[1].includes('como hoje') || p[1].startsWith('pedir')) permissoes = 'como_hoje'
      else if (p[1].includes('permitir tudo')) permissoes = 'tudo_exceto_destrutivo'
    }
  }
  return { perguntas, permissoes }
}

/** A política do plano `slug`. Nunca lança: qualquer falha = padrão autônomo. */
export function readHandoffAutonomy(cwd: string, slug: string): HandoffAutonomy {
  try {
    const file = path.join(planDirPath(cwd, slug), 'cards', `${HANDOFF_AUTONOMY_CARD}.md`)
    return parseHandoffAutonomy(readFileSync(file, 'utf8'))
  } catch {
    return { ...DEFAULT_HANDOFF_AUTONOMY }
  }
}

export function isDefaultHandoffAutonomy(a: HandoffAutonomy): boolean {
  return a.perguntas === 'nenhuma' && a.permissoes === 'tudo_exceto_destrutivo'
}

/** O texto da política para o bloco do handoff, quando ela não é a padrão. */
export function describeHandoffAutonomy(a: HandoffAutonomy): string {
  const perguntas =
    a.perguntas === 'nenhuma'
      ? 'nenhuma'
      : a.perguntas === 'como_hoje'
        ? 'como hoje (pergunte ao usuário quando precisar)'
        : `só o que listar:\n${a.perguntas.lista.map((item) => `  - ${item}`).join('\n')}`
  const permissoes = a.permissoes === 'tudo_exceto_destrutivo' ? 'permitir tudo, exceto destrutivo' : 'pedir como hoje'
  return `Autonomia deste plano (card ${HANDOFF_AUTONOMY_CARD}):\nPerguntas: ${perguntas}\nPermissões: ${permissoes}`
}
