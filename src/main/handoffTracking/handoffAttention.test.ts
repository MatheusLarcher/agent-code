// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { attentionLines } from './handoffAttention'

describe('attentionLines — ATENÇÃO / DESVIO DO PLANO só no início da linha', () => {
  it('dispara no início da linha (inclusive depois de marcador de lista/negrito)', () => {
    const text = [
      'Comecei a etapa.',
      'ATENÇÃO: outra conversa mexeu em src/a.ts; vou editar só o trecho meu.',
      '- DESVIO DO PLANO: o símbolo sumiu, usei o equivalente novo.',
      '**ATENÇÃO:** a linha 120 não bate.'
    ].join('\n')
    expect(attentionLines(text)).toEqual([
      'ATENÇÃO: outra conversa mexeu em src/a.ts; vou editar só o trecho meu.',
      'DESVIO DO PLANO: o símbolo sumiu, usei o equivalente novo.',
      'ATENÇÃO: a linha 120 não bate.'
    ])
  })

  it('não dispara no meio do texto (citação) nem com o prefixo vazio', () => {
    expect(attentionLines('ele disse ATENÇÃO: x e seguiu')).toEqual([])
    expect(attentionLines('O card fala de "DESVIO DO PLANO: y".')).toEqual([])
    expect(attentionLines('ATENÇÃO:')).toEqual([])
    expect(attentionLines('atenção: minúscula não é o marcador')).toEqual([])
  })
})
