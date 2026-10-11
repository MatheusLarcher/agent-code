// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { handoffAceiteProblem, handoffEtapaSections } from './handoffAceite'

/** Os prompts reais citados no plano (só nesta máquina: sem eles, o caso é pulado). */
const PLANS = 'D:\\OneDrive\\Documentos\\agent-code\\planning\\agent-code'
const NEGATIVO = `${PLANS}\\plano-20261009-1448\\_handoff\\2026-10-09-01.md`
const POSITIVO = `${PLANS}\\plano-20261010-0616\\_handoff\\2026-10-10-01.md`
const etapasDe = (md: string): string[] => (JSON.parse(readFileSync(md.replace(/\.md$/u, '.meta.json'), 'utf8')) as { etapas: string[] }).etapas

describe('handoffAceiteProblem', () => {
  it('seção por título com [id]: Aceite e Verificar com presentes → null (inclusive em negrito)', () => {
    const md = '# P\n\n### 1. [a] Etapa A\n\n**Aceite:** x\n**Verificar com:** `npm test`\n\n### 2. [b] Etapa B\n\nAceite: y\nVerificar com: z\n'
    expect(handoffAceiteProblem(md, ['a', 'b'])).toBeNull()
  })

  it('o "Aceite:" de outra etapa não vale para esta', () => {
    const md = '### [a] A\n\nAceite: x\nVerificar com: y\n\n### [b] B\n\nsó texto\n\n## Riscos\n\nAceite: solto\nVerificar com: solto\n'
    const out = handoffAceiteProblem(md, ['a', 'b'])
    expect(out).toContain("a etapa b está sem 'Aceite:'; a etapa b está sem 'Verificar com:'.")
    expect(out).not.toContain('etapa a ')
  })

  it('id entre parênteses `(\\`id\\`)` numa linha comum (o rascunho) também abre a seção', () => {
    const md = '1. **A** (`a`) — pendente\n   - Aceite: x\n   - Verificar com: y\n2. **B** (`b`) — pendente\n   - nada\n'
    const sections = handoffEtapaSections(md, ['a', 'b'])
    expect(sections.get('a')).toContain('Aceite: x')
    expect(sections.get('b')).not.toContain('Aceite')
    expect(handoffAceiteProblem(md, ['a', 'b'])).toMatch(/^a etapa b está sem 'Aceite:'; a etapa b está sem 'Verificar com:'\./)
  })

  it('etapa que não aparece no texto: falta apontada', () => {
    expect(handoffAceiteProblem('# nada\n', ['x'])).toMatch(/^a etapa x não tem seção no texto/)
  })

  it.skipIf(!existsSync(NEGATIVO))('caso negativo real: o prompt de 09/10 (sem as seções) é recusado', () => {
    const out = handoffAceiteProblem(readFileSync(NEGATIVO, 'utf8'), etapasDe(NEGATIVO))
    expect(out).toContain("a etapa medir está sem 'Aceite:'")
    expect(out).toContain("a etapa validar está sem 'Verificar com:'")
  })

  it.skipIf(!existsSync(POSITIVO))('caso positivo real: o prompt 1/3 deste plano passa', () => {
    expect(handoffAceiteProblem(readFileSync(POSITIVO, 'utf8'), etapasDe(POSITIVO))).toBeNull()
  })
})
