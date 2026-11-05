import { describe, expect, it } from 'vitest'
import { PO_MAX_TITLE_CHARS } from './poPrompt'
import { fitTitle, splitSummary } from './poSummary'
import { parsePoVerdict } from './poVerdict'

describe('RESUMO do cartão', () => {
  it('separa o RESUMO antes do VOCÊ, sem engolir a ação', () => {
    const out = splitSummary('NOVA | Gerar o setup | motivo | RESUMO: apaga a pasta vazia | VOCÊ: Autorizar | BOTÃO')
    expect(out.summary).toBe('apaga a pasta vazia')
    expect(out.body).toBe('NOVA | Gerar o setup | motivo | VOCÊ: Autorizar | BOTÃO')
  })

  it('título longo é cortado em palavra inteira e o texto inteiro vira o resumo', () => {
    const long = 'Gerar o instalador do agent-code removendo a pasta vazia master-agreement-generator.agent-code-new das skills'
    const fit = fitTitle(long)
    expect(fit.title.length).toBeLessThanOrEqual(PO_MAX_TITLE_CHARS)
    expect(fit.title.endsWith('…')).toBe(true)
    expect(fit.summary).toBe(long)
  })

  it('NOVA e TITULO levam o resumo na operação', () => {
    const ops = parsePoVerdict(
      'NOVA | Gerar o setup | falta | RESUMO: apagar a pasta vazia e gerar o setup | VOCÊ: Autorizar | BOTÃO\nTITULO c1 | Título curto | era técnico | RESUMO: o que é',
      ['c1']
    )
    const create = ops.find((op) => op.kind === 'create')
    expect(create && create.kind === 'create' && create.summary).toBe('apagar a pasta vazia e gerar o setup')
    expect(create && create.kind === 'create' && create.userAction).toBe('Autorizar')
    const retitle = ops.find((op) => op.kind === 'retitle')
    expect(retitle && retitle.kind === 'retitle' && retitle.summary).toBe('o que é')
  })
})
