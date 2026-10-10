import { describe, expect, it } from 'vitest'
import { HANDOFF_CYCLE_RULE, HANDOFF_FILES_RULE } from '@shared/handoffGuidance'
import { managerHandoffRequest } from './handoffFlow'

/**
 * O texto de hoje do pedido de handoff ao Agent Manager, gravado ANTES dos
 * interruptores "Ciclo completo nos handoffs" e "Leitura guiada": com os dois
 * desligados, o pedido tem que continuar idêntico a estes arquivos.
 */
const DIR = 'D:\\dados\\agent-code\\planning\\app\\checkout'
const CASES = [
  { name: 'sem-ambiguidade-sem-midia', amb: 0, media: 0 },
  { name: 'com-ambiguidades-sem-midia', amb: 2, media: 0 },
  { name: 'sem-ambiguidade-com-midia', amb: 0, media: 3 },
  { name: 'uma-ambiguidade-uma-midia', amb: 1, media: 1 }
] as const
const OFF = { ciclo: false, leituraGuiada: false }

describe('managerHandoffRequest — golden (interruptores desligados = texto de hoje)', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      await expect(managerHandoffRequest(DIR, c.amb, c.media)).toMatchFileSnapshot(`./__golden__/handoff-${c.name}.txt`)
      await expect(managerHandoffRequest(DIR, c.amb, c.media, OFF)).toMatchFileSnapshot(`./__golden__/handoff-${c.name}.txt`)
    })
  }
})

describe('managerHandoffRequest — ciclo completo ligado', () => {
  const text = managerHandoffRequest(DIR, 0, 0, { ciclo: true, leituraGuiada: false })

  it('exige as 7 fases por etapa, na ordem', () => {
    expect(text).toContain(HANDOFF_CYCLE_RULE)
    const phases = ['plan', 'test', 'implement', 'review', 'verify', 'remember', 'improve'].map((p) => text.indexOf(`${p} —`))
    expect(phases.every((i) => i > 0)).toBe(true)
    expect([...phases].sort((a, b) => a - b)).toEqual(phases)
    expect(text).toMatch(/CADA etapa/)
  })

  it('cita a skill de cada fase', () => {
    for (const skill of [
      'executing-plans',
      'subagent-driven-development',
      'test-driven-development',
      'tdd-workflow',
      'code-review',
      'requesting-code-review',
      'verification-before-completion',
      'verification-loop',
      'memory_propose',
      'agent-self-evaluation'
    ]) {
      expect(text, skill).toContain(skill)
    }
  })

  it('exige o mapa RED/GREEN, a declaração do teste pulado e as "Melhorias sugeridas" (só sugestão)', () => {
    expect(text).toMatch(/etapa → teste → prova RED → prova GREEN/)
    expect(text).toMatch(/teste pulado[^.]*"bug que já existia"[^.]*com o motivo/)
    expect(text).toMatch(/"Melhorias sugeridas"/)
    expect(text).toMatch(/só sugerir/)
    expect(text).toMatch(/precisão, completude, clareza, ação e concisão/)
  })

  it('Quadro: um item por etapa, fase no activeForm; e a regra proporcional da etapa trivial', () => {
    expect(text).toMatch(/um item por etapa/)
    expect(text).toMatch(/activeForm/)
    expect(text).toMatch(/nunca um item por fase/)
    expect(text).toMatch(/etapa trivial[^.]*pode juntar test e verify, dizendo por quê/)
  })

  it('o resto do pedido continua igual: só acrescenta o ciclo', () => {
    const base = managerHandoffRequest(DIR, 0, 0)
    expect(text.replace(`\n\n${HANDOFF_CYCLE_RULE}`, '')).toBe(base)
    expect(text).not.toContain(HANDOFF_FILES_RULE)
  })
})

describe('managerHandoffRequest — leitura guiada ligada (seção Arquivos)', () => {
  const text = managerHandoffRequest(DIR, 0, 0, { ciclo: false, leituraGuiada: true })

  it('exige a seção "Arquivos" no TOPO de cada prompt, com as duas listas', () => {
    expect(text).toContain(HANDOFF_FILES_RULE)
    expect(HANDOFF_FILES_RULE).toMatch(/no TOPO de cada prompt/)
    expect(HANDOFF_FILES_RULE).toMatch(/"Ler antes de começar"[^;]*caminho relativo à raiz[^;]*:linha[^;]*o que tem ali/)
    expect(HANDOFF_FILES_RULE).toMatch(/"Editar\/criar"[^.]*o que muda em cada um/)
  })

  it('só arquivos conferidos no código durante o planejamento, e só os das etapas do prompt', () => {
    expect(HANDOFF_FILES_RULE).toMatch(/conferiu no código durante o planejamento \(Read\/Grep\), nunca palpite/)
    expect(HANDOFF_FILES_RULE).toMatch(/só os arquivos das etapas dele/)
  })

  it('manda a implementação ler a lista inteira numa resposta, em paralelo, sem reexplorar', () => {
    expect(HANDOFF_FILES_RULE).toContain(
      '"Abra TODOS os arquivos de \'Ler antes de começar\' numa única resposta, com as leituras em paralelo. ' +
        'Não reexplore o que a lista cobre; use Grep/Glob só para o que faltar. As linhas são pista: o código pode ter mudado desde o planejamento."'
    )
    expect(HANDOFF_FILES_RULE).toMatch(/pasta do plano continua, como consulta pontual/)
  })

  it('sem ciclo: o resto do pedido é o de hoje; com os dois, a seção Arquivos vem antes do ciclo', () => {
    expect(text.replace(`\n\n${HANDOFF_FILES_RULE}`, '')).toBe(managerHandoffRequest(DIR, 0, 0))
    const both = managerHandoffRequest(DIR, 0, 0, { ciclo: true, leituraGuiada: true })
    expect(both.indexOf(HANDOFF_FILES_RULE)).toBeGreaterThan(0)
    expect(both.indexOf(HANDOFF_FILES_RULE)).toBeLessThan(both.indexOf(HANDOFF_CYCLE_RULE))
  })
})
