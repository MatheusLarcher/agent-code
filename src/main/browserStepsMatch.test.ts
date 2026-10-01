import { describe, expect, it } from 'vitest'
import type { FieldInfo } from './browserFields'
import {
  bestTier,
  buildResult,
  norm,
  pickByLabel,
  pickByText,
  pickOption,
  resultText,
  stepProblem,
  validateSteps
} from './browserStepsMatch'

const fields: FieldInfo[] = [
  { ref: 'e1', type: 'text', label: 'Name (First Name)' },
  { ref: 'e2', type: 'text', label: 'Last Name' },
  { ref: 'e3', type: 'email', label: 'E-mail' },
  { ref: 'e4', type: 'text', label: 'Endereço de cobrança' },
  { ref: 'e5', type: 'text', label: 'Endereço de entrega' },
  {
    ref: 'e6',
    type: 'radio',
    label: 'gender',
    options: [
      { label: 'Male', ref: 'e6' },
      { label: 'Female', ref: 'e7' },
      { label: 'Other', ref: 'e8' }
    ]
  },
  { ref: 'e9', type: 'select-one', label: 'Estado', options: ['Selecione', 'São Paulo'] },
  { ref: 'e10', type: 'submit', label: 'Enviar' },
  { ref: 'e11', type: 'link', label: 'Enviar depois' },
  { ref: 'e12', type: 'text', label: 'Cidade:*' }
]

describe('norm', () => {
  it('ignora maiúsculas e acentos nos dois sentidos, espaços e : * finais', () => {
    expect(norm('São  Paulo')).toBe('sao paulo')
    expect(norm('Sao Paulo')).toBe(norm('são paulo'))
    expect(norm('Cidade:*')).toBe('cidade')
    expect(norm('  E-MAIL : ')).toBe('e-mail')
  })
})

describe('bestTier', () => {
  it('exato vence contém', () => {
    const items = ['Nome', 'Nome da mãe', 'Sobrenome']
    expect(bestTier(items, (s) => [s], 'nome')).toEqual(['Nome'])
    expect(bestTier(items, (s) => [s], 'mae')).toEqual(['Nome da mãe'])
    expect(bestTier(items, (s) => [s], 'nom')).toEqual(['Nome', 'Nome da mãe', 'Sobrenome'])
    expect(bestTier(items, (s) => [s], '')).toEqual([])
  })
})

describe('pickByLabel / pickByText', () => {
  it('acha pelo rótulo exato, pela parte do placeholder e sem acento', () => {
    expect(pickByLabel(fields, 'first name')).toMatchObject({ kind: 'found', hit: { ref: 'e1' } })
    expect(pickByLabel(fields, 'NAME')).toMatchObject({ kind: 'found', hit: { ref: 'e1' } })
    expect(pickByLabel(fields, 'e-mail')).toMatchObject({ kind: 'found', hit: { ref: 'e3' } })
    expect(pickByLabel(fields, 'endereco de entrega')).toMatchObject({ kind: 'found', hit: { ref: 'e5' } })
    expect(pickByLabel(fields, 'cidade')).toMatchObject({ kind: 'found', hit: { ref: 'e12' } })
  })

  it('opção de rádio pelo rótulo da opção', () => {
    const p = pickByLabel(fields, 'female')
    expect(p).toMatchObject({ kind: 'found', hit: { ref: 'e7', option: { label: 'Female' } } })
    expect(pickByLabel(fields, 'gender')).toMatchObject({ kind: 'found', hit: { ref: 'e6', field: { type: 'radio' } } })
  })

  it('ambíguo no melhor tier devolve os candidatos', () => {
    const p = pickByLabel(fields, 'endereço')
    expect(p.kind).toBe('ambiguous')
    if (p.kind !== 'ambiguous') return
    expect(p.candidates).toEqual([
      { ref: 'e4', type: 'text', label: 'Endereço de cobrança' },
      { ref: 'e5', type: 'text', label: 'Endereço de entrega' }
    ])
  })

  it('nenhum candidato', () => {
    expect(pickByLabel(fields, 'Telefone')).toEqual({ kind: 'none' })
  })

  it('label não pega botões; text só pega botões/links (exato antes de contém)', () => {
    expect(pickByLabel(fields, 'Enviar')).toEqual({ kind: 'none' })
    expect(pickByText(fields, 'enviar')).toMatchObject({ kind: 'found', hit: { ref: 'e10' } })
    expect(pickByText(fields, 'depois')).toMatchObject({ kind: 'found', hit: { ref: 'e11' } })
    expect(pickByText(fields, 'Estado')).toEqual({ kind: 'none' })
  })
})

