import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { loadConversationSeed, seedEntriesFromMessages, userRequestFromPrompt, type SessionMessagesLoader } from './conversationSeed'

const STAMP = '[Contexto do sistema: mensagem enviada do PC MAQ em 15/10/2026, 10:00:00 (America/Sao_Paulo).]'

function prompt(...parts: string[]): string {
  return [STAMP, ...parts].join('\n\n')
}

function msg(type: SessionMessage['type'], message: unknown, parent: string | null = null): SessionMessage {
  return { type, uuid: `u-${Math.random()}`, session_id: 's1', message, parent_tool_use_id: parent, parent_agent_id: null }
}

describe('userRequestFromPrompt', () => {
  it('tira o carimbo e os blocos de contexto, fica só o pedido', () => {
    const text = prompt(
      '[PERSISTENT_MEMORY_UPDATE]\nindice novo\n[/PERSISTENT_MEMORY_UPDATE]',
      '[SKILL_CATALOG_UPDATE]\n- skill\n[/SKILL_CATALOG_UPDATE]',
      '[PROJECTS_ON_THIS_MACHINE]\nC:\\x\n[/PROJECTS_ON_THIS_MACHINE]',
      '[OUTRAS_CONVERSAS]\nnada\n[/OUTRAS_CONVERSAS]',
      'arruma o login\n\ne roda os testes'
    )
    expect(userRequestFromPrompt(text)).toBe('arruma o login\n\ne roda os testes')
  })

  it('sem carimbo não é pedido (resultado de ferramenta, resumo de compactação)', () => {
    expect(userRequestFromPrompt('This session is being continued...')).toBeNull()
    expect(userRequestFromPrompt(`${STAMP}`)).toBeNull()
  })

  it('memória injetada sai pelo corpo em disco, mesmo com linhas em branco dentro', () => {
    const body = 'linha 1\n\nlinha 2'
    const text = prompt(`--- Memória relevante: a/b.md ---\n${body}`, 'qual a porta do servidor?')
    expect(userRequestFromPrompt(text, (rel) => (rel === 'a/b.md' ? body : null))).toBe('qual a porta do servidor?')
  })

  it('memória que mudou desde o envio é cortada até o próximo bloco; sem bloco depois, a mensagem fica de fora', () => {
    const changed = prompt('--- Memória relevante: a.md ---\nvelho\n\nvelho 2', '--- Memória relevante: b.md ---\nb', '[SKILL_CATALOG_UPDATE]\nx\n[/SKILL_CATALOG_UPDATE]', 'pedido')
    expect(userRequestFromPrompt(changed, (rel) => (rel === 'b.md' ? 'b' : 'novo'))).toBe('pedido')
    const last = prompt('--- Memória relevante: a.md ---\nvelho', 'pedido')
    expect(userRequestFromPrompt(last, () => 'novo')).toBeNull()
  })

  it('desembrulha a visão e tira as notas do sistema', () => {
    const vision = 'Mensagem original do usuário:\no que tem na tela?\n\nContexto visual extraído:\n[VISUAL_CONTEXT]\nbotão azul\n[/VISUAL_CONTEXT]\n\nAgora responda considerando a análise visual acima.'
    expect(userRequestFromPrompt(prompt(vision))).toBe('o que tem na tela?')
    const onlyImage = vision.replace('o que tem na tela?', '(sem texto — apenas a(s) imagem(ns) anexada(s))')
    expect(userRequestFromPrompt(prompt(onlyImage))).toBeNull()
    const failed = 'veja a imagem\n\n[Observação do sistema: não foi possível analisar a(s) imagem(ns) anexada(s) automaticamente (Error: x). Responda com base apenas no texto acima.]'
    expect(userRequestFromPrompt(prompt(failed))).toBe('veja a imagem')
    const notes =
      '[Scrum Master] Este envio foi parado às 10:00 por: Scrum Master: loop. Antes de seguir, confira o estado dos arquivos que você estava editando.\n\n' +
      '[Observação do sistema: o usuário CANCELOU manualmente a solicitação anterior e a resposta parcial a ela. Desconsidere — e atenda apenas à mensagem a seguir.]\n\n' +
      'faz outra coisa'
    expect(userRequestFromPrompt(prompt(notes))).toBe('faz outra coisa')
  })

  it('continuação de provedor (só bloco, sem texto) não vira pedido', () => {
    expect(userRequestFromPrompt(prompt('[PROVIDER_CONTINUATION]\ncontinue\n[/PROVIDER_CONTINUATION]'))).toBeNull()
  })
})

describe('seedEntriesFromMessages', () => {
  it('usuário e texto do assistente principal, sem ferramenta, pensamento, subagente nem sistema', () => {
    const entries = seedEntriesFromMessages([
      msg('system', { subtype: 'init' }),
      msg('user', { role: 'user', content: prompt('primeiro pedido') }),
      msg('assistant', { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'vou olhar' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] }),
      msg('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'conteúdo do arquivo' }] }),
      msg('assistant', { role: 'assistant', content: [{ type: 'text', text: 'do subagente' }] }, 't9'),
      msg('user', { role: 'user', content: prompt('do subagente') }, 't9'),
      msg('user', { role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'midia:1 = a.png' }, { type: 'text', text: prompt('com imagem') }] }),
      msg('assistant', { role: 'assistant', content: [{ type: 'text', text: 'pronto' }] })
    ])
    expect(entries).toEqual([
      { role: 'user', text: 'primeiro pedido' },
      { role: 'assistant', text: 'vou olhar' },
      { role: 'user', text: 'com imagem' },
      { role: 'assistant', text: 'pronto' }
    ])
  })
})

describe('loadConversationSeed', () => {
  it('lê a transcrição local da pasta do projeto e reconhece a memória pelo disco', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-'))
    try {
      writeFileSync(join(dir, 'm.md'), 'corpo da memória\n')
      const loader = vi.fn(async () => [msg('user', { role: 'user', content: prompt('--- Memória relevante: m.md ---\ncorpo da memória', 'oi') })])
      const entries = await loadConversationSeed({ sessionId: 's1', cwd: 'C:\\proj', memoriesDir: dir, loader: loader as unknown as SessionMessagesLoader })
      expect(entries).toEqual([{ role: 'user', text: 'oi' }])
      expect(loader).toHaveBeenCalledWith('s1', { dir: 'C:\\proj' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sem nada local, tenta o store da sessão', async () => {
    const store = {} as never
    const loader = vi.fn(async (_id: string, opts?: { sessionStore?: unknown }) =>
      opts?.sessionStore ? [msg('assistant', { role: 'assistant', content: [{ type: 'text', text: 'do store' }] })] : []
    )
    const entries = await loadConversationSeed({ sessionId: 's1', cwd: 'C:\\proj', sessionStore: store, loader: loader as unknown as SessionMessagesLoader })
    expect(entries).toEqual([{ role: 'assistant', text: 'do store' }])
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('loader que lança ou devolve lixo vira resumo vazio, sem lançar', async () => {
    const throws = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    await expect(loadConversationSeed({ sessionId: 's1', cwd: 'x', loader: throws as unknown as SessionMessagesLoader })).resolves.toEqual([])
    const junk = vi.fn(async () => [null, { type: 'user', message: 42 }] as unknown as SessionMessage[])
    await expect(loadConversationSeed({ sessionId: 's1', cwd: 'x', loader: junk as unknown as SessionMessagesLoader })).resolves.toEqual([])
  })
})
