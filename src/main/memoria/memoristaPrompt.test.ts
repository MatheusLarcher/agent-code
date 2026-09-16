// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  appendFact,
  buildMemoristaDigest,
  buildMemoristaPrompt,
  buildMemoryBody,
  isSafeMemoryPath,
  MEMORISTA_MAX_OPS,
  MEMORISTA_MAX_USER_CHARS,
  parseMemoristaVerdict
} from './memoristaPrompt'

const turn = (over: Partial<Parameters<typeof buildMemoristaDigest>[0]> = {}) => ({
  userText: 'nunca rode migração direto em produção',
  calls: [],
  memories: [],
  ...over
})

describe('buildMemoristaDigest — o que o modelo vê', () => {
  it('lista as memórias existentes ANTES do turno, com caminho e gancho', () => {
    const digest = buildMemoristaDigest(
      turn({ memories: [{ relPath: 'fiscal/nota.md', title: 'Nota de serviço', hook: 'ao emitir nota' }] })
    )
    expect(digest.indexOf('MEMÓRIAS JÁ SALVAS')).toBeLessThan(digest.indexOf('O QUE O USUÁRIO DISSE'))
    expect(digest).toContain('fiscal/nota.md — Nota de serviço: ao emitir nota')
  })

  it('cap do texto do usuário: o custo não cresce com o tamanho da conversa', () => {
    const digest = buildMemoristaDigest(turn({ userText: 'a'.repeat(MEMORISTA_MAX_USER_CHARS * 2) }))
    expect(digest).toContain('…')
    expect(digest.length).toBeLessThan(MEMORISTA_MAX_USER_CHARS * 2)
  })

  it('o prompt carrega a régua inteira — instrução e conhecimento, não só correção', () => {
    const prompt = buildMemoristaPrompt(turn())
    for (const rule of ['INSTRUÇÃO', 'PREFERÊNCIA', 'CONHECIMENTO', 'DECISÃO', 'INFRAESTRUTURA', 'CORREÇÃO']) {
      expect(prompt).toContain(rule)
    }
    // E a exclusão que impede o acervo de virar cópia do repositório.
    expect(prompt).toContain('o que está no código, no git ou no CLAUDE.md do projeto')
    expect(prompt).toContain('NUNCA escreva o valor de um segredo')
  })
})

