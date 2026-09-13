// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  alertFingerprint,
  buildVigiaDigest,
  buildVigiaPrompt,
  parseVigiaVerdict,
  summarizeCall,
  VIGIA_MAX_CALLS,
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

describe('leitura do veredito', () => {
  it('aceita o alerta e devolve só a frase', () => {
    expect(parseVigiaVerdict('ALERTA: Qual o diâmetro real do eixo?')).toBe('Qual o diâmetro real do eixo?')
  })

  it('aceita alerta cercado em crase e com texto antes', () => {
    const raw = '```\nAnalisando…\nALERTA: O furo é para o eixo de 12 mm ou 11,9 mm?\n```'
    expect(parseVigiaVerdict(raw)).toBe('O furo é para o eixo de 12 mm ou 11,9 mm?')
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
