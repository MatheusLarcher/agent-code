import { describe, expect, it } from 'vitest'
import type { UIMessage } from '../../types'
import {
  QUOTE_MAX_CHARS,
  buildQuotedMessage,
  chipLabel,
  clipQuote,
  hasQuoteHeader,
  indexCommented,
  parseQuotes,
  quoteMatchesBlock
} from './quoteFormat'

describe('clipQuote — o trecho que vai citado', () => {
  it('curto: sai igual, sem linha em branco nas pontas nem espaço sobrando no fim das linhas', () => {
    expect(clipQuote('\n  Primeira linha   \nsegunda\n\n')).toBe('  Primeira linha\nsegunda')
    expect(clipQuote('   \n  ')).toBe('')
  })

  it('longo: cortado no teto com "…", sem passar dele', () => {
    const long = 'x'.repeat(QUOTE_MAX_CHARS + 50)
    const out = clipQuote(long)
    expect(out.length).toBe(QUOTE_MAX_CHARS)
    expect(out.endsWith('…')).toBe(true)
    expect(clipQuote('abcdefghij', 6)).toBe('abcde…')
  })

  it('não parte um emoji no corte', () => {
    expect(clipQuote('abcd😀efgh', 6)).toBe('abcd…')
  })
})

describe('buildQuotedMessage / parseQuotes — o formato fixo', () => {
  const quotes = [
    { messageId: 'a1', text: 'Primeiro parágrafo.' },
    { messageId: 'a2', text: 'linha 1\n\nlinha 3' }
  ]

  it('um bloco `>` por trecho (cabeçalho "[trecho N] · mensagem <id>"), linha em branco entre eles e o texto no fim', () => {
    expect(buildQuotedMessage(quotes, 'Meu [trecho 1] e [trecho 2]')).toBe(
      [
        '> [trecho 1] · mensagem a1',
        '> Primeiro parágrafo.',
        '',
        '> [trecho 2] · mensagem a2',
        '> linha 1',
        '>',
        '> linha 3',
        '',
        'Meu [trecho 1] e [trecho 2]'
      ].join('\n')
    )
  })

  it('sem comentário, só os blocos; sem trecho, o texto sai exatamente como digitado', () => {
    expect(buildQuotedMessage(quotes.slice(0, 1), '   ')).toBe('> [trecho 1] · mensagem a1\n> Primeiro parágrafo.')
    expect(buildQuotedMessage([], '  oi\n')).toBe('  oi\n')
  })

  it('o caminho inverso devolve os mesmos trechos (e ignora citação comum)', () => {
    const text = `> uma citação qualquer\n\n${buildQuotedMessage(quotes, 'ok')}`
    expect(parseQuotes(text)).toEqual(quotes)
    expect(parseQuotes('> [trecho 1] · mensagem a9\n\ntexto')).toEqual([]) // cabeçalho sem trecho
    expect(parseQuotes('sem citação')).toEqual([])
  })

  it('o formato antigo ("> ↳ trecho da mensagem <id>") continua sendo lido, até misturado com o novo', () => {
    const legacy = '> ↳ trecho da mensagem a1\n> Primeiro parágrafo.\n\n> [trecho 2] · mensagem a2\n> linha 1\n\nok'
    expect(parseQuotes(legacy)).toEqual([
      { messageId: 'a1', text: 'Primeiro parágrafo.' },
      { messageId: 'a2', text: 'linha 1' }
    ])
    expect(parseQuotes('> ↳ trecho da mensagem a9\n\ntexto')).toEqual([])
    expect(hasQuoteHeader(legacy)).toBe(true)
    expect(hasQuoteHeader('[trecho 1] solto no texto')).toBe(false)
    const msgs: UIMessage[] = [{ kind: 'user', id: 'u1', text: '> ↳ trecho da mensagem a1\n> velho' }]
    expect(indexCommented(msgs).get('a1')?.map((q) => q.text)).toEqual(['velho'])
  })

  it('indexCommented junta por id só o que veio de mensagens do usuário', () => {
    const messages: UIMessage[] = [
      { kind: 'assistant-text', id: 'a1', text: buildQuotedMessage(quotes, ''), final: true },
      { kind: 'user', id: 'u1', text: buildQuotedMessage(quotes, 'ok') },
      { kind: 'user', id: 'u2', text: buildQuotedMessage([{ messageId: 'a1', text: 'outro' }], '') }
    ]
    const idx = indexCommented(messages)
    expect(idx.get('a1')?.map((q) => q.text)).toEqual(['Primeiro parágrafo.', 'outro'])
    expect(idx.get('a2')?.map((q) => q.text)).toEqual(['linha 1\n\nlinha 3'])
  })

  it('indexCommented ignora a mensagem cujo envio falhou ou foi cancelado', () => {
    const quoted = (id: string, text: string): string => buildQuotedMessage([{ messageId: 'a1', text }], id)
    const messages: UIMessage[] = [
      { kind: 'user', id: 'u1', text: quoted('u1', 'falhou'), error: 'Falha na sessão' },
      { kind: 'user', id: 'u2', text: quoted('u2', 'cancelada'), canceled: true },
      { kind: 'user', id: 'u3', text: quoted('u3', 'enviada') }
    ]
    expect(indexCommented(messages).get('a1')?.map((q) => q.text)).toEqual(['enviada'])
    // "Tentar de novo" limpa o erro: aí a mensagem volta a contar.
    const retried: UIMessage[] = [{ kind: 'user', id: 'u1', text: quoted('u1', 'falhou') }, ...messages.slice(1)]
    expect(indexCommented(retried).get('a1')?.map((q) => q.text)).toEqual(['falhou', 'enviada'])
  })
})