describe('parseMemoristaVerdict — falha fechada', () => {
  it('instrução do usuário vira memória nova, com categoria e gancho', () => {
    const ops = parseMemoristaVerdict(
      'NOVA | instrucao | migracao-em-producao.md | Migração em produção | ao alterar o banco | Nunca rodar migração direto em produção; sempre em janela combinada.',
      []
    )
    expect(ops).toEqual([
      {
        kind: 'create',
        relPath: 'migracao-em-producao.md',
        type: 'instrucao',
        title: 'Migração em produção',
        hook: 'ao alterar o banco',
        fact: 'Nunca rodar migração direto em produção; sempre em janela combinada.'
      }
    ])
  })

  it('conhecimento de domínio e preferência também qualificam — é a diferença para o curador', () => {
    const ops = parseMemoristaVerdict(
      [
        'NOVA | conhecimento | nota-de-servico.md | ISS retido | ao emitir nota | O município retém 5% de ISS em nota de serviço acima de R$ 5.000.',
        'NOVA | preferencia | estilo-de-resposta.md | Resposta curta | ao responder | O usuário prefere resposta direta, sem introdução nem resumo final.'
      ].join('\n'),
      []
    )
    expect(ops.map((op) => op.kind === 'create' && op.type)).toEqual(['conhecimento', 'preferencia'])
  })

  it('assunto já existente vira COMPLEMENTA — e o caminho tem que estar no índice', () => {
    const ops = parseMemoristaVerdict(
      [
        'COMPLEMENTA | fiscal/nota.md | A retenção passou a valer também para nota acima de R$ 3.000.',
        'COMPLEMENTA | nao-existe.md | fato sobre um arquivo que o digest nunca mostrou'
      ].join('\n'),
      ['fiscal/nota.md']
    )
    expect(ops).toEqual([
      { kind: 'update', relPath: 'fiscal/nota.md', fact: 'A retenção passou a valer também para nota acima de R$ 3.000.' }
    ])
  })

  it('NOVA sobre um caminho que já existe é descartada: o modelo devia ter complementado', () => {
    const ops = parseMemoristaVerdict(
      'NOVA | conhecimento | fiscal/nota.md | Nota | quando emitir | duplicaria o assunto',
      ['fiscal/nota.md']
    )
    expect(ops).toEqual([])
  })

  it('linha fora do formato vira silêncio, nunca uma memória inventada', () => {
    const raw = [
      'OK',
      'Acho que vale guardar que o usuário prefere resposta curta',
      'NOVA | curiosidade | nota.md | Título | gancho | categoria fora da régua',
      'NOVA | instrucao | Caminho Inválido.MD | Título | gancho | caminho não é slug',
      'NOVA | instrucao | ../fuga.md | Título | gancho | caminho fora da pasta',
      'NOVA | instrucao | sem-fato.md | Título | gancho | ',
      'COMPLEMENTA | fiscal/nota.md',
      '```',
      'MEMORY.md | qualquer coisa'
    ].join('\n')
    expect(parseMemoristaVerdict(raw, ['fiscal/nota.md'])).toEqual([])
  })

  it('respeita o teto de operações por análise', () => {
    const raw = Array.from(
      { length: MEMORISTA_MAX_OPS + 3 },
      (_, index) => `NOVA | conhecimento | fato-${index}.md | Fato ${index} | quando ${index} | conteúdo ${index}`
    ).join('\n')
    expect(parseMemoristaVerdict(raw, [])).toHaveLength(MEMORISTA_MAX_OPS)
  })

  it('não propõe duas operações para o mesmo caminho', () => {
    const raw = [
      'COMPLEMENTA | fiscal/nota.md | primeiro fato',
      'COMPLEMENTA | fiscal/nota.md | segundo fato no mesmo arquivo'
    ].join('\n')
    expect(parseMemoristaVerdict(raw, ['fiscal/nota.md'])).toHaveLength(1)
  })
})

describe('isSafeMemoryPath', () => {
  it('aceita slug kebab na raiz e numa pasta de agrupamento', () => {
    expect(isSafeMemoryPath('regra-de-nota.md')).toBe(true)
    expect(isSafeMemoryPath('fiscal/regra-de-nota.md')).toBe(true)
  })

  it('recusa índice, travessia, extensão errada e profundidade demais', () => {
    expect(isSafeMemoryPath('MEMORY.md')).toBe(false)
    expect(isSafeMemoryPath('../fora.md')).toBe(false)
    expect(isSafeMemoryPath('regra.txt')).toBe(false)
    expect(isSafeMemoryPath('a/b/c.md')).toBe(false)
    expect(isSafeMemoryPath('Regra_De_Nota.md')).toBe(false)
  })
})

describe('corpo do arquivo', () => {
  it('memória nova nasce com front-matter, título e o fato', () => {
    const body = buildMemoryBody({
      kind: 'create',
      relPath: 'fiscal/nota-de-servico.md',
      type: 'conhecimento',
      title: 'ISS retido',
      hook: 'ao emitir nota',
      fact: 'O município retém 5% de ISS.'
    })
    expect(body).toContain('name: nota-de-servico')
    expect(body).toContain('description: ao emitir nota')
    expect(body).toContain('type: conhecimento')
    expect(body).toContain('# ISS retido')
    expect(body).toContain('O município retém 5% de ISS.')
  })

  it('complementar ACRESCENTA sem apagar o que já estava lá', () => {
    expect(appendFact('# Título\nfato antigo', 'fato novo')).toBe('# Título\nfato antigo\nfato novo\n')
  })

  it('fato que já está no corpo não gera revisão nova', () => {
    expect(appendFact('# Título\nO município retém 5% de ISS.', 'o municipio retem 5% de iss.')).toBeNull()
  })
})
