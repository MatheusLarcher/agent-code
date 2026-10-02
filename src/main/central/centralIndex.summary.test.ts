// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { summarizeConversation, type VersionedConversationLike } from './centralIndex'
import { CWD, conv, inProj, notSandbox, say, summarize, tool, user } from './centralTestKit'

describe('summarizeConversation — campos', () => {
  it('resume: título, 1º pedido, 2 últimos, arquivos (mais recente primeiro) e começo da resposta', () => {
    const messages = [
      user('Primeiro pedido'),
      tool('Write', { file_path: inProj('src', 'a.ts') }),
      say('comentário no meio do turno'),
      user('Segundo pedido'),
      tool('Edit', { file_path: inProj('src', 'b.ts') }),
      user('Terceiro pedido'),
      say('A resposta final', { answer: true })
    ]
    expect(summarize({ title: 'Meu título', messages, updatedAt: 5_000 })).toEqual({
      convId: 'c1',
      cwd: CWD,
      project: 'proj',
      sandbox: false,
      title: 'Meu título',
      firstRequest: 'Primeiro pedido',
      lastRequests: ['Segundo pedido', 'Terceiro pedido'],
      files: ['src/b.ts', 'src/a.ts'],
      answerStart: 'A resposta final',
      updatedAt: 5_000
    })
  })

  it('conversa em branco (sem mensagens) tem resumo vazio, mas existe', () => {
    expect(summarize({ messages: undefined })).toMatchObject({
      firstRequest: '',
      lastRequests: [],
      files: [],
      answerStart: ''
    })
    expect(summarize({ messages: [] })).toMatchObject({ firstRequest: '', lastRequests: [], files: [], answerStart: '' })
  })

  it('o título também é texto de uma linha cortado em 200', () => {
    expect(summarize({ title: `Um\ntítulo ${'x'.repeat(300)}` })?.title).toHaveLength(200)
    expect(summarize({ title: 7 })?.title).toBe('')
  })

  it('o nome do projeto é o da pasta (com ou sem barra no fim, Windows ou POSIX)', () => {
    expect(summarize({ cwd: 'C:\\GitHub\\agent-code' })?.project).toBe('agent-code')
    expect(summarize({ cwd: 'C:\\GitHub\\agent-code\\' })?.project).toBe('agent-code')
    expect(summarize({ cwd: '/home/u/meu-app' })?.project).toBe('meu-app')
    expect(summarize({ cwd: 'C:\\' })?.project).toBe('C:')
  })

  it('não altera a linha que recebeu', () => {
    const row = conv({ messages: [user('oi'), tool('Write', { file_path: inProj('a.ts') }), say('ok', { answer: true })] })
    const before = JSON.stringify(row)
    summarizeConversation(row, notSandbox)
    expect(JSON.stringify(row)).toBe(before)
  })
})

