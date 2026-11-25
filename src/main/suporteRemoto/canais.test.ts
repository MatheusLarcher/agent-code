// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Channels, DEFAULT_CONFIG, type AppConfig } from '../../shared/ipc'
import type { SuporteAjustes } from '../../shared/suporteRemoto'
import { CHAVE_DE_TESTE } from './relayFalso.testkit'

const estado = vi.hoisted(() => ({ config: {} as Record<string, unknown> }))
vi.mock('../config', () => ({ loadConfig: () => estado.config }))

import { configParaATela, patchDosAjustes, patchSemSuporte, registrarCanaisDoSuporte } from './canais'
import { suporteRemoto } from './runtime'

const ajustes = (parcial: Partial<SuporteAjustes> = {}): SuporteAjustes => ({ ativado: false, tecnico: '', temChave: false, ...parcial })

beforeEach(() => {
  estado.config = { suporteRemotoEnabled: false, suporteRemotoTecnico: '', suporteRemotoChave: '' }
})

describe('suporte remoto: a chave da equipe e a config', () => {
  it('a config que vai à tela nunca leva a chave', () => {
    const config = { ...DEFAULT_CONFIG, suporteRemotoEnabled: true, suporteRemotoChave: CHAVE_DE_TESTE } as AppConfig
    const naTela = configParaATela(config)
    expect(naTela.suporteRemotoChave).toBe('')
    expect(JSON.stringify(naTela)).not.toContain(CHAVE_DE_TESTE)
    expect(naTela.suporteRemotoEnabled).toBe(true)
    // E a config de verdade não é alterada.
    expect(config.suporteRemotoChave).toBe(CHAVE_DE_TESTE)
  })

  it('o `config:set` genérico não mexe em nenhum campo do suporte', () => {
    const patch = { skipPermissions: true, suporteRemotoEnabled: true, suporteRemotoChave: 'x'.repeat(30), suporteRemotoTecnico: 'Mal' }
    expect(patchSemSuporte(patch)).toEqual({ skipPermissions: true })
    expect(patchSemSuporte(null)).toBeNull()
  })
})

describe('suporte remoto: validação dos ajustes', () => {
  it('sem chave, o interruptor não liga', () => {
    expect(patchDosAjustes(ajustes(), { ativado: true })).toMatchObject({ ok: false, mensagem: expect.stringContaining('chave da equipe') })
  })

  it('com a chave já salva, liga; chave e interruptor podem vir juntos', () => {
    expect(patchDosAjustes(ajustes({ temChave: true }), { ativado: true })).toEqual({ ok: true, patch: { suporteRemotoEnabled: true } })
    expect(patchDosAjustes(ajustes(), { chave: `  ${CHAVE_DE_TESTE}  `, ativado: true })).toEqual({
      ok: true,
      patch: { suporteRemotoChave: CHAVE_DE_TESTE, suporteRemotoEnabled: true }
    })
  })

  it('apagar a chave desliga o recurso, mesmo pedindo para ligar', () => {
    expect(patchDosAjustes(ajustes({ temChave: true, ativado: true }), { chave: '' })).toEqual({
      ok: true,
      patch: { suporteRemotoChave: '', suporteRemotoEnabled: false }
    })
    expect(patchDosAjustes(ajustes({ temChave: true, ativado: true }), { chave: '', ativado: true })).toMatchObject({ ok: false })
  })

  it('chave curta, com espaço ou de outro tipo é recusada', () => {
    for (const chave of ['curta', `${'a'.repeat(15)} ${'b'.repeat(15)}`, 'ç'.repeat(30), 'x'.repeat(201), 42, null]) {
      expect(patchDosAjustes(ajustes(), { chave })).toMatchObject({ ok: false })
    }
  })

  it('o nome é limpo (vai à janela do cliente) e tem limite', () => {
    expect(patchDosAjustes(ajustes(), { tecnico: '  Ana\n\tPaula  ' })).toEqual({ ok: true, patch: { suporteRemotoTecnico: 'Ana Paula' } })
    expect(patchDosAjustes(ajustes(), { tecnico: 'a'.repeat(41) })).toMatchObject({ ok: false })
    expect(patchDosAjustes(ajustes(), { tecnico: 7 })).toMatchObject({ ok: false })
  })

  it('pedido vazio, lista ou texto não vira patch', () => {
    for (const bruto of [{}, [], 'x', null, undefined]) expect(patchDosAjustes(ajustes(), bruto)).toMatchObject({ ok: false })
  })
})

