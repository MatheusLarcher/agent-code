import { describe, expect, it } from 'vitest'
import { CHAVE_DE_TESTE, SESSAO_DE_TESTE, TOKEN_DE_TESTE, relayFalso } from './relayFalso.testkit'
import { SuporteRemotoServico } from './servico'
import { acoesDoSuporte, createSuporteMcpServer } from './servidor'

function cenario(ativado = true): { servico: SuporteRemotoServico; relay: ReturnType<typeof relayFalso> } {
  const relay = relayFalso()
  const servico = new SuporteRemotoServico({
    ajustes: () => ({ ativado, tecnico: 'Ana', chave: CHAVE_DE_TESTE }),
    base: () => 'http://127.0.0.1:1',
    fetchImpl: relay.fetchImpl
  })
  return { servico, relay }
}

const semSegredo = (texto: string): void => {
  expect(texto).not.toContain(TOKEN_DE_TESTE)
  expect(texto).not.toContain(CHAVE_DE_TESTE)
  expect(texto).not.toContain(SESSAO_DE_TESTE)
}

describe('suporte remoto: ferramentas do chat', () => {
  it('suporte_conectar pareia e diz ao agente por onde começar, sem token nem sessão', async () => {
    const { servico, relay } = cenario()
    const resposta = await acoesDoSuporte(servico, 'conv-a').conectar('482 917 305')
    expect(resposta.isError).toBeUndefined()
    expect(resposta.content[0].text).toContain('PC-DO-CLIENTE')
    expect(resposta.content[0].text).toContain('remoto_info')
    semSegredo(resposta.content[0].text)
    // O código vai ao relay só com dígitos, com a chave no cabeçalho e o nome do técnico.
    const pedido = relay.pedidos.find((p) => p.caminho === '/suporte/parear')
    expect(pedido).toMatchObject({ metodo: 'POST', chave: CHAVE_DE_TESTE, corpo: { codigo: '482917305', tecnico: 'Ana' } })
    await servico.desconectar()
  })

  it('recusa do cliente, código errado e recurso desligado voltam como erro legível', async () => {
    const { servico, relay } = cenario()
    relay.parear = { status: 403, corpo: { erro: 'recusado' } }
    const recusa = await acoesDoSuporte(servico, 'conv-a').conectar('482917305')
    expect(recusa).toMatchObject({ isError: true })
    expect(recusa.content[0].text).toMatch(/não permitiu/)

    relay.parear = { status: 404, corpo: { erro: 'codigo' } }
    expect((await acoesDoSuporte(servico, 'conv-a').conectar('111222333')).content[0].text).toMatch(/Nenhum cliente com esse código/)
    expect((await acoesDoSuporte(servico, 'conv-a').conectar('12')).isError).toBe(true)

    const desligado = cenario(false)
    const negado = await acoesDoSuporte(desligado.servico, 'conv-a').conectar('482917305')
    expect(negado).toMatchObject({ isError: true })
    expect(negado.content[0].text).toMatch(/Configurações/)
    expect(desligado.relay.pedidos).toHaveLength(0)
  })

  it('suporte_status mostra a sessão só à conversa dona, e nunca o token', async () => {
    const { servico } = cenario()
    await acoesDoSuporte(servico, 'conv-a').conectar('482917305')
    const dona = acoesDoSuporte(servico, 'conv-a').status().content[0].text
    expect(JSON.parse(dona)).toMatchObject({ estado: 'conectado', nestaConversa: true, computador: 'PC-DO-CLIENTE', administrador: false })
    semSegredo(dona)

    const outra = acoesDoSuporte(servico, 'conv-b').status().content[0].text
    expect(JSON.parse(outra)).toMatchObject({ estado: 'conectado', nestaConversa: false })
    expect(outra).not.toContain('PC-DO-CLIENTE')
    semSegredo(outra)
    await servico.desconectar()
  })

  it('suporte_desconectar só encerra a sessão da própria conversa', async () => {
    const { servico, relay } = cenario()
    expect((await acoesDoSuporte(servico, 'conv-a').desconectar()).content[0].text).toMatch(/Não há sessão/)
    await acoesDoSuporte(servico, 'conv-a').conectar('482917305')

    const deFora = await acoesDoSuporte(servico, 'conv-b').desconectar()
    expect(deFora.isError).toBe(true)
    expect(servico.status().estado).toBe('conectado')

    const daDona = await acoesDoSuporte(servico, 'conv-a').desconectar()
    expect(daDona.isError).toBeUndefined()
    expect(servico.status().estado).toBe('desligado')
    expect(relay.pedidos.some((p) => p.caminho.startsWith('/suporte/encerrar/') && p.autorizacao === `Bearer ${TOKEN_DE_TESTE}`)).toBe(true)
  })

  it('o servidor MCP interno se chama `suporte` e oferece as três ferramentas', () => {
    const { servico } = cenario()
    const servidor = createSuporteMcpServer(servico, 'conv-a') as { type: string; name: string }
    expect(servidor).toMatchObject({ type: 'sdk', name: 'suporte' })
  })
})