describe('summarizeConversation — pedidos do usuário', () => {
  it('um único pedido: é o 1º e não se repete nos últimos', () => {
    expect(summarize({ messages: [user('só este')] })).toMatchObject({ firstRequest: 'só este', lastRequests: [] })
  })

  it('dois pedidos: o 2º é o único dos últimos (o 1º não se repete)', () => {
    const s = summarize({ messages: [user('um'), user('dois')] })
    expect(s).toMatchObject({ firstRequest: 'um', lastRequests: ['dois'] })
  })

  it('três ou mais: os 2 últimos, em ordem cronológica', () => {
    const three = summarize({ messages: [user('um'), user('dois'), user('três')] })
    expect(three).toMatchObject({ firstRequest: 'um', lastRequests: ['dois', 'três'] })
    const five = summarize({ messages: [user('um'), user('dois'), user('três'), user('quatro'), user('cinco')] })
    expect(five).toMatchObject({ firstRequest: 'um', lastRequests: ['quatro', 'cinco'] })
  })

  it('pedido cancelado não conta (nem como 1º, nem como último)', () => {
    const s = summarize({
      messages: [
        user('cancelado logo de cara', { canceled: true }),
        user('o primeiro de verdade'),
        user('um do meio'),
        user('o último', { canceled: false }),
        user('cancelado no fim', { canceled: true })
      ]
    })
    expect(s).toMatchObject({ firstRequest: 'o primeiro de verdade', lastRequests: ['um do meio', 'o último'] })
  })

  it('só pedidos cancelados: resumo sem pedidos', () => {
    expect(summarize({ messages: [user('x', { canceled: true })] })).toMatchObject({ firstRequest: '', lastRequests: [] })
  })

  it('texto em branco não é pedido; só um anexo ({{midia:N}}) é', () => {
    const s = summarize({ messages: [user('   \n '), user('{{midia:1}}'), user(''), user('depois')] })
    expect(s).toMatchObject({ firstRequest: '[anexo]', lastRequests: ['depois'] })
  })

  it('texto limpo: uma linha, [anexo], cortado em 200', () => {
    const s = summarize({
      messages: [user('veja\n  {{midia:1}}\n\ne faça isso'), user('x'.repeat(400)), user('y'.repeat(400))]
    })
    expect(s?.firstRequest).toBe('veja [anexo] e faça isso')
    expect(s?.lastRequests).toEqual(['x'.repeat(199) + '…', 'y'.repeat(199) + '…'])
  })

  it('só mensagens do usuário contam como pedido (nem texto do agente, nem erro)', () => {
    const s = summarize({
      messages: [say('o agente falando', { answer: true }), { kind: 'error', id: 'e', text: 'falha' }, user('o pedido')]
    })
    expect(s).toMatchObject({ firstRequest: 'o pedido', lastRequests: [] })
  })
})

describe('summarizeConversation — arquivos editados', () => {
  it('Write, Edit, MultiEdit e NotebookEdit (file_path ou notebook_path)', () => {
    const s = summarize({
      messages: [
        tool('Write', { file_path: inProj('w.ts'), content: 'x' }),
        tool('Edit', { file_path: inProj('e.ts'), old_string: 'a', new_string: 'b' }),
        tool('MultiEdit', { file_path: inProj('m.ts'), edits: [] }),
        tool('NotebookEdit', { notebook_path: inProj('n.ipynb'), new_source: 'x' })
      ]
    })
    expect(s?.files).toEqual(['n.ipynb', 'm.ts', 'e.ts', 'w.ts'])
  })

  it('outras ferramentas não entram', () => {
    const s = summarize({
      messages: [
        tool('Read', { file_path: inProj('lido.ts') }),
        tool('Bash', { command: 'echo oi > feito.txt' }),
        tool('Grep', { pattern: 'x', path: CWD }),
        tool('TodoWrite', { todos: [] }),
        tool('Write', { file_path: inProj('criado.ts') })
      ]
    })
    expect(s?.files).toEqual(['criado.ts'])
  })

  it('sem repetição: o arquivo fica na posição da edição mais recente', () => {
    const s = summarize({
      messages: [
        tool('Edit', { file_path: inProj('a.ts') }),
        tool('Edit', { file_path: inProj('b.ts') }),
        tool('Edit', { file_path: inProj('a.ts') }),
        tool('Write', { file_path: inProj('c.ts') }),
        tool('Edit', { file_path: inProj('a.ts') })
      ]
    })
    expect(s?.files).toEqual(['a.ts', 'c.ts', 'b.ts'])
  })

  it('no máximo 8, os mais recentes', () => {
    const messages = Array.from({ length: 12 }, (_, i) => tool('Write', { file_path: inProj(`f${i + 1}.ts`) }))
    const s = summarize({ messages })
    expect(s?.files).toEqual(['f12.ts', 'f11.ts', 'f10.ts', 'f9.ts', 'f8.ts', 'f7.ts', 'f6.ts', 'f5.ts'])
  })

  it('relativo à pasta da conversa quando está dentro; só o nome quando está fora', () => {
    const s = summarize({
      messages: [
        tool('Edit', { file_path: inProj('src', 'main', 'index.ts') }),
        tool('Edit', { file_path: 'C:\\outra\\pasta\\notas.md' }),
        tool('Edit', { file_path: 'src/relativo.ts' })
      ]
    })
    expect(s?.files).toEqual(['src/relativo.ts', 'notas.md', 'src/main/index.ts'])
  })

  it('arquivos de pastas diferentes com o mesmo nome (fora da pasta) aparecem uma vez', () => {
    const s = summarize({
      messages: [
        tool('Write', { file_path: 'C:\\um\\README.md' }),
        tool('Write', { file_path: 'C:\\dois\\README.md' })
      ]
    })
    expect(s?.files).toEqual(['README.md'])
  })

  it('não conta o que é de subagente nem entrada sem caminho válido', () => {
    const s = summarize({
      messages: [
        tool('Write', { file_path: inProj('de-subagente.ts') }, { parentToolUseId: 'toolu_1' }),
        tool('Write', null),
        tool('Write', 'texto'),
        tool('Write', {}),
        tool('Write', { file_path: 42 }),
        tool('Write', { file_path: '' }),
        { kind: 'tool-use', id: 'sem-nome', input: { file_path: inProj('x.ts') } },
        tool('Write', { file_path: inProj('valido.ts') }, { parentToolUseId: undefined })
      ]
    })
    expect(s?.files).toEqual(['valido.ts'])
  })

  it('o resultado do tool-use (erro ou não) não muda nada', () => {
    const s = summarize({ messages: [tool('Edit', { file_path: inProj('a.ts') }, { result: { isError: true, text: 'falhou' } })] })
    expect(s?.files).toEqual(['a.ts'])
  })
})

