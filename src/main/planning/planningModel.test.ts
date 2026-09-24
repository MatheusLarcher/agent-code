import { describe, expect, it } from 'vitest'
import { MAX_ANEXOS_POR_CARD } from '../../shared/planningMedia'
import {
  extractLinks,
  isValidName,
  parseCard,
  parseRoteiro,
  serializeCard,
  serializeRoteiro,
  validateCard,
  type PlanCard
} from './planningModel'

const base: PlanCard = {
  id: 'req-login',
  tipo: 'requisito',
  titulo: 'Login com "e-mail": obrigatório',
  etapa: 'etapa-1',
  links: ['dec-auth'],
  rev: 3,
  corpo: '# Login\n\nVer [[dec-auth]] e [[nota-1]].\n\n---\nfim\n'
}

describe('nomes', () => {
  it('aceita [a-z0-9-] de 1 a 64 e recusa o resto', () => {
    expect(isValidName('a')).toBe(true)
    expect(isValidName('x'.repeat(64))).toBe(true)
    for (const bad of ['', 'x'.repeat(65), 'A', '..', 'a/b', 'a\\b', 'a.md', 'a b', 'ç']) {
      expect(isValidName(bad)).toBe(false)
    }
  })
})

describe('cards', () => {
  it('round-trip serializar→ler sem perda', () => {
    const text = serializeCard(base)
    expect(parseCard(text)).toEqual(base)
    expect(serializeCard(parseCard(text))).toBe(text)
  })

  it('aceita frontmatter escrito à mão e CRLF', () => {
    const text = '---\r\nid: n1\r\ntipo: nota\r\ntitulo: Nota solta\r\nlinks: [a, b]\r\nrev: 2\r\n---\r\ncorpo'
    expect(parseCard(text)).toEqual({ id: 'n1', tipo: 'nota', titulo: 'Nota solta', links: ['a', 'b'], rev: 2, corpo: 'corpo' })
  })

  it('recusa sugestão sem fonte http/https', () => {
    const sug: PlanCard = { id: 's1', tipo: 'sugestao', titulo: 'Usar X', links: [], rev: 0, corpo: '' }
    expect(() => validateCard(sug)).toThrow(/fonte/)
    expect(() => validateCard({ ...sug, fonte: 'ftp://x' })).toThrow(/fonte/)
    expect(() => serializeCard(sug)).toThrow(/fonte/)
    expect(validateCard({ ...sug, fonte: 'https://exemplo.com/a' }).fonte).toBe('https://exemplo.com/a')
  })

  it('fonte aceita arquivo do projeto (a mesma regra do renderer), e recusa fora do projeto', () => {
    const sug: PlanCard = { id: 's1', tipo: 'sugestao', titulo: 'Reusar o parser', links: [], rev: 0, corpo: '' }
    expect(validateCard({ ...sug, fonte: 'src/a.ts:12' }).fonte).toBe('src/a.ts:12')
    expect(parseCard(serializeCard({ ...sug, fonte: 'src/main/x.ts' })).fonte).toBe('src/main/x.ts')
    for (const bad of ['../x', 'C:\\x', '/etc/passwd', '', 'minha cabeça']) {
      expect(() => validateCard({ ...sug, fonte: bad }), bad).toThrow(/fonte/)
    }
    // Vale para qualquer tipo que traga fonte, não só sugestão.
    expect(() => validateCard({ ...base, fonte: '../fora.ts' })).toThrow(/fonte/)
  })

  it('ambiguidade exige status aberta|resolvida', () => {
    const amb: PlanCard = { id: 'a1', tipo: 'ambiguidade', titulo: 'Qual banco?', links: [], rev: 0, corpo: '' }
    expect(() => validateCard(amb)).toThrow(/ambiguidade/)
    expect(() => validateCard({ ...amb, status: 'talvez' })).toThrow(/ambiguidade/)
    expect(validateCard({ ...amb, status: 'aberta' }).status).toBe('aberta')
  })

  it('recusa tipo, id e frontmatter inválidos', () => {
    expect(() => validateCard({ ...base, tipo: 'xyz' as never })).toThrow(/tipo/)
    expect(() => validateCard({ ...base, id: '../x' })).toThrow(/id/)
    expect(() => parseCard('sem frontmatter')).toThrow(/frontmatter/)
  })

  it('card sem anexos (ou com anexos vazio) serializa byte a byte como antes', () => {
    const legacy = [
      '---',
      'id: "req-login"',
      'tipo: "requisito"',
      'titulo: "Login com \\"e-mail\\": obrigatório"',
      'etapa: "etapa-1"',
      'links: ["dec-auth"]',
      'rev: 3',
      '---',
      ''
    ].join('\n') + base.corpo
    expect(serializeCard(base)).toBe(legacy)
    expect(serializeCard({ ...base, anexos: [] })).toBe(legacy)
    expect(parseCard(legacy)).toEqual(base)
    expect('anexos' in parseCard(legacy)).toBe(false)
  })

  it('round-trip com anexos; tipo midia exige ao menos um anexo', () => {
    const comAnexo: PlanCard = { ...base, anexos: ['a1b2c3-tela.png', 'ffffff-spec.pdf'] }
    const text = serializeCard(comAnexo)
    expect(text).toContain('anexos: ["a1b2c3-tela.png","ffffff-spec.pdf"]')
    expect(parseCard(text)).toEqual(comAnexo)
    expect(serializeCard(parseCard(text))).toBe(text)

    const midia: PlanCard = { id: 'm1', tipo: 'midia', titulo: 'Tela', links: [], rev: 0, corpo: '' }
    expect(() => validateCard(midia)).toThrow(/anexo/)
    expect(() => validateCard({ ...midia, anexos: [] })).toThrow(/anexo/)
    expect(validateCard({ ...midia, anexos: ['a1b2c3-tela.png'] }).tipo).toBe('midia')
    expect(parseCard(serializeCard({ ...midia, anexos: ['a1b2c3-tela.png'] })).anexos).toEqual(['a1b2c3-tela.png'])
  })

  it('anexos escritos à mão no frontmatter também são lidos', () => {
    const text = '---\nid: m1\ntipo: midia\ntitulo: Tela\nanexos: [a1b2c3-tela.png, b.pdf]\nrev: 1\n---\n'
    expect(parseCard(text).anexos).toEqual(['a1b2c3-tela.png', 'b.pdf'])
  })

  it('recusa anexo com nome inválido, repetido ou acima do limite', () => {
    for (const bad of ['../x.png', 'A.png', 'a/b.png', 'a b.png', '', 'con.png']) {
      expect(() => validateCard({ ...base, anexos: [bad] }), bad).toThrow(/anexo/)
    }
    expect(() => validateCard({ ...base, anexos: ['a.png', 'a.png'] })).toThrow(/repetido/)
    const muitos = Array.from({ length: MAX_ANEXOS_POR_CARD + 1 }, (_, i) => `f${i}.png`)
    expect(() => validateCard({ ...base, anexos: muitos })).toThrow(/anexos/)
    expect(validateCard({ ...base, anexos: muitos.slice(0, MAX_ANEXOS_POR_CARD) }).anexos).toHaveLength(MAX_ANEXOS_POR_CARD)
    expect(() => validateCard({ ...base, anexos: 'a.png' as never })).toThrow(/anexos/)
    expect(() => parseCard('---\nid: n1\ntipo: nota\ntitulo: T\nanexos: 5\nrev: 1\n---\n')).toThrow(/anexos/)
  })

  it('extrai links [[id]] sem repetir', () => {
    expect(extractLinks('a [[x-1]] b [[y]] [[x-1]] [[Nao]] [[../z]]')).toEqual(['x-1', 'y'])
  })
})

