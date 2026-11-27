import { describe, expect, it } from 'vitest'
import type { InspectorPick } from '@shared/preview'
import { failureText, pickToElement } from './inspector'

const pick: InspectorPick = {
  tagName: 'button',
  selector: '#ok',
  id: 'ok',
  classes: 'btn primary',
  text: 'Salvar',
  html: '<button id="ok">Salvar</button>',
  url: 'https://example.com/form',
  index: 1
}

describe('pickToElement', () => {
  it('vira o chip do composer marcado com a aba do Preview', () => {
    expect(pickToElement(pick, { id: 'pv-1', title: 'example.com' })).toEqual({
      selector: '#ok',
      tagName: 'button',
      id: 'ok',
      classes: 'btn primary',
      text: 'Salvar',
      html: '<button id="ok">Salvar</button>',
      url: 'https://example.com/form',
      tabId: 'pv-1',
      tabName: 'Preview · example.com'
    })
  })
})

describe('failureText', () => {
  it('cada motivo tem título e frase próprios', () => {
    const reasons = ['not-found', 'blocked', 'too-big', 'unsupported', 'error', 'no-api'] as const
    const titles = reasons.map((r) => failureText(r).title)
    expect(new Set(titles).size).toBe(reasons.length)
    for (const r of reasons) expect(failureText(r).text.length).toBeGreaterThan(10)
  })

  it('arquivo não encontrado explica o que houve', () => {
    const f = failureText('not-found', 'ENOENT')
    expect(f.title).toBe('Arquivo não encontrado')
    expect(f.text).toMatch(/^Arquivo não encontrado\. Ele pode ter sido movido ou apagado/)
    expect(f.text).not.toContain('ENOENT')
  })

  it('o detalhe do main só entra no erro genérico', () => {
    expect(failureText('error', 'EBUSY').text).toBe('Não deu para ler o arquivo. Detalhe: EBUSY')
    expect(failureText('error').text).toBe('Não deu para ler o arquivo.')
    expect(failureText('blocked').title).toBe('Arquivo protegido')
  })
})
