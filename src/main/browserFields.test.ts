import { describe, expect, it } from 'vitest'
import { formatField, formatFields, formatState } from './browserFields'

describe('formatField', () => {
  it('uma linha por controle: ref tipo[*] "rótulo" [opções] = "valor"', () => {
    expect(formatField({ ref: 'e1', type: 'text', label: 'Name (First Name)', required: true, value: 'Ana' })).toBe(
      'e1 text* "Name (First Name)" = "Ana"'
    )
    expect(formatField({ ref: 'e2', type: 'select-one', label: 'Estado', options: ['Selecione', 'SP'], value: 'SP' })).toBe(
      'e2 select-one "Estado" [Selecione | SP] = "SP"'
    )
    expect(formatField({ ref: 'e3', type: 'checkbox', label: 'Aceito', value: 'off' })).toBe('e3 checkbox "Aceito" = off')
    expect(formatField({ ref: 'e9', type: 'submit', label: 'Enviar' })).toBe('e9 submit "Enviar"')
  })

  it('grupo de rádio: uma linha, cada opção com o próprio ref', () => {
    const line = formatField({
      ref: 'e4',
      type: 'radio',
      label: 'gender',
      options: [
        { label: 'Male', ref: 'e4' },
        { label: 'Female', ref: 'e5' },
        { label: 'Other', ref: 'e6' }
      ],
      value: 'Female'
    })
    expect(line).toBe('e4 radio "gender" [Male=e4 | Female=e5 | Other=e6] = "Female"')
  })

  it('combobox: valor simples e múltiplo (chips)', () => {
    expect(formatField({ ref: 'e8', type: 'combobox', label: 'State', value: 'NCR' })).toBe('e8 combobox "State" = "NCR"')
    expect(formatField({ ref: 'e9', type: 'combobox', label: 'Subjects', values: ['Maths', 'English'] })).toBe(
      'e9 combobox "Subjects" = ["Maths","English"]'
    )
  })

  it('password sai mascarado (o valor real nem chega aqui)', () => {
    expect(formatField({ ref: 'e7', type: 'password', label: 'Senha', value: '••••' })).toBe('e7 password "Senha" = "••••"')
  })
})

describe('formatFields / formatState', () => {
  it('linha final com url e título; alertas só no state', () => {
    const snap = {
      url: 'http://x/form',
      title: 'Cadastro',
      fields: [{ ref: 'e1', type: 'email', label: 'E-mail' }],
      alerts: ['Preencha o e-mail']
    }
    expect(formatFields(snap)).toBe('e1 email "E-mail"\nurl: http://x/form | title: Cadastro')
    expect(formatState(snap)).toBe('e1 email "E-mail"\nurl: http://x/form | title: Cadastro\nalerta: Preencha o e-mail')
  })
  it('página sem controles avisa', () => {
    expect(formatFields({ url: 'about:blank', title: '', fields: [] })).toBe(
      '(nenhum controle visível)\nurl: about:blank | title: '
    )
  })
})
