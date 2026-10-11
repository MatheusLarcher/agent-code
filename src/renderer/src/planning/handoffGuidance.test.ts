import { describe, expect, it } from 'vitest'
import { HANDOFF_FILES_RULE } from '@shared/handoffGuidance'
import { managerHandoffRequest } from './handoffFlow'

/**
 * O texto de hoje do pedido de handoff ao Agent Manager, gravado ANTES do
 * interruptor "Leitura guiada": com ele desligado, o pedido tem que continuar
 * idêntico a estes arquivos. (O interruptor do ciclo saiu do app em 10/10.)
 */
const DIR = 'D:\\dados\\agent-code\\planning\\app\\checkout'
const CASES = [
  { name: 'sem-ambiguidade-sem-midia', amb: 0, media: 0 },
  { name: 'com-ambiguidades-sem-midia', amb: 2, media: 0 },
  { name: 'sem-ambiguidade-com-midia', amb: 0, media: 3 },
  { name: 'uma-ambiguidade-uma-midia', amb: 1, media: 1 }
] as const
const OFF = { leituraGuiada: false }

describe('managerHandoffRequest — golden (interruptores desligados = texto de hoje)', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      await expect(managerHandoffRequest(DIR, c.amb, c.media)).toMatchFileSnapshot(`./__golden__/handoff-${c.name}.txt`)
      await expect(managerHandoffRequest(DIR, c.amb, c.media, OFF)).toMatchFileSnapshot(`./__golden__/handoff-${c.name}.txt`)
    })
  }
})

describe('managerHandoffRequest — leitura guiada ligada (seção Arquivos)', () => {
  const text = managerHandoffRequest(DIR, 0, 0, { leituraGuiada: true })

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

  it('o resto do pedido é o de hoje; config antiga com o ciclo ligado não acrescenta nada', () => {
    expect(text.replace(`\n\n${HANDOFF_FILES_RULE}`, '')).toBe(managerHandoffRequest(DIR, 0, 0))
    expect(managerHandoffRequest(DIR, 0, 0, { ciclo: true, leituraGuiada: true } as never)).toBe(text)
    expect(text).not.toMatch(/Ciclo obrigatório|7 fases/)
  })
})
