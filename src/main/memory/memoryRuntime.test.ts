// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { configureMemoryRuntime, memoryService } from './memoryRuntime'

// O runtime lê a pasta do store; nos testes ela é sempre temporária.
vi.mock('../store', () => ({ getCacheInfo: () => ({ memoriesDir: '' }) }))
vi.mock('../config', () => ({ loadConfig: () => ({}) }))

const roots: string[] = []
const repositories: SqliteRepository[] = []
afterEach(async () => {
  configureMemoryRuntime(null)
  await Promise.all(repositories.splice(0).map((repo) => repo.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-memory-runtime-'))
  roots.push(root)
  const directory = join(root, 'memories')
  await mkdir(directory)
  const repository = new SqliteRepository(root, join(root, 'fixture.db'), 'runtime-test-device')
  repositories.push(repository)
  await repository.initialize()
  return { root, directory, repository }
}

/**
 * A adoção é assíncrona de propósito (não bloqueia o boot), então o teste espera
 * pela contagem ESPERADA. Esperar "qualquer entrada" retorna no meio da
 * importação e o teste reprova por corrida dele mesmo, não do código.
 */
async function settled(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const entries = await memoryService()?.listEntries({ status: 'active' })
    if ((entries?.length ?? 0) >= expected) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('configureMemoryRuntime — adoção do acervo em disco', () => {
  it('adota arquivo já existente na ligação, sem depender de um propose', async () => {
    const { directory, repository } = await fixture()
    // Acervo que já estava no disco antes de existir banco — o caso do usuário real.
    await writeFile(join(directory, 'licao.md'), '# Lição\nCorpo original', 'utf8')
    await mkdir(join(directory, '2D'))
    await writeFile(join(directory, '2D', 'nota.md'), '# Nota\nDentro da subpasta', 'utf8')
    await writeFile(
      join(directory, 'MEMORY.md'),
      '- [Lição](licao.md) — gancho curado\n\n## 2D — grupo\n\n- [Nota](2D/nota.md) — gancho do grupo\n',
      'utf8'
    )

    configureMemoryRuntime(repository, directory)
    await settled(2)

    const entries = await memoryService()!.listEntries({ status: 'active' })
    expect(entries.map((entry) => entry.relPath).sort()).toEqual(['2D/nota.md', 'licao.md'])
    // Metadados curados do índice vencem o resumo derivado do corpo.
    expect(entries.find((entry) => entry.relPath === 'licao.md')?.hook).toBe('gancho curado')
    // Corpo intocado: importar não é reescrever.
    expect(await readFile(join(directory, 'licao.md'), 'utf8')).toBe('# Lição\nCorpo original')
    // Título de seção escrito à mão sobrevive à regeneração do índice.
    expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toContain('## 2D — grupo')
  })

  it('não importa de novo ao religar o mesmo repositório', async () => {
    const { directory, repository } = await fixture()
    await writeFile(join(directory, 'unica.md'), '# Única\nCorpo', 'utf8')

    configureMemoryRuntime(repository, directory)
    await settled(1)
    const first = await memoryService()!.listEntries({ status: 'active' })

    // Uma troca de backend religa o runtime; a adoção precisa ser idempotente.
    configureMemoryRuntime(repository, directory)
    await settled(1)
    const second = await memoryService()!.listEntries({ status: 'active' })

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(second[0].revision).toBe(first[0].revision)
  })

  it('falha da adoção não derruba o boot nem deixa o serviço sem função', async () => {
    const { directory, repository } = await fixture()
    vi.spyOn(repository, 'listMemoryEntries').mockRejectedValueOnce(new Error('banco caiu'))
    const logged: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => void logged.push(args))

    // Abrir o app é o que não pode falhar: importar memória se recupera na próxima passada.
    expect(() => configureMemoryRuntime(repository, directory)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(memoryService()).not.toBeNull()
    expect(logged.length).toBeGreaterThan(0)
    spy.mockRestore()
  })
})
