// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryProposeInput } from '../memory/memoryModel'
import { lerCampos } from '../memoria/cabecalho'
import { caminhoKebab, estadoInicial, jaccard, normalizarCorpo, rodarImportacao, type DepsImportacao, type EstadoImportacao } from './importacaoAutomatica'
import type { LeituraOrigem } from './importarDoPrincipal'

const raiz = mkdtempSync(join(tmpdir(), 'importacao-'))
afterAll(() => rmSync(raiz, { recursive: true, force: true }))
const origemMem = join(raiz, 'memories')
const mem = (rel: string, txt: string): void => {
  mkdirSync(join(origemMem, rel, '..'), { recursive: true })
  writeFileSync(join(origemMem, rel), txt)
}
mem('agent-code/push-github.md', '---\ndescription: ao subir\n---\n# Push no GitHub\nUsar a conta erickxc para subir o agent-code.\n')
mem('regras/Datas Brasil.md', '# Datas\nSempre dd/mm/aaaa nas telas e relatórios do usuário.\n')
mem('opti/darj.md', '# DARJ\nTexto da origem sobre a tela do darj lenta.\n')

const conv = (id: string, title: string, at: string) => ({ id, payload: { title, messages: [{ kind: 'user' }] }, updated_at: at })

/** Banco "daqui" de mentira com revisão por conversa. */
function montar(origem: LeituraOrigem, aqui: Record<string, { revision: number; deletedAt?: string }>, estado: EstadoImportacao, memAqui: Array<{ relPath: string; body: string }> = []) {
  const banco = new Map(Object.entries(aqui).map(([id, v]) => [id, { id, ...v }]))
  const repo = {
    loadConversations: vi.fn(async ({ ids }: { ids?: string[] }) => (ids ?? []).filter((id) => banco.has(id)).map((id) => banco.get(id)!)),
    upsertConversation: vi.fn(async (w: { id: string; expectedRevision?: number }) => {
      const atual = banco.get(w.id)
      if (w.expectedRevision !== undefined && atual && atual.revision !== w.expectedRevision) throw new Error('conflito de revisão')
      const novo = { id: w.id, revision: (atual?.revision ?? 0) + 1 }
      banco.set(w.id, novo)
      return novo
    })
  }
  const propostas: MemoryProposeInput[] = []
  let gravado = estado
  const deps: DepsImportacao = {
    lerOrigem: async () => origem,
    repositorio: () => repo as never,
    memoria: () => ({
      listEntries: async () => memAqui.map((m) => ({ ...m, status: 'active' })),
      propose: async (i) => void propostas.push(i),
      applyPending: async () => undefined
    }),
    origemMemorias: () => origemMem,
    marcaOrigem: () => 'marca-1',
    sanitize: async (i) => i,
    lerEstado: async () => JSON.parse(JSON.stringify(gravado)),
    gravarEstado: async (e) => void (gravado = e),
    now: () => Date.parse('2026-11-27T15:00:00Z')
  }
  return { deps, repo, propostas, estado: () => gravado, banco }
}

describe('importação automática', () => {
  it('traz as conversas novas e as memórias que elas usaram, sem duplicar', async () => {
    const origem: LeituraOrigem = {
      linhas: [conv('a', 'Relatório', '2026-11-26T10:00:00Z')],
      memorias: new Map([['a', new Set(['agent-code/push-github.md', 'regras/Datas Brasil.md', 'nao-existe.md'])]])
    }
    // "Datas" já existe aqui com outro caminho e o mesmo texto: não duplica.
    const { deps, propostas, estado } = montar(origem, {}, estadoInicial(), [{ relPath: 'geral/datas.md', body: '# Datas\nSempre dd/mm/aaaa nas telas e relatórios do usuário.\n' }])
    const r = await rodarImportacao(deps)
    expect(r).toMatchObject({ status: 'feita', novas: ['Relatório'], memoriasJaExistiam: 1, memoriasNovas: ['agent-code/push-github.md'] })
    expect(propostas).toHaveLength(1)
    expect(propostas[0]).toMatchObject({ op: 'create', proposedBy: 'importacao' })
    expect(lerCampos(propostas[0].body!)).toMatchObject({ origem: 'importada do Agent Code', tema: 'agent-code' })
    expect(estado().conversas.a).toEqual({ origemEm: '2026-11-26T10:00:00.000Z', revisao: 1 })
  })

  it('atualiza a conversa que mudou lá e não foi mexida aqui; mexida nos dois = conflito, a daqui fica', async () => {
    const origem: LeituraOrigem = {
      linhas: [conv('a', 'Intocada', '2026-11-27T10:00:00Z'), conv('b', 'Mexida aqui', '2026-11-27T10:00:00Z')],
      memorias: new Map()
    }
    const est: EstadoImportacao = {
      ligado: true,
      conversas: { a: { origemEm: '2026-11-26T10:00:00Z', revisao: 3 }, b: { origemEm: '2026-11-26T10:00:00Z', revisao: 3 } }
    }
    const { deps, repo } = montar(origem, { a: { revision: 3 }, b: { revision: 5 } }, est)
    const r = await rodarImportacao(deps)
    expect(r.atualizadas).toEqual(['Intocada'])
    expect(r.conflitos).toEqual(['Mexida aqui'])
    expect(repo.upsertConversation).toHaveBeenCalledTimes(1)
    expect(repo.upsertConversation.mock.calls[0][0]).toMatchObject({ id: 'a', expectedRevision: 3 })
  })

  it('conversa apagada aqui não volta; memória com o mesmo caminho e texto diferente não é sobrescrita', async () => {
    const origem: LeituraOrigem = {
      linhas: [conv('apagada', 'Apagada', '2026-11-27T10:00:00Z'), conv('nova', 'Nova', '2026-11-27T10:00:00Z')],
      memorias: new Map([['nova', new Set(['opti/darj.md'])]])
    }
    const { deps, repo, propostas } = montar(origem, { apagada: { revision: 1, deletedAt: '2026-11-27T09:00:00Z' } }, estadoInicial(), [
      { relPath: 'opti/darj.md', body: '# DARJ\nVersão daqui, diferente.\n' }
    ])
    const r = await rodarImportacao(deps)
    expect(r.novas).toEqual(['Nova'])
    expect(r.memoriasDiferentes).toEqual(['opti/darj.md'])
    expect(propostas).toHaveLength(0)
    expect(repo.upsertConversation.mock.calls.map((c) => c[0].id)).toEqual(['nova'])
  })

  it('zona morta: origem sem mudança não é lida; desligada não faz nada', async () => {
    const origem: LeituraOrigem = { linhas: [conv('a', 'A', '2026-11-27T10:00:00Z')], memorias: new Map() }
    const parada = montar(origem, {}, { ...estadoInicial(), origemMarca: 'marca-1' })
    const ler = vi.spyOn(parada.deps, 'lerOrigem')
    expect((await rodarImportacao(parada.deps)).status).toBe('sem-mudanca')
    expect(ler).not.toHaveBeenCalled()
    expect((await rodarImportacao(montar(origem, {}, { ...estadoInicial(), ligado: false }).deps)).status).toBe('desligada')
  })

  it('auxiliares: caminho em kebab, corpo comparável, semelhança', () => {
    expect(caminhoKebab('Regras/Datas Brasil.md')).toBe('regras/datas-brasil.md')
    expect(normalizarCorpo('---\nx: 1\n---\n# Título  Ação\n')).toBe('# titulo acao')
    expect(jaccard('usar conta erickxc github', 'usar a conta erickxc no github')).toBeGreaterThan(0.85)
  })
})
