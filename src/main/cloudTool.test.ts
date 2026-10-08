// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { CloudInspectionDto } from '../shared/databaseBackup'
import { runCloudTool, type CloudToolDeps } from './cloudTool'

const inspection: CloudInspectionDto = {
  action: 'ligar',
  local: { side: 'local', reachable: true, exists: true, conversations: 42, lastUpdate: '2026-10-08T09:00:00.000Z', serverVersion: '18.6' },
  cloud: { side: 'nuvem', reachable: true, exists: false, conversations: 0, lastUpdate: null, serverVersion: '16.4' },
  otherInstallations: [{ appVersion: '0.1.90', lastSeenAt: '2026-10-07T20:00:00.000Z' }],
  suggested: 'local',
  olderCloudServer: true,
  options: [
    { keep: 'local', copies: true, overwrites: 'nuvem', description: 'As conversas deste PC sobem para a nuvem.' },
    { keep: 'nuvem', copies: false, overwrites: null, description: 'O app passa a usar a nuvem como ela está.' }
  ]
}

function deps(target: 'local' | 'cloud' = 'local', overrides: Partial<CloudToolDeps> = {}): CloudToolDeps {
  return {
    current: async () => ({ target, saved: { host: 'salvo.exemplo', port: 5432, user: 'app', maintenanceDatabase: 'postgres', tlsMode: 'disable', ca: '' } }),
    readSecret: vi.fn(async (name: string) => (name === 'pg-nuvem' ? 's3nha-do-cofre' : null)),
    inspect: vi.fn(async () => inspection),
    testConnection: vi.fn(async () => undefined),
    schedule: vi.fn(),
    othersIdle: () => ({ ok: true, message: '' }),
    ...overrides
  }
}

describe('app_postgres_nuvem', () => {
  it('testar: devolve o que cada lado tem, os avisos, e manda PERGUNTAR o lado', async () => {
    const d = deps()
    const reply = await runCloudTool({ acao: 'testar', host: 'db.exemplo', senha: '{{secret:pg-nuvem}}' }, d)
    expect(reply.ok).toBe(true)
    expect(d.inspect).toHaveBeenCalledWith('ligar', expect.objectContaining({ host: 'db.exemplo', password: 's3nha-do-cofre', user: 'app' }))
    expect(reply.text).toContain('Local (este PC): 42 conversa(s)')
    expect(reply.text).toContain('banco agent-code ainda não existe')
    expect(reply.text).toMatch(/outro\(s\) PC\(s\)/)
    expect(reply.text).toMatch(/mais antigo que o 18/)
    expect(reply.text).toMatch(/PERGUNTE qual lado manter/)
    // O valor do cofre nunca volta para o modelo.
    expect(reply.text).not.toContain('s3nha-do-cofre')
  })

  it("ligar sem 'manter': recusado, nada agendado (o agente nunca escolhe sozinho)", async () => {
    const d = deps()
    const reply = await runCloudTool({ acao: 'ligar', host: 'db.exemplo' }, d)
    expect(reply.ok).toBe(false)
    expect(reply.text).toMatch(/'manter' é obrigatório/)
    expect(d.schedule).not.toHaveBeenCalled()
  })

  it('ligar com a senha do cofre: testa a conexão já e agenda a troca para depois do turno', async () => {
    const d = deps()
    const reply = await runCloudTool({ acao: 'ligar', host: 'db.exemplo', porta: 6502, senha: '{{secret:pg-nuvem}}', manter: 'local' }, d)
    expect(reply.ok).toBe(true)
    const draft = expect.objectContaining({ host: 'db.exemplo', port: 6502, password: 's3nha-do-cofre' })
    expect(d.testConnection).toHaveBeenCalledWith(draft)
    expect(d.schedule).toHaveBeenCalledWith({ action: 'ligar', keep: 'local', draft })
    expect(reply.text).toMatch(/Troca preparada.*Termine o turno agora/s)
    expect(reply.text).not.toMatch(/texto puro/)
  })

  it('senha em texto puro: segue, com o aviso para repassar uma vez', async () => {
    const reply = await runCloudTool({ acao: 'ligar', host: 'db.exemplo', senha: 'abc123', manter: 'nuvem' }, deps())
    expect(reply.ok).toBe(true)
    expect(reply.text).toMatch(/senha veio em texto puro no chat/)
  })

  it('segredo que não existe no cofre: recusado sem tocar em nada', async () => {
    const d = deps()
    const reply = await runCloudTool({ acao: 'ligar', senha: '{{secret:nao-existe}}', manter: 'local' }, d)
    expect(reply).toEqual({ ok: false, text: 'Não há segredo chamado "nao-existe" no cofre.' })
    expect(d.schedule).not.toHaveBeenCalled()
  })

  it('outra conversa no meio de um turno: recusado', async () => {
    const d = deps('local', { othersIdle: () => ({ ok: false, message: 'Conversa ocupada: c9.' }) })
    const reply = await runCloudTool({ acao: 'ligar', manter: 'local' }, d)
    expect(reply.ok).toBe(false)
    expect(reply.text).toMatch(/Troca recusada: Conversa ocupada: c9\./)
    expect(d.schedule).not.toHaveBeenCalled()
  })

  it('desligar mantendo os locais não precisa da nuvem (nem testa); ação fora do estado é recusada', async () => {
    const d = deps('cloud')
    expect((await runCloudTool({ acao: 'desligar', manter: 'local' }, d)).ok).toBe(true)
    expect(d.testConnection).not.toHaveBeenCalled()
    expect(d.schedule).toHaveBeenCalledWith({ action: 'desligar', keep: 'local' })
    const wrong = await runCloudTool({ acao: 'ligar', manter: 'local' }, deps('cloud'))
    expect(wrong).toMatchObject({ ok: false, text: expect.stringMatching(/já está ligada/) })
  })

  it('parâmetro estranho é recusado', async () => {
    expect((await runCloudTool({ acao: 'formatar' }, deps())).ok).toBe(false)
    expect((await runCloudTool({ acao: 'testar', banco: 'x' }, deps())).ok).toBe(false)
  })
})
