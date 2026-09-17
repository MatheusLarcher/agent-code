// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  alertFingerprint,
  buildVigiaDigest,
  buildVigiaPrompt,
  parseVigiaVerdict,
  summarizeCall,
  VIGIA_MAX_CALLS,
  VIGIA_MAX_DOCS_CHARS,
  VIGIA_MAX_HISTORY_CHARS,
  VIGIA_MAX_HISTORY_TURNS,
  VIGIA_MAX_MEMORY_CHARS,
  VIGIA_MAX_USER_CHARS
} from './vigiaPrompt'

describe('digest do vigia', () => {
  it('mantém pedido e ações, na ordem', () => {
    const digest = buildVigiaDigest({
      userText: 'faz um suporte pro eixo',
      calls: [
        { tool: 'Read', detail: 'src/params.py' },
        { tool: 'Bash', detail: 'python src/build.py' }
      ]
    })
    expect(digest).toContain('faz um suporte pro eixo')
    expect(digest.indexOf('Read')).toBeLessThan(digest.indexOf('Bash'))
  })

  it('capa o pedido e o número de ações — o custo não cresce com a conversa', () => {
    const calls = Array.from({ length: VIGIA_MAX_CALLS + 5 }, (_, i) => ({ tool: `T${i}`, detail: '' }))
    const digest = buildVigiaDigest({ userText: 'x'.repeat(VIGIA_MAX_USER_CHARS + 500), calls })
    expect(digest).toContain('…')
    expect(digest).toContain('+5 ações omitidas')
    expect(digest).not.toContain(`T${VIGIA_MAX_CALLS}`)
  })

  it('turno sem ação nenhuma ainda produz um digest legível', () => {
    expect(buildVigiaDigest({ userText: 'oi', calls: [] })).toContain('(nenhuma ação ainda)')
  })

  it('o prompt carrega o papel e o digest', () => {
    const prompt = buildVigiaPrompt({ userText: 'medida do eixo', calls: [] })
    expect(prompt).toContain('SÓ O USUÁRIO')
    expect(prompt).toContain('medida do eixo')
  })
})

describe('contexto extra do digest: histórico, memória e docs', () => {
  it('sem histórico/memória/docs, nenhuma das três seções aparece', () => {
    const digest = buildVigiaDigest({ userText: 'oi', calls: [] })
    expect(digest).not.toContain('Histórico recente')
    expect(digest).not.toContain('Memórias relevantes')
    expect(digest).not.toContain('Documentação do projeto')
  })

  it('histórico presente aparece antes do pedido, na ordem', () => {
    const digest = buildVigiaDigest({
      userText: 'terceiro pedido',
      calls: [],
      history: ['"primeiro pedido"', '"segundo pedido" (o vigia alertou)']
    })
    expect(digest).toContain('Histórico recente da conversa')
    expect(digest).toContain('primeiro pedido')
    expect(digest).toContain('segundo pedido')
    expect(digest.indexOf('Histórico recente')).toBeLessThan(digest.indexOf('Pedido do usuário'))
  })

  it('capa o histórico no número de turnos e em caracteres', () => {
    const history = Array.from({ length: VIGIA_MAX_HISTORY_TURNS + 3 }, (_, i) => `"pedido ${i}"`)
    const digest = buildVigiaDigest({ userText: 'x', calls: [], history })
    expect(digest).not.toContain('"pedido 0"')
    expect(digest).toContain(`"pedido ${VIGIA_MAX_HISTORY_TURNS + 2}"`)

    const bigHistory = ['x'.repeat(VIGIA_MAX_HISTORY_CHARS + 200)]
    const digestBig = buildVigiaDigest({ userText: 'x', calls: [], history: bigHistory })
    expect(digestBig).toContain('…')
  })

  it('memória e docs aparecem, cada uma na sua seção e capadas', () => {
    const digest = buildVigiaDigest({
      userText: 'x',
      calls: [],
      memory: 'usuário prefere respostas curtas',
      docs: 'ARQUITETURA.md: como o app funciona'
    })
    expect(digest).toContain('Memórias relevantes do usuário')
    expect(digest).toContain('usuário prefere respostas curtas')
    expect(digest).toContain('Documentação do projeto')
    expect(digest).toContain('ARQUITETURA.md')

    const cappedMemory = buildVigiaDigest({ userText: 'x', calls: [], memory: 'm'.repeat(VIGIA_MAX_MEMORY_CHARS + 100) })
    expect(cappedMemory).toContain('…')
    const cappedDocs = buildVigiaDigest({ userText: 'x', calls: [], docs: 'd'.repeat(VIGIA_MAX_DOCS_CHARS + 100) })
    expect(cappedDocs).toContain('…')
  })

  it('memória/docs em branco não geram seção vazia', () => {
    const digest = buildVigiaDigest({ userText: 'x', calls: [], memory: '   ', docs: '' })
    expect(digest).not.toContain('Memórias relevantes')
    expect(digest).not.toContain('Documentação do projeto')
  })
})

