import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { CHAVE_DE_TESTE, TOKEN_DE_TESTE, ate, relayFalso } from './relayFalso.testkit'
import { SuporteRemotoServico } from './servico'
import { ligarSuporteNaConversa } from './sessaoMcp'

const interno = (nome: string): McpServerConfig => ({ type: 'sdk', name: nome, instance: {} } as unknown as McpServerConfig)
const stdio: McpServerConfig = { type: 'stdio', command: 'rea', args: [] }

function cenario(ativadoInicial = true): {
  servico: SuporteRemotoServico
  relay: ReturnType<typeof relayFalso>
  ajustes: { ativado: boolean }
  conversa: (convId: string, comSuporte?: boolean) => { chamadas: Array<Record<string, McpServerConfig>>; aplicar: () => Promise<void>; desligar: () => void; falhas: string[] }
} {
  const relay = relayFalso()
  const ajustes = { ativado: ativadoInicial }
  const servico = new SuporteRemotoServico({
    ajustes: () => ({ ...ajustes, tecnico: 'Ana', chave: CHAVE_DE_TESTE }),
    base: () => 'http://127.0.0.1:1',
    fetchImpl: relay.fetchImpl
  })
  const conversa = (convId: string, comSuporte = ativadoInicial) => {
    const chamadas: Array<Record<string, McpServerConfig>> = []
    const falhas: string[] = []
    const base: Record<string, McpServerConfig> = { browser: interno('browser'), app: interno('app'), rea: stdio }
    if (comSuporte) base.suporte = interno('suporte')
    const ligacao = ligarSuporteNaConversa({
      convId,
      servico,
      base,
      consulta: () => ({
        setMcpServers: async (servidores) => {
          chamadas.push(servidores)
          return { added: [], removed: [], errors: {} }
        }
      }),
      ativado: () => ajustes.ativado,
      servidorSuporte: () => interno('suporte'),
      aoFalhar: (texto) => falhas.push(texto)
    })
    return { chamadas, falhas, ...ligacao }
  }
  return { servico, relay, ajustes, conversa }
}