describe('quoteMatchesBlock — o destaque do bloco comentado', () => {
  it('texto igual (espaços e quebras não contam)', () => {
    expect(quoteMatchesBlock('linha 1\nlinha 2', 'linha 1 linha 2 ')).toBe(true)
    expect(quoteMatchesBlock('outro', 'linha 1')).toBe(false)
    expect(quoteMatchesBlock('', '')).toBe(false)
  })

  it('trecho cortado casa pelo começo do bloco, tolerando o "…"', () => {
    const block = `${'código '.repeat(200)}fim`
    expect(quoteMatchesBlock(clipQuote(block), block)).toBe(true)
    expect(quoteMatchesBlock(clipQuote(block), 'código')).toBe(false)
    // Sem o "…", começo igual não basta.
    expect(quoteMatchesBlock('código código', block)).toBe(false)
  })

  it('"…" do próprio texto não é corte: "Aguarde…" não destaca o bloco que só começa igual', () => {
    expect(quoteMatchesBlock('Aguarde…', 'Aguarde…')).toBe(true)
    expect(quoteMatchesBlock('Aguarde…', 'Aguarde… o build termina em 2 minutos.')).toBe(false)
    // Nem um bloco longo (acima do teto) que começa igual: o corte dele é outro.
    expect(quoteMatchesBlock('Aguarde…', `Aguarde… ${'x'.repeat(QUOTE_MAX_CHARS)}`)).toBe(false)
  })

  it('o corte de verdade continua casando, mesmo com o bloco em várias linhas', () => {
    const block = Array.from({ length: 60 }, (_, i) => `linha ${i} do código  `).join('\n')
    const quote = clipQuote(block)
    expect(quote.endsWith('…')).toBe(true)
    expect(quoteMatchesBlock(quote, block)).toBe(true)
    // Ida e volta pelo formato da mensagem (como vem do histórico).
    const [back] = parseQuotes(buildQuotedMessage([{ messageId: 'a1', text: quote }], 'ok'))
    expect(quoteMatchesBlock(back.text, block)).toBe(true)
    // Outro bloco longo que diverge ANTES do corte não casa.
    expect(quoteMatchesBlock(quote, block.replace('linha 3 ', 'linha três '))).toBe(false)
  })
})

describe('chipLabel', () => {
  it('primeira linha com texto, curta', () => {
    expect(chipLabel('\n  Olá   mundo\nresto')).toBe('Olá mundo')
    expect(chipLabel('a'.repeat(60), 10)).toBe('aaaaaaaaa…')
  })
})
