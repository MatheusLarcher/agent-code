// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BUNDLED_VOCABULARY, buildBooster, fixWithVocabulary, parseVocabulary, segmentations } from './hotwords'
import { tdtGreedyDecode, type Vocab } from './tdt'

// Vocabulário de brinquedo: peças com o espaço inicial do SentencePiece já como " ".
const PIECES = ['<unk>', ' back', 'end', ' b', 'a', 'c', 'k', 'e', 'n', 'd', ' the', ' r', 'ag', ' br', ' bo', 'ta', '<blk>']
const vocab: Vocab = { pieces: PIECES, blank: PIECES.indexOf('<blk>') }
const id = (p: string): number => PIECES.indexOf(p)
const ids = new Map(PIECES.map((p, i) => [p, i]))

/** Logits com `top` em 0, o resto em -10 e os pedidos em `others`. */
function logits(top: number, others: Record<number, number> = {}): Float32Array {
  const l = new Float32Array(PIECES.length).fill(-10)
  l[top] = 0
  for (const [k, v] of Object.entries(others)) l[Number(k)] = v
  return l
}

describe('parseVocabulary', () => {
  it('ignora comentários e linhas vazias, sem repetir', () => {
    expect(parseVocabulary('# x\nbackend\n\n  GitHub  # nome\nbackend\nlanding   page\n')).toEqual(['backend', 'GitHub', 'landing page'])
  })

  it('a lista embutida vem do resources/voice/vocabulario.txt', () => {
    expect(BUNDLED_VOCABULARY).toContain('backend')
    expect(BUNDLED_VOCABULARY).toContain('brag')
    expect(BUNDLED_VOCABULARY.some((t) => t.startsWith('#'))).toBe(false)
  })
})

describe('segmentations', () => {
  it('traz a de menos peças primeiro e alternativas com uma peça a mais', () => {
    const segs = segmentations(' backend', ids, 5)
    expect(segs[0]).toEqual([id(' back'), id('end')])
    expect(segs.every((s) => s.length <= 3)).toBe(true)
    // " brag": " br"+"ag" (2) e " b"+"r"… não existe; " r" não serve no meio.
    expect(segmentations(' brag', ids, 5)).toEqual([[id(' br'), id('ag')]])
    // " back" + "e","n","d" (4 peças) passa da folga de uma peça.
    expect(segs).not.toContainEqual([id(' back'), id('e'), id('n'), id('d')])
  })

  it('termo impossível de montar não gera nada', () => {
    expect(segmentations(' xyz', ids, 5)).toEqual([])
  })
})

describe('reforço na decodificação', () => {
  const booster = buildBooster(vocab, ['backend', 'brag'])!

  it('desempata a favor do começo de um termo quando o modelo hesita', () => {
    const s = booster.session()
    // " bo" vence por pouco; " back" (início de "backend") ganha o bônus.
    expect(s.choose(logits(id(' bo'), { [id(' back')]: -0.5 }), vocab.blank)).toBe(id(' back'))
  })

  it('não muda quem o modelo tem certeza', () => {
    const s = booster.session()
    expect(s.choose(logits(id(' the'), { [id(' back')]: -8 }), vocab.blank)).toBe(id(' the'))
    expect(s.choose(logits(vocab.blank, { [id(' back')]: -8 }), vocab.blank)).toBe(vocab.blank)
  })

  it('a continuação do termo em andamento ganha mais que um começo', () => {
    const s = booster.session()
    s.emitted(id(' back'))
    // depois de " back": "end" (continuação) contra "a" (sem reforço) que vence por 1
    expect(s.choose(logits(id('a'), { [id('end')]: -1 }), vocab.blank)).toBe(id('end'))
    s.emitted(id('end'))
    // termo completo: "end" não é mais continuação de nada
    expect(s.choose(logits(id('a'), { [id('end')]: -1 }), vocab.blank)).toBe(id('a'))
  })

  it('nunca vence o blank: quando emitir é decisão do modelo', () => {
    const s = booster.session()
    s.emitted(id(' back'))
    expect(s.choose(logits(vocab.blank, { [id('end')]: -0.1, [id(' back')]: -0.1 }), vocab.blank)).toBe(vocab.blank)
  })

  it('não troca uma peça que já segue um termo por outra segmentação', () => {
    const s = booster.session()
    // " br" já começa "brag"; " b" também começaria, mas o modelo escolheu " br"
    expect(s.choose(logits(id(' br'), { [id(' b')]: -0.1 }), vocab.blank)).toBe(id(' br'))
  })

  it('começo de uma letra só não ganha bônus', () => {
    const s = booster.session()
    // " b" começa segmentações de "backend"/"brag", mas sozinho não diz nada
    expect(s.choose(logits(id(' bo'), { [id(' b')]: -0.3 }), vocab.blank)).toBe(id(' bo'))
  })

  it('entra no greedy do TDT', async () => {
    const steps = [logits(id(' bo'), { [id(' back')]: -0.5 }), logits(id('ta'), { [id('end')]: -1 }), logits(vocab.blank)]
    let i = 0
    const run = (bias?: ReturnType<typeof booster.session>) => {
      i = 0
      return tdtGreedyDecode(3, vocab.blank, null, async () => ({ tokenLogits: steps[i++], durationLogits: [0, 1], state: null }), 10, bias)
    }
    expect((await run()).tokens).toEqual([id(' bo'), id('ta')])
    expect((await run(booster.session())).tokens).toEqual([id(' back'), id('end')])
  })

  it('desliga com AGENT_CODE_VOICE_HOTWORDS=0', () => {
    process.env.AGENT_CODE_VOICE_HOTWORDS = '0'
    try {
      expect(buildBooster(vocab, ['backend'])).toBeNull()
    } finally {
      delete process.env.AGENT_CODE_VOICE_HOTWORDS
    }
  })
})

describe('fixWithVocabulary', () => {
  const terms = ['backend', 'GitHub', 'TypeScript', 'Node', 'brag-slim', 'Agent Code', 'open source', 'Three.js', 'PO']

  it('junta palavras quebradas na grafia da lista', () => {
    expect(fixWithVocabulary('sobe o back end no git hub.', terms)).toBe('sobe o backend no GitHub.')
    expect(fixWithVocabulary('Back end pronto', terms)).toBe('Backend pronto')
    expect(fixWithVocabulary('roda o brag slim e o three js', terms)).toBe('roda o brag-slim e o Three.js')
  })

  it('acerta a caixa de nomes próprios e siglas', () => {
    expect(fixWithVocabulary('em typescript, fala com o po do agent code', terms)).toBe('em TypeScript, fala com o PO do Agent Code')
    expect(fixWithVocabulary('é opensource', terms)).toBe('é open source')
  })

  it('não mexe no que já está certo nem cola palavras curtas do português', () => {
    expect(fixWithVocabulary('Backend e backend', terms)).toBe('Backend e backend')
    expect(fixWithVocabulary('fica no de baixo', terms)).toBe('fica no de baixo')
    expect(fixWithVocabulary('usa o node', terms)).toBe('usa o Node')
  })

  it('termo em minúscula só fica maiúsculo no começo da frase', () => {
    expect(fixWithVocabulary('depois o Backend. Backend sobe', terms)).toBe('depois o backend. Backend sobe')
  })

  it('não junta palavras separadas por pontuação', () => {
    expect(fixWithVocabulary('volta. End', terms)).toBe('volta. End')
    expect(fixWithVocabulary('git, hub', terms)).toBe('git, hub')
  })
})