describe('suporte remoto: servidor MCP na sessão do agente', () => {
  it('sem sessão de suporte e sem mudança no interruptor, não mexe nos servidores', async () => {
    const { conversa } = cenario()
    const a = conversa('conv-a')
    await a.aplicar()
    expect(a.chamadas).toHaveLength(0)
  })

  it('conectar liga o `remoto` só na conversa dona, repassando os internos; o stdio fica de fora', async () => {
    const { servico, conversa } = cenario()
    const a = conversa('conv-a')
    const b = conversa('conv-b')
    await servico.conectar('conv-a', '482917305')
    expect(a.chamadas).toHaveLength(1)
    expect(Object.keys(a.chamadas[0]).sort()).toEqual(['app', 'browser', 'remoto', 'suporte'])
    expect(a.chamadas[0].remoto).toMatchObject({ type: 'http', headers: { Authorization: `Bearer ${TOKEN_DE_TESTE}` }, timeout: 600_000 })
    // A outra conversa nem é tocada, mesmo se alguém pedir para reaplicar.
    await b.aplicar()
    expect(b.chamadas).toHaveLength(0)
    await servico.desconectar()
  })

  it('encerrar, cair ou o cliente sair tira o `remoto` e mantém os internos', async () => {
    const { servico, relay, conversa } = cenario()
    const a = conversa('conv-a')
    await servico.conectar('conv-a', '482917305')
    await servico.desconectar()
    expect(Object.keys(a.chamadas[1]).sort()).toEqual(['app', 'browser', 'suporte'])

    await servico.conectar('conv-a', '482917305')
    await ate(() => relay.ouvindo())
    relay.derrubar()
    await ate(() => a.chamadas.length === 4)
    expect(a.chamadas[3].remoto).toBeUndefined()
  })

  it('ligar o recurso em Configurações dá o servidor `suporte` às conversas abertas; desligar tira', async () => {
    const { servico, ajustes, conversa } = cenario(false)
    const a = conversa('conv-a')
    ajustes.ativado = true
    await servico.ajustesMudaram()
    expect(Object.keys(a.chamadas[0]).sort()).toEqual(['app', 'browser', 'suporte'])
    await servico.conectar('conv-a', '482917305')
    expect(a.chamadas[1].remoto).toBeDefined()
    ajustes.ativado = false
    await servico.ajustesMudaram()
    expect(Object.keys(a.chamadas[a.chamadas.length - 1]).sort()).toEqual(['app', 'browser'])
    expect(servico.status().estado).toBe('desligado')
  })

  it('sessão do agente nova na conversa dona (troca de provedor) já sobe com o `remoto`', async () => {
    const { servico, conversa } = cenario()
    const antiga = conversa('conv-a')
    await servico.conectar('conv-a', '482917305')
    antiga.desligar()
    const nova = conversa('conv-a')
    await nova.aplicar()
    expect(nova.chamadas[0].remoto).toBeDefined()
    // A antiga, já desligada, não recebe mais nada.
    await servico.desconectar()
    expect(antiga.chamadas).toHaveLength(1)
    expect(nova.chamadas).toHaveLength(2)
  })

  it('conectar no cliente repete o que a sessão ligou depois (rea, Android, Chrome sob demanda)', async () => {
    const relay = relayFalso()
    const servico = new SuporteRemotoServico({ ajustes: () => ({ ativado: true, tecnico: 'Ana', chave: CHAVE_DE_TESTE }), base: () => 'http://127.0.0.1:1', fetchImpl: relay.fetchImpl })
    const chamadas: Array<Record<string, McpServerConfig>> = []
    const tardios: Record<string, McpServerConfig> = {}
    const ligacao = ligarSuporteNaConversa({
      convId: 'conv-a',
      servico,
      base: { app: interno('app'), suporte: interno('suporte') },
      consulta: () => ({ setMcpServers: async (servidores) => { chamadas.push(servidores); return { added: [], removed: [], errors: {} } } }),
      ativado: () => true,
      servidorSuporte: () => interno('suporte'),
      extras: () => tardios
    })
    // Antes de conectar: quem troca os servidores por fora só precisa repetir o `suporte`.
    expect(Object.keys(ligacao.servidores())).toEqual(['suporte'])
    tardios.rea = stdio
    tardios.android = interno('android')
    await servico.conectar('conv-a', '482917305')
    expect(Object.keys(chamadas[0]).sort()).toEqual(['android', 'app', 'rea', 'remoto', 'suporte'])
    // Com o cliente conectado, o `remoto` também tem de ser repetido por quem ligar outro servidor.
    expect(Object.keys(ligacao.servidores()).sort()).toEqual(['remoto', 'suporte'])
    await servico.desconectar()
    expect(Object.keys(chamadas[1]).sort()).toEqual(['android', 'app', 'rea', 'suporte'])
    expect(Object.keys(ligacao.servidores())).toEqual(['suporte'])
  })

  it('o `remoto` que o SDK recusou não entra na lista a repetir', async () => {
    const relay = relayFalso()
    const servico = new SuporteRemotoServico({ ajustes: () => ({ ativado: true, tecnico: 'Ana', chave: CHAVE_DE_TESTE }), base: () => 'http://127.0.0.1:1', fetchImpl: relay.fetchImpl })
    const ligacao = ligarSuporteNaConversa({
      convId: 'conv-a',
      servico,
      base: { suporte: interno('suporte') },
      consulta: () => ({ setMcpServers: async () => ({ added: [], removed: [], errors: { remoto: 'recusado' } }) }),
      ativado: () => true,
      servidorSuporte: () => interno('suporte')
    })
    await servico.conectar('conv-a', '482917305')
    expect(Object.keys(ligacao.servidores())).toEqual(['suporte'])
    await servico.desconectar()
  })

  it('troca feita por fora entra na mesma fila: espera a do suporte e não a atropela', async () => {
    const ordem: string[] = []
    const relay = relayFalso()
    const lento = new SuporteRemotoServico({ ajustes: () => ({ ativado: true, tecnico: 'Ana', chave: CHAVE_DE_TESTE }), base: () => 'http://127.0.0.1:1', fetchImpl: relay.fetchImpl })
    const ligacao = ligarSuporteNaConversa({
      convId: 'conv-a',
      servico: lento,
      base: { suporte: interno('suporte') },
      consulta: () => ({
        setMcpServers: async () => {
          ordem.push('suporte:inicio')
          await new Promise((r) => setTimeout(r, 20))
          ordem.push('suporte:fim')
          return { added: [], removed: [], errors: {} }
        }
      }),
      ativado: () => true,
      servidorSuporte: () => interno('suporte')
    })
    const conectando = lento.conectar('conv-a', '482917305')
    await ate(() => ordem.includes('suporte:inicio'))
    const porFora = ligacao.naFila(async () => { ordem.push('fora'); return 'ok' })
    expect(await porFora).toBe('ok')
    await conectando
    expect(ordem).toEqual(['suporte:inicio', 'suporte:fim', 'fora'])
    // Uma troca que falha não trava a fila para as seguintes.
    await expect(ligacao.naFila(async () => { throw new Error('falhou') })).rejects.toThrow('falhou')
    expect(await ligacao.naFila(async () => 'segue')).toBe('segue')
    await lento.desconectar()
  })

  it('o SDK não conseguiu ligar o servidor: avisa no chat sem endereço nem token', async () => {
    const relay = relayFalso()
    const servico = new SuporteRemotoServico({ ajustes: () => ({ ativado: true, tecnico: 'Ana', chave: CHAVE_DE_TESTE }), base: () => 'http://127.0.0.1:1', fetchImpl: relay.fetchImpl })
    const falhas: string[] = []
    ligarSuporteNaConversa({
      convId: 'conv-a',
      servico,
      base: { suporte: interno('suporte') },
      consulta: () => ({ setMcpServers: async () => ({ added: [], removed: [], errors: { remoto: `falhou em http://127.0.0.1:1 com ${TOKEN_DE_TESTE}` } }) }),
      ativado: () => true,
      servidorSuporte: () => interno('suporte'),
      aoFalhar: (texto) => falhas.push(texto)
    })
    await servico.conectar('conv-a', '482917305')
    expect(falhas).toHaveLength(1)
    expect(falhas[0]).not.toContain(TOKEN_DE_TESTE)
    expect(falhas[0]).not.toContain('127.0.0.1')
    await servico.desconectar()
  })
})