describe('roteiro', () => {
  it('round-trip mantém ordem, status e rev', () => {
    const r = {
      titulo: 'Checkout novo',
      rev: 3,
      etapas: [
        { id: 'etapa-1', titulo: 'Levantar requisitos', status: 'concluida' as const },
        { id: 'etapa-2', titulo: 'Protótipo: tela', status: 'em_andamento' as const },
        { id: 'etapa-3', titulo: 'Entregar', status: 'pendente' as const }
      ]
    }
    const text = serializeRoteiro(r)
    expect(parseRoteiro(text)).toEqual(r)
    expect(serializeRoteiro(parseRoteiro(text))).toBe(text)
  })

  it('grava o rev numa linha estável logo após o título', () => {
    const text = serializeRoteiro({ titulo: 'T', rev: 12, etapas: [{ id: 'e1', titulo: 'E', status: 'pendente' }] })
    expect(text).toBe('# T\n<!-- rev: 12 -->\n\n- [pendente] e1: E\n')
  })

  it('roteiro gravado antes do rev abre com rev 0 (e CRLF/BOM não atrapalham)', () => {
    const legacy = '# Antigo\n\n- [concluida] e1: Feito\n- [pendente] e2: Falta\n'
    expect(parseRoteiro(legacy)).toEqual({
      titulo: 'Antigo',
      rev: 0,
      etapas: [
        { id: 'e1', titulo: 'Feito', status: 'concluida' },
        { id: 'e2', titulo: 'Falta', status: 'pendente' }
      ]
    })
    expect(parseRoteiro('﻿# T\r\n<!-- rev: 7 -->\r\n\r\n- [pendente] e1: E\r\n')).toMatchObject({ titulo: 'T', rev: 7 })
    expect(parseRoteiro('# T\n<!--rev:4-->\n').rev).toBe(4)
  })

  it('título do roteiro com quebra de linha não forja rev nem etapa', () => {
    const titulo = 'Checkout\n<!-- rev: 0 -->\n- [concluida] fake: y\r\nfim'
    const etapas = [{ id: 'e1', titulo: 'Real', status: 'pendente' as const }]
    const text = serializeRoteiro({ titulo, rev: 5, etapas })
    expect(text).toBe('# Checkout <!-- rev: 0 --> - [concluida] fake: y fim\n<!-- rev: 5 -->\n\n- [pendente] e1: Real\n')
    const back = parseRoteiro(text)
    expect(back.rev).toBe(5)
    expect(back.etapas).toEqual(etapas)
    expect(back.titulo).toBe('Checkout <!-- rev: 0 --> - [concluida] fake: y fim')
    // Espaço nas pontas sai, como no título das etapas; CR solto também vira espaço.
    expect(serializeRoteiro({ titulo: '  \n T\rX \r\n', rev: 0, etapas: [] })).toBe('# T X\n<!-- rev: 0 -->\n\n')
  })

  it('recusa status desconhecido, etapa repetida e rev inválido', () => {
    expect(() => parseRoteiro('# t\n- [feito] e1: x\n')).toThrow(/status/)
    const e = { id: 'e1', titulo: 'x', status: 'pendente' as const }
    expect(() => serializeRoteiro({ titulo: 't', rev: 0, etapas: [e, e] })).toThrow(/repetida/)
    for (const rev of [-1, 1.5, Number.NaN]) {
      expect(() => serializeRoteiro({ titulo: 't', rev, etapas: [] }), String(rev)).toThrow(/rev do roteiro/)
    }
  })
})
