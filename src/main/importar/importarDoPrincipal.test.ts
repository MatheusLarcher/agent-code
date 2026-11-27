// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ImportadorPrincipal, pedidosDe } from './importarDoPrincipal'

/** Importador com a leitura da origem trocada por linhas prontas (sem Postgres). */
function montar(linhas: Array<{ id: string; payload: Record<string, unknown> }>, jaAqui: string[] = [], disponivel = true) {
  const gravadas: Array<{ id: string }> = []
  const repo = {
    loadConversations: vi.fn(async ({ ids }: { ids?: string[] }) => (ids ?? []).filter((id) => jaAqui.includes(id) || gravadas.some((g) => g.id === id)).map((id) => ({ id }))),
    upsertConversation: vi.fn(async (w: { id: string }) => {
      if (w.id === 'quebrada') throw new Error('documento inválido')
      gravadas.push({ id: w.id })
      return w
    })
  }
  const imp = new ImportadorPrincipal({
    origemPgdata: () => 'x',
    binDir: () => 'x',
    tmpDir: () => 'x',
    repositorio: () => repo as never,
    disponivel: () => disponivel
  })
  ;(imp as unknown as { lerOrigem: () => Promise<unknown> }).lerOrigem = async () => ({
    linhas: linhas.map((l) => ({ ...l, updated_at: '2026-11-26T21:00:00Z' })),
    memorias: new Map()
  })
  return { imp, repo, gravadas }
}

const conv = (id: string, title: string, pedidos: number) => ({
  id,
  payload: { title, cwd: 'C:\\proj', messages: Array.from({ length: pedidos }, () => ({ kind: 'user' })).concat([{ kind: 'assistant' }]) }
})

describe('importar do Agent Code original', () => {
  it('lista as conversas e marca as que já estão aqui', async () => {
    const { imp } = montar([conv('a', 'Relatório', 3), conv('b', 'Loja', 1)], ['b'])
    const r = await imp.listar()
    expect(r).toEqual({
      ok: true,
      conversas: [
        { id: 'a', titulo: 'Relatório', pasta: 'C:\\proj', atualizadaEm: '2026-11-26T21:00:00.000Z', pedidos: 3, jaExiste: false },
        { id: 'b', titulo: 'Loja', pasta: 'C:\\proj', atualizadaEm: '2026-11-26T21:00:00.000Z', pedidos: 1, jaExiste: true }
      ]
    })
  })

  it('importa as escolhidas, pula as que já existem e nunca sobrescreve', async () => {
    const { imp, repo } = montar([conv('a', 'A', 1), conv('b', 'B', 1), conv('c', 'C', 1)], ['b'])
    await imp.listar()
    const r = await imp.importar(['a', 'b'])
    expect(r).toEqual({ ok: true, importadas: 1, puladas: 1, falhas: [] })
    expect(repo.upsertConversation).toHaveBeenCalledTimes(1)
    expect(repo.upsertConversation.mock.calls[0][0]).toMatchObject({ id: 'a' })
    // de novo: agora 'a' também já existe
    expect(await imp.importar(['a'])).toEqual({ ok: true, importadas: 0, puladas: 1, falhas: [] })
  })

  it('uma conversa que falha não derruba as outras', async () => {
    const { imp } = montar([conv('quebrada', 'Q', 1), conv('ok', 'OK', 1)])
    await imp.listar()
    const r = await imp.importar(['quebrada', 'ok'])
    expect(r).toMatchObject({ ok: true, importadas: 1, falhas: [expect.stringContaining('Q: documento inválido')] })
  })

  it('sem listar antes, ou fora da Homol, não importa', async () => {
    const { imp } = montar([conv('a', 'A', 1)])
    expect((await imp.importar(['a'])).ok).toBe(false)
    const fora = montar([conv('a', 'A', 1)], [], false).imp
    expect(await fora.listar()).toMatchObject({ ok: false })
  })

  it('conta os pedidos pelas mensagens do usuário', () => {
    expect(pedidosDe({ messages: [{ kind: 'user' }, { kind: 'assistant' }, { kind: 'user' }] })).toBe(2)
    expect(pedidosDe({})).toBe(0)
  })
})