describe('leitura do veredito', () => {
  it('aceita o alerta e devolve só a frase', () => {
    expect(parseVigiaVerdict('ALERTA: Qual o diâmetro real do eixo?')).toEqual({
      question: 'Qual o diâmetro real do eixo?',
      options: []
    })
  })

  it('aceita alerta cercado em crase e com texto antes', () => {
    const raw = '```\nAnalisando…\nALERTA: O furo é para o eixo de 12 mm ou 11,9 mm?\n```'
    expect(parseVigiaVerdict(raw)?.question).toBe('O furo é para o eixo de 12 mm ou 11,9 mm?')
  })

  it('OK não é alerta', () => {
    expect(parseVigiaVerdict('OK')).toBeNull()
  })

  // Falha fechada: o custo de um aviso inventado é o usuário parar de ler os avisos.
  it('resposta fora do formato vira silêncio, não alerta', () => {
    expect(parseVigiaVerdict('acho que talvez seja bom revisar depois')).toBeNull()
    expect(parseVigiaVerdict('')).toBeNull()
    expect(parseVigiaVerdict('ALERTA: curto')).toBeNull()
  })
})

describe('respostas prováveis', () => {
  it('separa a pergunta das opções', () => {
    expect(parseVigiaVerdict('ALERTA: O alvo é o app ou a extensão? | só o app | só a extensão | os dois')).toEqual({
      question: 'O alvo é o app ou a extensão?',
      options: ['só o app', 'só a extensão', 'os dois']
    })
  })

  it('descarta vazio e repetido, e capa no teto', () => {
    const raw = `ALERTA: Qual ambiente você usa? | prod |  | PROD | homolog | dev | teste | ${'x'.repeat(200)}`
    const verdict = parseVigiaVerdict(raw)
    expect(verdict?.options).toEqual(['prod', 'homolog', 'dev', 'teste'])
  })

  // Uma opção só não é escolha: ou o usuário tem alternativas, ou digita.
  it('uma opção sozinha vira nenhuma', () => {
    expect(parseVigiaVerdict('ALERTA: Qual o diâmetro do eixo? | 12 mm')?.options).toEqual([])
  })

  // Falha ABERTA, ao contrário da pergunta: lista ilegível não derruba a dúvida.
  it('opção gigante é cortada, não descarta o alerta', () => {
    const verdict = parseVigiaVerdict(`ALERTA: Escolhe? | ${'a'.repeat(200)} | ${'b'.repeat(200)}`)
    expect(verdict?.question).toBe('Escolhe?')
    expect(verdict?.options.every((o) => o.length <= 60)).toBe(true)
  })
})

describe('dedupe por conteúdo', () => {
  it('a mesma dúvida tem a mesma identidade, apesar de caixa, acento e pontuação', () => {
    expect(alertFingerprint('Qual o diâmetro do eixo?')).toBe(alertFingerprint('qual o diametro do eixo'))
  })

  it('dúvidas diferentes não colidem', () => {
    expect(alertFingerprint('Qual o diâmetro do eixo?')).not.toBe(alertFingerprint('Qual a altura da base?'))
  })
})

describe('resumo da chamada', () => {
  it('pega o alvo de cada ferramenta, não o conteúdo', () => {
    expect(summarizeCall('Bash', { command: 'npm test' })).toBe('npm test')
    expect(summarizeCall('Write', { file_path: 'C:/x/y.ts', content: 'SEGREDO' })).toBe('C:/x/y.ts')
    expect(summarizeCall('Grep', { pattern: 'foo' })).toBe('foo')
    expect(summarizeCall('Skill', { skill: '3d-print-modeling' })).toBe('3d-print-modeling')
  })

  it('nunca devolve conteúdo de arquivo editado', () => {
    const detail = summarizeCall('Edit', { file_path: 'a.ts', old_string: 'SEGREDO', new_string: 'SEGREDO2' })
    expect(detail).toBe('a.ts')
  })

  it('ferramenta desconhecida e input inválido não quebram', () => {
    expect(summarizeCall('Qualquer', null)).toBe('')
    expect(summarizeCall('Qualquer', { path: 'x' })).toBe('x')
  })
})