describe('summarizeConversation — começo da resposta final', () => {
  it('é o último assistant-text com answer: true, mesmo que haja um final: true depois dele', () => {
    const s = summarize({
      messages: [
        say('resposta antiga', { answer: true }),
        say('resposta nova', { answer: true }),
        say('comentário do turno seguinte', { final: true })
      ]
    })
    expect(s?.answerStart).toBe('resposta nova')
  })

  it('sem answer, usa o último com final: true (e ignora o parcial)', () => {
    const s = summarize({
      messages: [say('comentário 1'), say('comentário 2'), say('em andamento', { final: false })]
    })
    expect(s?.answerStart).toBe('comentário 2')
  })

  it('sem nenhum dos dois: vazio', () => {
    expect(summarize({ messages: [user('oi'), say('parcial', { final: false })] })?.answerStart).toBe('')
    expect(summarize({ messages: [user('oi')] })?.answerStart).toBe('')
  })

  it('resposta vazia é pulada em favor da anterior', () => {
    const s = summarize({ messages: [say('a boa', { answer: true }), say('  ', { answer: true })] })
    expect(s?.answerStart).toBe('a boa')
  })

  it('texto limpo: uma linha, [anexo], cortado em 200', () => {
    const s = summarize({ messages: [say(`Feito.\n\nVeja {{midia:2}}\n${'z'.repeat(400)}`, { answer: true })] })
    expect(s?.answerStart).toHaveLength(200)
    expect(s?.answerStart.startsWith('Feito. Veja [anexo] zzz')).toBe(true)
    expect(s?.answerStart.endsWith('…')).toBe(true)
  })
})

describe('summarizeConversation — updatedAt', () => {
  it('é o número do payload', () => {
    expect(summarize({ updatedAt: 1_234_567 })?.updatedAt).toBe(1_234_567)
  })

  it('sem número no payload, usa o ISO da linha (em ms)', () => {
    const iso = '2026-10-02T12:00:00.000Z'
    expect(summarize({ updatedAt: undefined }, { updatedAt: iso })?.updatedAt).toBe(Date.parse(iso))
    expect(summarize({ updatedAt: 'ontem' }, { updatedAt: iso })?.updatedAt).toBe(Date.parse(iso))
  })

  it('sem nenhum dos dois: 0', () => {
    expect(summarize({ updatedAt: undefined }, { updatedAt: undefined })?.updatedAt).toBe(0)
    expect(summarize({ updatedAt: undefined }, { updatedAt: 'lixo' })?.updatedAt).toBe(0)
  })
})

