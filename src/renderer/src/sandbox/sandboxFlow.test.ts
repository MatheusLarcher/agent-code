import { describe, expect, it } from 'vitest'
import { DEFAULT_TITLE, type Conversation } from '../types'
import {
  findBlankSandboxConversation,
  type GroupableProject,
  groupSidebarProjects,
  isSandboxCwd,
  newChatTarget,
  shouldOpenSandboxOnBoot,
  SANDBOX_PROJECT_NAME
} from './sandboxFlow'

const ROOT = 'C:\\Users\\m\\AppData\\Roaming\\agent-code-desktop\\agent-code-local\\sandbox'

function conv(id: string, cwd: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: DEFAULT_TITLE,
    cwd,
    model: 'claude-opus-5-5',
    sdkSessionId: null,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...extra
  } as Conversation
}

const withMessage = { messages: [{ id: 'm', role: 'user', text: 'oi' }] } as unknown as Partial<Conversation>

describe('isSandboxCwd', () => {
  it('subpasta sim, raiz não, fora não, caixa e barras indiferentes, .. resolvido', () => {
    expect(isSandboxCwd(ROOT, `${ROOT}\\a`)).toBe(true)
    expect(isSandboxCwd(ROOT, ROOT)).toBe(false)
    expect(isSandboxCwd(ROOT, 'C:\\GitHub\\x')).toBe(false)
    expect(isSandboxCwd(ROOT, `${ROOT.toUpperCase()}/A`)).toBe(true)
    expect(isSandboxCwd(ROOT, `${ROOT}\\a\\..\\..\\fora`)).toBe(false)
    expect(isSandboxCwd(ROOT, `${ROOT}-x\\a`)).toBe(false)
    expect(isSandboxCwd('', `${ROOT}\\a`)).toBe(false)
  })
})

describe('shouldOpenSandboxOnBoot', () => {
  it('primeiro uso (nenhuma conversa) abre o sandbox', () => {
    expect(shouldOpenSandboxOnBoot([])).toBe(true)
  })
  it('com conversas não abre', () => {
    expect(shouldOpenSandboxOnBoot([conv('a', 'C:\\x')])).toBe(false)
  })
})

describe('newChatTarget', () => {
  it('sem conversa ativa vai para o sandbox', () => {
    expect(newChatTarget(null, ROOT)).toBe('sandbox')
  })
  it('ativa sem pasta vai para o sandbox', () => {
    expect(newChatTarget(conv('a', ''), ROOT)).toBe('sandbox')
  })
  it('a partir de uma conversa de sandbox vai para o sandbox', () => {
    expect(newChatTarget(conv('a', `${ROOT}\\x`), ROOT)).toBe('sandbox')
  })
  it('conversa de pasta real continua na pasta', () => {
    expect(newChatTarget(conv('a', 'C:\\GitHub\\p'), ROOT)).toEqual({ folder: 'C:\\GitHub\\p' })
  })
})

describe('findBlankSandboxConversation', () => {
  it('reaproveita a vazia de qualquer subpasta do sandbox, preferindo a ativa', () => {
    const list = [
      conv('real', 'C:\\GitHub\\p'),
      conv('cheia', `${ROOT}\\1`, withMessage),
      conv('vazia1', `${ROOT}\\2`),
      conv('vazia2', `${ROOT}\\3`)
    ]
    expect(findBlankSandboxConversation(list, ROOT)?.id).toBe('vazia1')
    expect(findBlankSandboxConversation(list, ROOT, 'vazia2')?.id).toBe('vazia2')
  })
  it('sem vazia no sandbox → undefined (subpasta nova)', () => {
    const list = [conv('real', 'C:\\GitHub\\p'), conv('cheia', `${ROOT}\\1`, withMessage)]
    expect(findBlankSandboxConversation(list, ROOT)).toBeUndefined()
  })
})

describe('groupSidebarProjects', () => {
  const project = (path: string, conversations: Conversation[], total?: number): GroupableProject => ({
    path,
    name: path.split('\\').pop() ?? path,
    conversations,
    total
  })

  it('junta as subpastas do sandbox num projeto "Sandbox" no topo', () => {
    const a = conv('a', `${ROOT}\\1`, { updatedAt: 5 })
    const b = conv('b', `${ROOT}\\2`, { updatedAt: 9 })
    const out = groupSidebarProjects(
      [project('C:\\GitHub\\p', [conv('p', 'C:\\GitHub\\p')]), project(`${ROOT}\\1`, [a], 1), project(`${ROOT}\\2`, [b], 1)],
      ROOT
    )
    expect(out.map((p) => p.name)).toEqual([SANDBOX_PROJECT_NAME, 'p'])
    expect(out[0].sandbox).toBe(true)
    expect(out[0].path).toBe(ROOT)
    expect(out[0].conversations.map((c) => c.id)).toEqual(['b', 'a'])
    expect(out[0].total).toBe(2)
  })

  it('o "Sandbox" aparece mesmo vazio', () => {
    const out = groupSidebarProjects([project('C:\\GitHub\\p', [conv('p', 'C:\\GitHub\\p')])], ROOT)
    expect(out[0]).toMatchObject({ name: SANDBOX_PROJECT_NAME, sandbox: true, conversations: [] })
    expect(out).toHaveLength(2)
  })

  it('sem raiz conhecida não mexe na lista', () => {
    const list = [project('C:\\GitHub\\p', [])]
    expect(groupSidebarProjects(list, '')).toEqual(list)
  })
})
