/**
 * Regra ÚNICA da "fonte" de um card do planejamento (obrigatória em
 * 'sugestao'). Usada pelo main (planningModel.validateCard) e pelo renderer
 * (CardEditor/CardNode), para os dois lados nunca discordarem.
 *
 * Fonte válida é uma de duas coisas:
 *  - URL http/https (documentação, artigo, issue);
 *  - referência a um arquivo do PROJETO, para sugestões que saíram da análise
 *    do código: caminho relativo (`src/a.ts`, `./Makefile`), sem '..', sem
 *    caminho absoluto nem letra de unidade, com ':linha' opcional no fim
 *    (`src/a.ts:12`). Sem espaço, e com cara de arquivo — tem pasta ou
 *    extensão —, para uma frase solta ("minha cabeça") não passar por fonte.
 */

export type FonteKind = 'url' | 'arquivo'

export const FONTE_MAX = 4096

export const FONTE_RULE_TEXT =
  'fonte deve ser uma URL http/https ou um arquivo do projeto (caminho relativo, sem "..", com ":linha" opcional — ex.: src/a.ts:12)'

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const LINE_SUFFIX = /:([1-9]\d{0,8})$/
// Sem espaço, controle, ':' (unidade/esquema) nem os proibidos em nome de arquivo.
const PATH_CHARS = /^[^\s:<>"|?*\u0000-\u001f]+$/

/** Caminho relativo de arquivo do projeto, com ':linha' opcional. */
export function isProjectFileRef(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > FONTE_MAX) return false
  const path = value.replace(LINE_SUFFIX, '')
  if (!path || !PATH_CHARS.test(path)) return false
  if (/^[\\/~]/.test(path)) return false // absoluto, UNC ou relativo à home
  const parts = path.split(/[\\/]/)
  if (parts.some((p) => p === '..')) return false
  const name = parts[parts.length - 1]
  if (!name || name === '.') return false // pasta, não arquivo
  const hasFolder = parts.length > 1
  const hasExt = /.\.[^.]+$/.test(name) || /^\.[^.]+$/.test(name)
  return hasFolder || hasExt
}

export function fonteKind(value: unknown): FonteKind | null {
  if (isHttpUrl(value)) return value.length <= FONTE_MAX ? 'url' : null
  return isProjectFileRef(value) ? 'arquivo' : null
}

export function isValidFonte(value: unknown): value is string {
  return fonteKind(value) !== null
}
