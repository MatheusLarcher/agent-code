import { describe, expect, it } from 'vitest'
import {
  REF_HREF_PREFIX,
  detectRefTrigger,
  extractRefs,
  filterRefCards,
  insertRef,
  isRefHref,
  makeRefResolver,
  normalizeRefText,
  refLabel,
  refsToMarkdownLinks,
  resolveRef,
  type RefCard
} from './cardRefs'

const CARDS: RefCard[] = [
  { id: 'login', titulo: 'Login com SSO', tipo: 'requisito' },
  { id: 'banco', titulo: 'Usar Postgres', tipo: 'decisao' },
  { id: 'acao', titulo: 'Ação de cobrança', tipo: 'nota' },
  { id: 'duvida', titulo: 'Quem aprova a ação?', tipo: 'ambiguidade' },
  { id: 'relatorio', titulo: 'Relatório mensal', tipo: 'etapa' }
]

describe('normalizeRefText', () => {
  it('tira acento, caixa e espaço sobrando', () => {
    expect(normalizeRefText('  AÇÃO   de Cobrança ')).toBe('acao de cobranca')
    expect(normalizeRefText(null)).toBe('')
  })
})

describe('detectRefTrigger', () => {
  it('acha o "[[" aberto antes do cursor e a query digitada', () => {
    expect(detectRefTrigger('Ver [[', 6)).toEqual({ start: 4, end: 6, query: '' })
    expect(detectRefTrigger('Ver [[Log', 9)).toEqual({ start: 4, end: 9, query: 'Log' })
    // Cursor no meio de uma referência já fechada ainda é gatilho.
    expect(detectRefTrigger('[[Login]]', 5)).toEqual({ start: 0, end: 5, query: 'Log' })
  })

  it('não dispara sem "[[", depois de "]]", com quebra de linha ou query longa', () => {
    expect(detectRefTrigger('Ver [Log', 8)).toBeNull()
    expect(detectRefTrigger('[[Login]] e', 11)).toBeNull()
    expect(detectRefTrigger('[[Log\nin', 8)).toBeNull()
    expect(detectRefTrigger(`[[${'x'.repeat(100)}`, 102)).toBeNull()
    expect(detectRefTrigger('[[x', null)).toBeNull()
  })
})

describe('filterRefCards', () => {
  it('filtra pelo título ignorando acento e caixa nos DOIS sentidos', () => {
    // query sem acento acha título com acento…
    expect(filterRefCards(CARDS, 'acao').map((c) => c.id)).toEqual(['acao', 'duvida'])
    // …e query com acento acha título sem acento.
    const semAcento: RefCard[] = [{ id: 'x', titulo: 'Integracao com ERP', tipo: 'nota' }]
    expect(filterRefCards(semAcento, 'INTEGRAÇÃO').map((c) => c.id)).toEqual(['x'])
  })

  it('começo do título primeiro, depois começo de palavra, depois o meio', () => {
    const cards: RefCard[] = [
      { id: 'meio', titulo: 'Programa', tipo: 'nota' },
      { id: 'palavra', titulo: 'Novo grama', tipo: 'nota' },
      { id: 'inicio', titulo: 'Gramática', tipo: 'nota' }
    ]
    expect(filterRefCards(cards, 'gram').map((c) => c.id)).toEqual(['inicio', 'palavra', 'meio'])
  })

  it('tira o próprio card, respeita o limite e query vazia lista todos', () => {
    expect(filterRefCards(CARDS, '', { excludeId: 'login' }).map((c) => c.id)).toEqual(['banco', 'acao', 'duvida', 'relatorio'])
    expect(filterRefCards(CARDS, '', { limit: 2 })).toHaveLength(2)
    expect(filterRefCards(CARDS, 'nada disso')).toEqual([])
  })
})

describe('insertRef / refLabel', () => {
  it('troca "[[query" por "[[Título]]" pelo NOME e põe o cursor depois', () => {
    const text = 'Ver [[log e mais'
    const t = detectRefTrigger(text, 9)!
    const out = insertRef(text, t, refLabel(CARDS[0], CARDS))
    expect(out.text).toBe('Ver [[Login com SSO]] e mais')
    expect(out.cursor).toBe('Ver [[Login com SSO]]'.length)
  })

  it('dentro de uma referência fechada, substitui até o "]]"', () => {
    const text = '[[Log|in]] fim'.replace('|', '')
    const out = insertRef(text, detectRefTrigger(text, 5)!, 'Usar Postgres')
    expect(out.text).toBe('[[Usar Postgres]] fim')
  })

  it('cai para o id quando o título quebraria a sintaxe ou repete o de outro card', () => {
    expect(refLabel({ id: 'a', titulo: 'Lista [x]', tipo: 'nota' })).toBe('a')
    const gemeos: RefCard[] = [
      { id: 'a', titulo: 'Relatório', tipo: 'nota' },
      { id: 'b', titulo: 'relatorio', tipo: 'nota' }
    ]
    expect(refLabel(gemeos[1], gemeos)).toBe('b')
    expect(refLabel(CARDS[1], CARDS)).toBe('Usar Postgres')
  })
})

describe('extractRefs / resolveRef', () => {
  it('extrai os rótulos na ordem, sem repetir', () => {
    expect(extractRefs('a [[Login com SSO]] b [[banco]] [[login com sso]] [[]] [[x\ny]]')).toEqual(['Login com SSO', 'banco'])
  })

  it('resolve pelo título normalizado e, por compatibilidade, pelo id', () => {
    expect(resolveRef('USAR POSTGRES', CARDS)?.id).toBe('banco')
    expect(resolveRef('acao de cobranca', CARDS)?.id).toBe('acao')
    expect(resolveRef('relatorio', CARDS)?.id).toBe('relatorio') // id
    expect(resolveRef('Card que não existe', CARDS)).toBeNull()
  })

  it('título ganha do id quando os dois batem com cards diferentes', () => {
    const cards: RefCard[] = [
      { id: 'banco', titulo: 'Usar Postgres', tipo: 'decisao' },
      { id: 'outro', titulo: 'Banco', tipo: 'nota' }
    ]
    expect(makeRefResolver(cards)('banco')?.id).toBe('outro')
  })
})

describe('refsToMarkdownLinks', () => {
  const resolve = makeRefResolver(CARDS)

  it('referência que resolve vira link com o tipo; a que não resolve fica como está', () => {
    const md = refsToMarkdownLinks('Ver [[Usar Postgres]] e [[Fantasma]].', resolve)
    expect(md).toBe(`Ver [Usar Postgres](${REF_HREF_PREFIX}decisao/banco) e [[Fantasma]].`)
    expect(isRefHref(`${REF_HREF_PREFIX}decisao/banco`)).toBe(true)
    expect(isRefHref('https://x.com')).toBe(false)
  })

  it('não mexe em código e escapa o markdown do rótulo', () => {
    expect(refsToMarkdownLinks('`[[Usar Postgres]]`', resolve)).toBe('`[[Usar Postgres]]`')
    expect(refsToMarkdownLinks('```\n[[Usar Postgres]]\n```', resolve)).toBe('```\n[[Usar Postgres]]\n```')
    const cards: RefCard[] = [{ id: 'x', titulo: 'a_b*c', tipo: 'nota' }]
    expect(refsToMarkdownLinks('[[a_b*c]]', makeRefResolver(cards))).toBe(`[a\\_b\\*c](${REF_HREF_PREFIX}nota/x)`)
  })
})
