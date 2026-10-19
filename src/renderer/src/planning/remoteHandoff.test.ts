import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type AppConfig } from '@shared/ipc'
import { managerHandoffRequest, type HandoffSendOutcome } from './handoffFlow'
import {
  findManagerConversation,
  RecentHandoffs,
  REMOTE_RESEND_GUARD_MS,
  runRemoteHandoff,
  runRemoteHandoffGenerate,
  runRemotePlanningAction,
  type RemoteHandoffAction,
  type RemoteHandoffDeps
} from './remoteHandoff'

const CWD = 'C:\\proj\\alfa'
const SENT: HandoffSendOutcome = { status: 'sent', delivered: 2, total: 2, conversation: { id: 'impl', title: 'Implementação: Site' } }
const ACTION: RemoteHandoffAction = {
  type: 'handoff',
  cwd: CWD,
  slug: 'site',
  titulo: 'Site',
  prompts: [
    { name: '2026-10-19-01.md', text: 'um' },
    { name: '2026-10-19-02.md', text: 'dois' }
  ]
}

function deps(over: Partial<RemoteHandoffDeps> = {}, config: Partial<AppConfig> = DEFAULT_CONFIG): RemoteHandoffDeps & {
  startHandoff: ReturnType<typeof vi.fn>
  ask: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  mark: ReturnType<typeof vi.fn>
} {
  const mark = vi.fn(async () => ({ ok: true as const, sent: [] }))
  return {
    api: { getConfig: vi.fn(async () => config as AppConfig), planningMarkHandoffsSent: mark },
    startHandoff: vi.fn(async () => SENT),
    projectFastMode: () => true,
    managerOf: () => 'pm',
    ask: vi.fn(),
    notify: vi.fn(),
    mark,
    ...over
  } as never
}

describe('runRemoteHandoff', () => {
  it('roda o startHandoff com os prompts e os nomes, na ordem, e registra o entregue em enviados.json', async () => {
    const d = deps()
    await runRemoteHandoff(ACTION, d, new RecentHandoffs())
    expect(d.startHandoff).toHaveBeenCalledWith(CWD, 'site', 'Site', ['um', 'dois'], ['2026-10-19-01.md', '2026-10-19-02.md'])
    expect(d.mark).toHaveBeenCalledWith({
      projectCwd: CWD,
      slug: 'site',
      entries: [
        { nome: '2026-10-19-01.md', conversaId: 'impl', conversaTitulo: 'Implementação: Site' },
        { nome: '2026-10-19-02.md', conversaId: 'impl', conversaTitulo: 'Implementação: Site' }
      ]
    })
    expect(d.notify).toHaveBeenCalledWith('sucesso', expect.stringContaining('Plano enviado'))
  })

  it('com "Leitura guiada", o Fast mode vai no padrão do diálogo (modelo do Manager + projeto)', async () => {
    const config = { ...DEFAULT_CONFIG, handoff: { ...DEFAULT_CONFIG.handoff, leituraGuiada: true }, planning: { ...DEFAULT_CONFIG.planning, model: 'claude-opus-4-6' } }
    const d = deps({}, config)
    await runRemoteHandoff(ACTION, d, new RecentHandoffs())
    expect(d.startHandoff.mock.calls[0]).toHaveLength(6)
  })

  it('duplo toque: o mesmo prompt não sai de novo dentro da janela; depois dela, sai', async () => {
    let t = 1000
    const guard = new RecentHandoffs(() => t)
    const d = deps()
    await runRemoteHandoff(ACTION, d, guard)
    await runRemoteHandoff(ACTION, d, guard)
    expect(d.startHandoff).toHaveBeenCalledTimes(1)
    expect(d.notify).toHaveBeenLastCalledWith('aviso', expect.stringContaining('acabou de sair'))
    t += REMOTE_RESEND_GUARD_MS + 1
    await runRemoteHandoff(ACTION, d, guard)
    expect(d.startHandoff).toHaveBeenCalledTimes(2)
  })

  it('nada criado: libera a trava e avisa; criado com falha: marca só o entregue e avisa a falha', async () => {
    const guard = new RecentHandoffs()
    const none = deps({ startHandoff: vi.fn(async () => ({ status: 'not-created', delivered: 0, total: 0 }) as HandoffSendOutcome) })
    await runRemoteHandoff(ACTION, none, guard)
    expect(none.notify).toHaveBeenCalledWith('erro', expect.stringContaining('Nada foi enviado'))
    expect(guard.claim(CWD, 'site', ['2026-10-19-01.md'])).toBe(true)

    const partial = deps({
      startHandoff: vi.fn(async () => ({ status: 'created-failed', delivered: 1, total: 2, conversation: { id: 'impl', title: 'Impl' } }) as HandoffSendOutcome)
    })
    await runRemoteHandoff(ACTION, partial, new RecentHandoffs())
    expect(partial.mark.mock.calls[0][0].entries).toEqual([{ nome: '2026-10-19-01.md', conversaId: 'impl', conversaTitulo: 'Impl' }])
    expect(partial.notify).toHaveBeenCalledWith('erro', expect.stringContaining('parou no prompt 2 de 2'))
  })
})

describe('runRemoteHandoffGenerate', () => {
  it('manda ao Manager do plano EXATAMENTE o managerHandoffRequest do PC', async () => {
    const d = deps()
    await runRemoteHandoffGenerate({ type: 'handoff-generate', cwd: CWD, slug: 'site', planDir: 'D:\\planos\\site', openAmbiguities: 2, mediaCount: 1 }, d)
    expect(d.ask).toHaveBeenCalledWith('pm', managerHandoffRequest('D:\\planos\\site', 2, 1, DEFAULT_CONFIG.handoff))
  })

  it('sem a conversa do Manager: avisa e não manda nada', async () => {
    const d = deps({ managerOf: () => null })
    await runRemoteHandoffGenerate({ type: 'handoff-generate', cwd: CWD, slug: 'site', planDir: 'x', openAmbiguities: 0, mediaCount: 0 }, d)
    expect(d.ask).not.toHaveBeenCalled()
    expect(d.notify).toHaveBeenCalledWith('erro', expect.any(String))
  })
})

describe('runRemotePlanningAction e findManagerConversation', () => {
  it('só trata as ações de handoff', () => {
    expect(runRemotePlanningAction({ type: 'rename', convId: 'c', title: 't' }, deps())).toBe(false)
  })

  it('acha a conversa do Manager mais recente do plano (projeto + slug)', () => {
    const convs = [
      { id: 'a', cwd: CWD, mode: 'planning' as const, planningSlug: 'site', updatedAt: 1 },
      { id: 'b', cwd: CWD, mode: 'planning' as const, planningSlug: 'site', updatedAt: 5 },
      { id: 'c', cwd: CWD, mode: 'planning' as const, planningSlug: 'outro', updatedAt: 9 },
      { id: 'd', cwd: CWD, updatedAt: 10 }
    ]
    expect(findManagerConversation(convs, CWD, 'site')?.id).toBe('b')
    expect(findManagerConversation(convs, 'C:\\outro', 'site')).toBeNull()
  })
})