describe('pickOption', () => {
  const opts = [
    { label: 'Selecione', value: '' },
    { label: 'São Paulo', value: 'SP' },
    { label: 'Rio de Janeiro', value: 'RJ' },
    { label: 'Rio Grande do Sul', value: 'RS' }
  ]
  it('rótulo sem acento, valor exato e contém único', () => {
    expect(pickOption(opts, 'sao paulo')).toEqual({ kind: 'found', index: 1 })
    expect(pickOption(opts, 'rj')).toEqual({ kind: 'found', index: 2 })
    expect(pickOption(opts, 'janeiro')).toEqual({ kind: 'found', index: 2 })
  })
  it('ambíguo e inexistente', () => {
    expect(pickOption(opts, 'rio')).toEqual({ kind: 'ambiguous', indices: [2, 3] })
    expect(pickOption(opts, 'Bahia')).toEqual({ kind: 'none' })
  })
})

describe('stepProblem / validateSteps', () => {
  it('aceita passos bem formados', () => {
    expect(stepProblem({ action: 'fill', target: { label: 'Nome' }, value: '' })).toBeNull()
    expect(stepProblem({ action: 'select', target: { ref: 'e3' }, value: ['a', 'b'] })).toBeNull()
    expect(stepProblem({ action: 'wait_for', value: 'Obrigado' })).toBeNull()
    expect(stepProblem({ action: 'press', value: 'Enter' })).toBeNull()
    expect(stepProblem({ action: 'navigate', value: 'example.com' })).toBeNull()
  })
  it('recusa o que não faz sentido', () => {
    expect(stepProblem({ action: 'hover', target: { label: 'x' } })).toMatch(/unknown action/)
    expect(stepProblem({ action: 'fill', target: { label: 'Nome' } })).toMatch(/fill needs value/)
    expect(stepProblem({ action: 'click' })).toMatch(/click needs target/)
    expect(stepProblem({ action: 'click', target: {} })).toMatch(/target needs/)
    expect(stepProblem({ action: 'click', target: { ref: '#btn' } })).toMatch(/target.ref/)
    expect(stepProblem({ action: 'press', value: ['Enter'] })).toMatch(/must be a string/)
    expect(stepProblem({ action: 'wait_for' })).toMatch(/wait_for needs/)
    expect(stepProblem({ action: 'select', target: { label: 'x' }, value: '' })).toMatch(/select needs value/)
    expect(stepProblem({ action: 'click', target: { text: 'Ok' }, timeoutMs: 50 })).toMatch(/timeoutMs/)
  })
  it('valida a lista e o expect', () => {
    expect(validateSteps([])).toMatch(/1\.\.500/)
    expect(validateSteps(new Array(501).fill({ action: 'press', value: 'Tab' }))).toMatch(/1\.\.500/)
    expect(validateSteps([{ action: 'press', value: 'Tab' }], 'x'.repeat(501))).toMatch(/expect/)
    expect(validateSteps([{ action: 'press', value: 'Tab' }, { action: 'click' }])).toMatch(/^steps\[1\]/)
    expect(validateSteps([{ action: 'press', value: 'Tab' }], 'ok')).toBeNull()
  })
})

describe('buildResult / resultText', () => {
  const base = { done: 3, total: 3, url: 'http://x/', state: 'e1 text "Nome"\nurl: http://x/ | title: X' }
  it('ok só com todos os passos, sem inválidos e com o expect visto', () => {
    expect(buildResult({ ...base, outcome: 'expect' }, 'Obrigado').ok).toBe(true)
    expect(buildResult({ ...base, outcome: 'timeout' }).ok).toBe(true)
    expect(buildResult({ ...base, outcome: 'timeout' }, 'Obrigado').ok).toBe(false)
    expect(buildResult({ ...base, outcome: 'navigated' }, 'Obrigado').ok).toBe(false)
    expect(buildResult({ ...base, outcome: 'invalid', invalid: ['e1 "Nome"'] }).ok).toBe(false)
    const failed = buildResult({
      ...base,
      done: 1,
      outcome: 'timeout',
      failedStep: { i: 1, action: 'fill', target: { label: 'Telefone' }, error: 'alvo não encontrado' }
    })
    expect(failed.ok).toBe(false)
    expect(failed.failedStep?.i).toBe(1)
  })
  it('texto: JSON compacto sem state, linha em branco, state', () => {
    const r = buildResult({ ...base, outcome: 'expect', message: 'Obrigado pelo envio', invalid: [] }, 'Obrigado')
    const [json, state] = resultText(r).split('\n\n')
    expect(JSON.parse(json)).toEqual({
      ok: true,
      done: 3,
      total: 3,
      outcome: 'expect',
      message: 'Obrigado pelo envio',
      url: 'http://x/'
    })
    expect(state).toBe(base.state)
  })
})