describe('suporte remoto: canais da tela', () => {
  function canais(): {
    chamar: (canal: string, ...args: unknown[]) => Promise<unknown>
    enviados: Array<[string, unknown]>
    salvos: Array<Partial<AppConfig>>
    controle: ReturnType<typeof registrarCanaisDoSuporte>
  } {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const enviados: Array<[string, unknown]> = []
    const salvos: Array<Partial<AppConfig>> = []
    const controle = registrarCanaisDoSuporte({
      ipcMain: { handle: (canal: string, fn: (...args: unknown[]) => unknown) => void handlers.set(canal, fn) } as never,
      enviar: (canal, dados) => enviados.push([canal, dados]),
      salvar: async (patch) => {
        salvos.push(patch)
        Object.assign(estado.config, patch)
      },
      carregar: async () => undefined
    })
    return { chamar: async (canal, ...args) => handlers.get(canal)?.({}, ...args), enviados, salvos, controle }
  }

  it('os ajustes vão à tela sem a chave: só se ela existe', async () => {
    estado.config = { suporteRemotoEnabled: true, suporteRemotoTecnico: 'Ana', suporteRemotoChave: CHAVE_DE_TESTE }
    const { chamar } = canais()
    const resposta = await chamar(Channels.suporteAjustes)
    expect(resposta).toEqual({ ativado: true, tecnico: 'Ana', temChave: true })
    expect(JSON.stringify(resposta)).not.toContain(CHAVE_DE_TESTE)
  })

  it('salvar valida, grava, avisa a tela e a resposta não devolve a chave', async () => {
    const { chamar, enviados, salvos } = canais()
    expect(await chamar(Channels.suporteSalvarAjustes, { ativado: true })).toMatchObject({ ok: false })
    expect(salvos).toHaveLength(0)

    const resposta = await chamar(Channels.suporteSalvarAjustes, { chave: CHAVE_DE_TESTE, tecnico: 'Ana', ativado: true })
    expect(resposta).toEqual({ ok: true, ajustes: { ativado: true, tecnico: 'Ana', temChave: true } })
    expect(salvos).toEqual([{ suporteRemotoTecnico: 'Ana', suporteRemotoChave: CHAVE_DE_TESTE, suporteRemotoEnabled: true }])
    const aviso = enviados.find(([canal]) => canal === Channels.suporteAjustesMudou)
    expect(aviso?.[1]).toEqual({ ativado: true, tecnico: 'Ana', temChave: true })
    expect(JSON.stringify([resposta, enviados])).not.toContain(CHAVE_DE_TESTE)
  })

  it('conectar recusa entrada malformada antes de chegar ao serviço', async () => {
    estado.config = { suporteRemotoEnabled: true, suporteRemotoTecnico: 'Ana', suporteRemotoChave: CHAVE_DE_TESTE }
    const { chamar } = canais()
    for (const [conversa, codigo] of [[null, '482917305'], ['conv-a', 482917305], ['', '482917305'], ['conv-a', 'x'.repeat(41)]]) {
      expect(await chamar(Channels.suporteConectar, conversa, codigo)).toMatchObject({ ok: false })
    }
    // Código com letras passa pela entrada mas o serviço recusa sem falar com o relay.
    expect(await chamar(Channels.suporteConectar, 'conv-a', 'abc')).toMatchObject({ ok: false, mensagem: expect.stringContaining('9 dígitos') })
    expect(suporteRemoto().status().estado).toBe('desligado')
  })

  it('o estado vai à tela sem token nem chave', async () => {
    const { chamar } = canais()
    const status = await chamar(Channels.suporteStatus)
    expect(status).toEqual({ estado: 'desligado', convId: null })
  })
})
