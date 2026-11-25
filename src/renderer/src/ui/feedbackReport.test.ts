import { describe, expect, it } from 'vitest'
import { feedbackBody, feedbackIssueUrl, feedbackPlainText, feedbackTitle, ISSUES_URL, MAX_URL_BODY } from './feedbackReport'

const diag = { versao: '0.1.192', sistema: 'Windows 10.0.26200 (x64)', memoriaGb: 32, gpu: 'normal', eventosTela: ['{"event":"process-gone","type":"GPU"}'] }

describe('relato de problema / sugestão', () => {
  it('título com o tipo; sem resumo usa a 1ª linha da descrição', () => {
    expect(feedbackTitle({ tipo: 'problema', titulo: ' App não abre ', descricao: '' })).toBe('[Problema] App não abre')
    expect(feedbackTitle({ tipo: 'sugestao', titulo: '', descricao: 'Fixar conversas\nmais detalhes' })).toBe('[Sugestão] Fixar conversas')
  })

  it('corpo leva as informações técnicas só quando pedidas', () => {
    const com = feedbackBody({ tipo: 'problema', titulo: '', descricao: 'Fechou', diagnostico: diag })
    expect(com).toContain('Versão do Agent Code: 0.1.192')
    expect(com).toContain('process-gone')
    expect(feedbackBody({ tipo: 'problema', titulo: '', descricao: 'Fechou', diagnostico: null })).not.toContain('Informações técnicas')
  })

  it('link aponta para issue nova com rótulo pelo tipo', () => {
    const { url, cortado } = feedbackIssueUrl({ tipo: 'sugestao', titulo: 'x', descricao: 'y' })
    expect(url.startsWith(`${ISSUES_URL}?`)).toBe(true)
    const p = new URL(url).searchParams
    expect(p.get('labels')).toBe('enhancement')
    expect(p.get('title')).toBe('[Sugestão] x')
    expect(cortado).toBe(false)
  })

  it('texto enorme é cortado no link, mas o texto para copiar fica inteiro', () => {
    const descricao = 'a'.repeat(MAX_URL_BODY + 500)
    const { url, cortado } = feedbackIssueUrl({ tipo: 'problema', titulo: '', descricao })
    expect(cortado).toBe(true)
    expect(new URL(url).searchParams.get('body')!.length).toBeLessThan(MAX_URL_BODY + 200)
    expect(feedbackPlainText({ tipo: 'problema', titulo: '', descricao })).toContain(descricao)
  })
})
