/**
 * A terceira conferência do `plan_handoff_write`: cada etapa do prompt traz
 * "Aceite:" e "Verificar com:" na seção dela. Sem critério, o implementador
 * recorre à pergunta; com ele, decide e prova sozinho. "Decidido:" é
 * recomendado, não obrigatório.
 *
 * Por texto, sem parser de markdown: a seção de uma etapa começa no título
 * (`#…`) que cita o id entre colchetes `[id]` ou parênteses `(id)` / `(\`id\`)`
 * — sem título com o id, na primeira linha que o cita — e vai até o próximo
 * título de nível igual ou maior, ou até a linha que abre outra etapa.
 */

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

function markerOf(id: string): RegExp {
  const e = escape(id)
  return new RegExp(`\\[${e}\\]|\\(\`?${e}\`?\\)`, 'u')
}

const HEADING = /^(#{1,6})\s/u

interface Start {
  id: string
  line: number
  /** Nível do título (1-6); 0 quando a seção começa numa linha comum. */
  level: number
}

function sectionStart(lines: readonly string[], id: string): Start | null {
  const marker = markerOf(id)
  let plain: Start | null = null
  for (let i = 0; i < lines.length; i++) {
    if (!marker.test(lines[i])) continue
    const heading = HEADING.exec(lines[i])
    if (heading) return { id, line: i, level: heading[1].length }
    plain ??= { id, line: i, level: 0 }
  }
  return plain
}

/** O texto da seção de cada etapa (null: a etapa não aparece no texto). */
export function handoffEtapaSections(conteudo: string, etapas: readonly string[]): Map<string, string | null> {
  const lines = conteudo.replace(/\r/gu, '').split('\n')
  const starts = etapas.map((id) => sectionStart(lines, id))
  const out = new Map<string, string | null>()
  etapas.forEach((id, k) => {
    const start = starts[k]
    if (!start) {
      out.set(id, null)
      return
    }
    const others = new Set(starts.filter((s): s is Start => s !== null && s.id !== id && s.line > start.line).map((s) => s.line))
    let end = lines.length
    for (let i = start.line + 1; i < lines.length; i++) {
      if (others.has(i)) {
        end = i
        break
      }
      const heading = HEADING.exec(lines[i])
      if (heading && (start.level === 0 || heading[1].length <= start.level)) {
        end = i
        break
      }
    }
    out.set(id, lines.slice(start.line, end).join('\n'))
  })
  return out
}

const has = (section: string, label: RegExp): boolean => label.test(section.replace(/[*_]/gu, ''))
const ACEITE = /(^|[^\p{L}])Aceite\s*:/iu
const VERIFICAR = /(^|[^\p{L}])Verificar com\s*:/iu

/**
 * O que falta, ou `null`. Lista TODAS as faltas de uma vez: "a etapa X está
 * sem 'Aceite:'; a etapa Y está sem 'Verificar com:'.", e como corrigir.
 */
export function handoffAceiteProblem(conteudo: string, etapas: readonly string[]): string | null {
  const faltas: string[] = []
  for (const [id, section] of handoffEtapaSections(conteudo, etapas)) {
    if (section === null) {
      faltas.push(`a etapa ${id} não tem seção no texto (cite o id como [${id}] no título dela)`)
      continue
    }
    if (!has(section, ACEITE)) faltas.push(`a etapa ${id} está sem 'Aceite:'`)
    if (!has(section, VERIFICAR)) faltas.push(`a etapa ${id} está sem 'Verificar com:'`)
  }
  if (faltas.length === 0) return null
  return (
    `${faltas.join('; ')}.` +
    "\nEm cada etapa do prompt, ponha 'Aceite:' (o que prova que ela está pronta) e 'Verificar com:' (o comando ou teste que prova), e de preferência 'Decidido:' (as respostas às dúvidas prováveis); depois grave de novo."
  )
}