describe('summarizeConversation — sandbox', () => {
  it('o predicado define o flag; o resumo guarda a subpasta e se chama "sandbox"', () => {
    const sub = 'C:\\local\\sandbox\\2026-10-02_10-00_ab12'
    const isSandbox = vi.fn((cwd: string) => cwd.startsWith('C:\\local\\sandbox\\'))
    const s = summarizeConversation(conv({ cwd: sub }), isSandbox)
    expect(isSandbox).toHaveBeenCalledWith(sub)
    expect(s).toMatchObject({ sandbox: true, project: 'sandbox', cwd: sub })
    expect(summarizeConversation(conv({ cwd: CWD }), isSandbox)).toMatchObject({ sandbox: false, project: 'proj' })
  })

  it('arquivos do sandbox saem relativos à subpasta da conversa', () => {
    const sub = 'C:\\local\\sandbox\\2026-10-02_10-00_ab12'
    const s = summarizeConversation(
      conv({ cwd: sub, messages: [tool('Write', { file_path: `${sub}\\notas\\ideia.md` })] }),
      () => true
    )
    expect(s?.files).toEqual(['notas/ideia.md'])
  })
})

describe('summarizeConversation — o que não entra (devolve null)', () => {
  it('a Central, pelo modo', () => {
    expect(summarize({ id: 'qualquer', mode: 'central' })).toBeNull()
  })

  it('a Central, pelo id (do payload e da linha)', () => {
    expect(summarize({ id: 'central' })).toBeNull()
    expect(summarizeConversation({ id: 'central', payload: { cwd: CWD, messages: [] } }, notSandbox)).toBeNull()
    expect(summarizeConversation({ id: 'x', payload: { id: 'central', cwd: CWD, messages: [] } }, notSandbox)).toBeNull()
  })

  it('planejamento', () => {
    expect(summarize({ mode: 'planning', planningSlug: 'plano' })).toBeNull()
  })

  it('apagada (na linha ou no payload)', () => {
    expect(summarize({}, { deletedAt: '2026-10-01T00:00:00.000Z' })).toBeNull()
    expect(summarize({ deletedAt: '2026-10-01T00:00:00.000Z' })).toBeNull()
  })

  it('sem pasta (vazia, em branco, ausente ou que não é texto)', () => {
    expect(summarize({ cwd: '' })).toBeNull()
    expect(summarize({ cwd: '   ' })).toBeNull()
    expect(summarize({ cwd: undefined })).toBeNull()
    expect(summarize({ cwd: 123 })).toBeNull()
  })

  it('outras conversas com modo desconhecido continuam normais', () => {
    expect(summarize({ mode: 'outro' })).not.toBeNull()
    expect(summarize({ mode: undefined })).not.toBeNull()
  })

  it('payload malformado: pula sem lançar', () => {
    const bad: unknown[] = [
      { id: 'a', payload: null },
      { id: 'b', payload: [] },
      { id: 'c', payload: 'texto' },
      { id: 'd', payload: 7 },
      { id: 'e' },
      { id: 'f', payload: { cwd: CWD, messages: 'não é lista' } },
      { id: 'g', payload: { cwd: CWD, messages: { 0: user('x') } } },
      { id: '', payload: { cwd: CWD, messages: [] } },
      { payload: { cwd: CWD, messages: [] } },
      null,
      undefined,
      'linha',
      42
    ]
    for (const row of bad) {
      expect(() => summarizeConversation(row as VersionedConversationLike, notSandbox)).not.toThrow()
      expect(summarizeConversation(row as VersionedConversationLike, notSandbox)).toBeNull()
    }
  })

  it('mensagens soltas que não são objeto, ou com campos de tipo errado, são ignoradas', () => {
    const s = summarize({
      messages: [
        null,
        undefined,
        7,
        'texto',
        [],
        { kind: 'user' },
        { kind: 'user', text: 5 },
        { kind: 'tool-use', name: 'Write', input: { file_path: 9 } },
        { kind: 'assistant-text', text: { a: 1 }, answer: true },
        user('o pedido bom'),
        tool('Write', { file_path: inProj('bom.ts') }),
        say('a resposta boa', { answer: true })
      ]
    })
    expect(s).toMatchObject({ firstRequest: 'o pedido bom', files: ['bom.ts'], answerStart: 'a resposta boa' })
  })
})
