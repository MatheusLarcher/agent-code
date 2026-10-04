import { describe, expect, it } from 'vitest'
import { Channels } from '../../shared/ipc'
import type { MemoryEntry } from '../persistence/types'
import { registerMemoryReadIpc } from './memoryReadIpc'

const entry = (relPath: string, extra: Partial<MemoryEntry> = {}): MemoryEntry =>
  ({ id: relPath, relPath, title: `T ${relPath}`, hook: 'gancho', scope: 'user', projectCwd: null, domain: null, body: 'corpo', bodyHash: 'h', revision: 2, status: 'active', supersedesId: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', ...extra }) as MemoryEntry

function setup(entries: (() => Promise<MemoryEntry[]> | null) = () => Promise.resolve([entry('2D/vps.md', { body: 'senha: {{secret:vps_2d}}', scope: 'project', projectCwd: 'C:\\p' }), entry('raiz.md', { status: 'retired' })])) {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  registerMemoryReadIpc({ handle: (c, h) => void handlers.set(c, h), entries })
  return (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args)
}

describe('IPC só de leitura do painel de Memórias', () => {
  it('a lista sem o corpo, com a pasta, o alcance, a revisão e o estado', async () => {
    const call = setup()
    expect(await call(Channels.memoryListEntries)).toEqual([
      { relPath: '2D/vps.md', title: 'T 2D/vps.md', hook: 'gancho', folder: '2D', scope: 'project', projectCwd: 'C:\\p', revision: 2, status: 'active', updatedAt: '2026-10-02T00:00:00Z' },
      { relPath: 'raiz.md', title: 'T raiz.md', hook: 'gancho', folder: '', scope: 'user', projectCwd: null, revision: 2, status: 'retired', updatedAt: '2026-10-02T00:00:00Z' }
    ])
  })

  it('o texto de uma: o segredo fica só como marca; entrada inválida e serviço fora do ar não lançam', async () => {
    const call = setup()
    expect(await call(Channels.memoryReadEntry, '2D/vps.md')).toEqual({ relPath: '2D/vps.md', body: 'senha: {{secret:vps_2d}}' })
    expect(await call(Channels.memoryReadEntry, 'nao-existe.md')).toBeNull()
    for (const bad of [42, '', 'x'.repeat(600), 'a\0b']) expect(await call(Channels.memoryReadEntry, bad)).toBeNull()
    const offline = setup(() => null)
    expect(await offline(Channels.memoryListEntries)).toEqual([])
    const broken = setup(() => Promise.reject(new Error('banco caiu')))
    expect(await broken(Channels.memoryListEntries)).toEqual([])
    expect(await broken(Channels.memoryReadEntry, 'raiz.md')).toBeNull()
  })
})
