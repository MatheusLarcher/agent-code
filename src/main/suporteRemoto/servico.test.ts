import { describe, expect, it } from 'vitest'
import { RegistroDeChamadas, resumoDaChamada } from './registro'
import { baseDoRelay, ouvirEventos, parear } from './relay'
import { CHAVE_DE_TESTE, SESSAO_DE_TESTE, TOKEN_DE_TESTE, ate, relayFalso, type RelayFalso } from './relayFalso.testkit'
import { SUPORTE_DESLIGADO, SuporteRemotoServico } from './servico'

const BASE = 'http://127.0.0.1:1'

function montar(ajustes: Partial<{ ativado: boolean; tecnico: string; chave: string }> = {}): { servico: SuporteRemotoServico; relay: RelayFalso; registro: RegistroDeChamadas } {
  const relay = relayFalso()
  const registro = new RegistroDeChamadas(() => null, () => 1_000)
  const servico = new SuporteRemotoServico({
    ajustes: () => ({ ativado: true, tecnico: 'Ana', chave: CHAVE_DE_TESTE, ...ajustes }),
    base: () => BASE,
    fetchImpl: relay.fetchImpl,
    registro,
    aguardandoAposMs: 20,
    mortoMs: 5_000
  })
  return { servico, relay, registro }
}

describe('suporte remoto: sessão do lado do técnico', () => {
  it('pareia com a chave, o código sem máscara e o nome; só a conversa dona enxerga o servidor', async () => {
    const { servico, relay } = montar()
    const resultado = await servico.conectar('conv-a', '482 917-305')
    expect(resultado).toEqual({ ok: true, info: expect.objectContaining({ pc: 'PC-DO-CLIENTE' }) })
    const pedido = relay.pedidos[0]
    expect(pedido).toMatchObject({ metodo: 'POST', caminho: '/suporte/parear', chave: CHAVE_DE_TESTE, corpo: { codigo: '482917305', tecnico: 'Ana' } })

    expect(servico.status()).toMatchObject({ estado: 'conectado', convId: 'conv-a', pc: 'PC-DO-CLIENTE' })
    expect(servico.mcpDaConversa('conv-a')).toEqual({
      type: 'http',
      url: `${BASE}/suporte/mcp/${SESSAO_DE_TESTE}`,
      headers: { Authorization: `Bearer ${TOKEN_DE_TESTE}` },
      timeout: 600_000
    })
    // Outra conversa do mesmo app não enxerga o servidor nem a sessão.
    expect(servico.mcpDaConversa('conv-b')).toBeNull()
    expect(servico.sessaoDaConversa('conv-b')).toBeNull()
    // O que vai à tela nunca leva o token nem a chave.
    expect(JSON.stringify(servico.status())).not.toContain(TOKEN_DE_TESTE)
    expect(JSON.stringify(servico.status())).not.toContain(CHAVE_DE_TESTE)
    await ate(() => relay.ouvindo())
    expect(relay.pedidos.find((p) => p.caminho.startsWith('/suporte/eventos/'))?.autorizacao).toBe(`Bearer ${TOKEN_DE_TESTE}`)
    await servico.desconectar()
  })

  it('recusa do cliente: sem sessão, sem servidor, com o aviso para a tela', async () => {
    const { servico, relay } = montar()
    relay.parear = { status: 403, corpo: { erro: 'recusado' } }
    const resultado = await servico.conectar('conv-a', '482917305')
    expect(resultado).toEqual({ ok: false, mensagem: expect.stringContaining('não permitiu') })
    expect(servico.status()).toMatchObject({ estado: 'desligado', convId: null, aviso: { tipo: 'recusado' } })
    expect(servico.mcpDaConversa('conv-a')).toBeNull()
  })

  it.each([
    ['chave', 403, 'chave da equipe'],
    ['codigo', 404, 'Nenhum cliente'],
    ['ocupado', 409, 'Já existe um técnico'],
    ['desligado', 503, 'desligado no servidor']
  ])('erro "%s" do relay vira mensagem clara', async (erro, status, trecho) => {
    const { servico, relay } = montar()
    relay.parear = { status, corpo: { erro } }
    const resultado = await servico.conectar('conv-a', '482917305')
    expect(resultado.ok).toBe(false)
    expect(resultado.ok === false && resultado.mensagem).toContain(trecho)
    expect(servico.status().aviso?.tipo).toBe('erro')
  })

  it('bloqueio por tentativas erradas informa quanto esperar', async () => {
    const { servico, relay } = montar()
    relay.parear = { status: 429, corpo: { erro: 'bloqueado', esperaSeg: 540 } }
    const resultado = await servico.conectar('conv-a', '482917305')
    expect(resultado.ok === false && resultado.mensagem).toContain('9 min')
  })

  it('resposta 200 sem token no formato combinado não vira sessão', async () => {
    const { servico, relay } = montar()
    relay.parear = { status: 200, corpo: { sessao: SESSAO_DE_TESTE, token: 'curto', info: {} } }
    expect((await servico.conectar('conv-a', '482917305')).ok).toBe(false)
    expect(servico.status().estado).toBe('desligado')
  })

  it('queda: o fluxo de eventos acaba, a sessão vira "caiu" e a conversa perde o servidor', async () => {
    const { servico, relay } = montar()
    let aplicacoes = 0
    servico.registrarConversa('conv-a', async () => { aplicacoes++ })
    await servico.conectar('conv-a', '482917305')
    expect(aplicacoes).toBe(1)
    await ate(() => relay.ouvindo())
    relay.derrubar()
    await ate(() => servico.status().estado === 'caiu')
    expect(servico.status()).toMatchObject({ estado: 'caiu', convId: 'conv-a', aviso: { tipo: 'caiu' } })
    expect(servico.mcpDaConversa('conv-a')).toBeNull()
    await ate(() => aplicacoes === 2)
    // Depois de cair, dá para conectar de novo.
    expect((await servico.conectar('conv-a', '482917305')).ok).toBe(true)
    await servico.desconectar()
  })

  it('o cliente encerra na janela dele: a sessão acaba com o aviso', async () => {
    const { servico, relay } = montar()
    await servico.conectar('conv-a', '482917305')
    await ate(() => relay.ouvindo())
    relay.emitir({ evento: 'encerrado', motivo: 'cliente' })
    await ate(() => servico.status().estado === 'desligado')
    expect(servico.status()).toMatchObject({ convId: null, aviso: { tipo: 'encerrado', texto: expect.stringContaining('cliente encerrou') } })
    expect(servico.mcpDaConversa('conv-a')).toBeNull()
  })

  it('o técnico encerra: avisa o relay com o token e limpa tudo', async () => {
    const { servico, relay } = montar()
    await servico.conectar('conv-a', '482917305')
    expect(await servico.desconectar()).toBe(true)
    expect(servico.status()).toEqual({ estado: 'desligado', convId: null })
    expect(servico.mcpDaConversa('conv-a')).toBeNull()
    expect(relay.pedidos.find((p) => p.caminho === `/suporte/encerrar/${SESSAO_DE_TESTE}`)).toMatchObject({ metodo: 'POST', autorizacao: `Bearer ${TOKEN_DE_TESTE}` })
    expect(await servico.desconectar()).toBe(false)
  })

  it('uma sessão por vez no app, presa à conversa que conectou', async () => {
    const { servico } = montar()
    await servico.conectar('conv-a', '482917305')
    const outra = await servico.conectar('conv-b', '111222333')
    expect(outra).toEqual({ ok: false, mensagem: expect.stringContaining('outra conversa') })
    const mesma = await servico.conectar('conv-a', '111222333')
    expect(mesma).toEqual({ ok: false, mensagem: expect.stringContaining('nesta conversa') })
    expect(servico.status().convId).toBe('conv-a')
    await servico.desconectar()
  })

  it('enquanto o cliente decide: conectando, depois aguardando; desistir cancela o pedido', async () => {
    const { servico, relay } = montar()
    relay.parear.segurar = true
    const estados: string[] = []
    servico.onChange((status) => estados.push(status.estado))
    const pendente = servico.conectar('conv-a', '482917305')
    await ate(() => servico.status().estado === 'aguardando')
    expect(servico.mcpDaConversa('conv-a')).toBeNull()
    expect(await servico.desconectar()).toBe(true)
    expect(await pendente).toEqual({ ok: false, mensagem: expect.stringContaining('cancelada') })
    expect(estados).toEqual(['conectando', 'aguardando', 'desligado'])
    expect(servico.status()).toEqual({ estado: 'desligado', convId: null })
  })

  it('eventos do cliente (recurso ligado/desligado, administrador) chegam ao status', async () => {
    const { servico, relay } = montar()
    await servico.conectar('conv-a', '482917305')
    await ate(() => relay.ouvindo())
    relay.emitir({ evento: 'recurso', recurso: 'chrome', estado: 'ligado' })
    relay.emitir({ evento: 'admin' })
    await ate(() => servico.status().admin === true)
    expect(servico.status()).toMatchObject({ admin: true, recursos: { chrome: 'ligado' } })
    await servico.desconectar()
  })

  it('sem o recurso ativado, sem chave, sem nome ou com código torto: nem chega ao relay', async () => {
    for (const [ajustes, trecho] of [
      [{ ativado: false }, SUPORTE_DESLIGADO],
      [{ chave: '' }, 'chave da equipe'],
      [{ tecnico: '  ' }, 'seu nome']
    ] as const) {
      const { servico, relay } = montar(ajustes)
      const resultado = await servico.conectar('conv-a', '482917305')
      expect(resultado.ok === false && resultado.mensagem).toContain(trecho)
      expect(relay.pedidos).toHaveLength(0)
    }
    const { servico, relay } = montar()
    expect((await servico.conectar('conv-a', '12345')).ok).toBe(false)
    expect(relay.pedidos).toHaveLength(0)
  })

  it('desligar o recurso em Configurações encerra a sessão aberta', async () => {
    const ajustes = { ativado: true }
    const relay = relayFalso()
    const servico = new SuporteRemotoServico({ ajustes: () => ({ ...ajustes, tecnico: 'Ana', chave: CHAVE_DE_TESTE }), base: () => BASE, fetchImpl: relay.fetchImpl })
    await servico.conectar('conv-a', '482917305')
    ajustes.ativado = false
    await servico.ajustesMudaram()
    expect(servico.status().estado).toBe('desligado')
    expect(relay.pedidos.some((p) => p.caminho.startsWith('/suporte/encerrar/'))).toBe(true)
  })
})

describe('suporte remoto: registro local das chamadas', () => {
  it('registra hora, sessão, ferramenta, resumo e resultado; só do servidor remoto', async () => {
    const { servico, registro } = montar()
    await servico.conectar('conv-a', '482917305')
    servico.registrarDecisao('conv-a', 'mcp__remoto__remoto_executar', { comando: 'ipconfig /all' }, 'tu-1', true)
    servico.registrarDecisao('conv-a', 'mcp__remoto__remoto_arquivo_escrever', { caminho: 'C:\\x.txt', conteudo: 'segredo do cliente' }, undefined, false)
    servico.registrarDecisao('conv-a', 'Bash', { command: 'dir' }, 'tu-2', true)
    servico.registrarResultado('tu-1', false)
    servico.registrarResultado('tu-2', false)
    servico.registrarResultado('desconhecido', true)
    expect(registro.recentes()).toEqual([
      { hora: new Date(1_000).toISOString(), sessao: SESSAO_DE_TESTE.slice(0, 8), ferramenta: 'remoto_arquivo_escrever', resumo: 'C:\\x.txt · 18 caracteres', resultado: 'negada' },
      { hora: new Date(1_000).toISOString(), sessao: SESSAO_DE_TESTE.slice(0, 8), ferramenta: 'remoto_executar', resumo: 'ipconfig /all', resultado: 'ok', ms: 0 }
    ])
    const tudo = JSON.stringify(registro.recentes())
    expect(tudo).not.toContain(TOKEN_DE_TESTE)
    expect(tudo).not.toContain('segredo do cliente')
    await servico.desconectar()
  })

  it('resumo nunca leva o texto digitado e corta o que é longo', () => {
    expect(resumoDaChamada('remoto_type_text', { texto: 'senha123' })).toBe('8 caracteres')
    expect(resumoDaChamada('remoto_android_digitar', { texto: 'abc' })).toBe('3 caracteres')
    expect(resumoDaChamada('remoto_chrome_navigate', { url: 'https://exemplo.com' })).toBe('https://exemplo.com')
    expect(resumoDaChamada('remoto_executar', { comando: 'x'.repeat(500) })).toHaveLength(120)
    expect(resumoDaChamada('remoto_info', {})).toBe('')
  })
})

describe('suporte remoto: cliente do relay', () => {
  it('o endereço é fixo; a variável de teste só vale para a própria máquina', () => {
    expect(baseDoRelay({})).toBe('https://agent-code.larchertech.com')
    expect(baseDoRelay({ AGENT_CODE_SUPORTE_RELAY: 'ws://127.0.0.1:4567' })).toBe('http://127.0.0.1:4567')
    expect(baseDoRelay({ AGENT_CODE_SUPORTE_RELAY: 'http://localhost:9000/x' })).toBe('http://localhost:9000')
    expect(baseDoRelay({ AGENT_CODE_SUPORTE_RELAY: 'wss://relay.do.atacante.example' })).toBe('https://agent-code.larchertech.com')
    expect(baseDoRelay({ AGENT_CODE_SUPORTE_RELAY: 'http://127.0.0.1.evil.example' })).toBe('https://agent-code.larchertech.com')
    expect(baseDoRelay({ AGENT_CODE_SUPORTE_RELAY: 'isto não é endereço' })).toBe('https://agent-code.larchertech.com')
  })

  it('sem rede, o parear responde "rede" em vez de lançar', async () => {
    const semRede = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    expect(await parear(BASE, { chave: CHAVE_DE_TESTE, codigo: '482917305', tecnico: 'Ana' }, { fetchImpl: semRede })).toEqual({ ok: false, erro: 'rede' })
  })

  it('o fluxo de eventos ignora linha torta e evento desconhecido, e avisa UMA vez quando acaba', async () => {
    const relay = relayFalso()
    const eventos: string[] = []
    let fins = 0
    ouvirEventos(BASE, SESSAO_DE_TESTE, TOKEN_DE_TESTE, (e) => eventos.push(e.evento), () => { fins++ }, { fetchImpl: relay.fetchImpl })
    await ate(() => relay.ouvindo())
    relay.emitir({ evento: 'recurso', recurso: 'tela', estado: 'desligado' })
    relay.emitir({ evento: 'explodir' } as never)
    relay.derrubar()
    await ate(() => fins === 1)
    expect(eventos).toEqual(['conectado', 'recurso'])
    expect(fins).toBe(1)
  })

  it('silêncio maior que o limite conta como conexão morta', async () => {
    const relay = relayFalso()
    let fins = 0
    ouvirEventos(BASE, SESSAO_DE_TESTE, TOKEN_DE_TESTE, () => undefined, () => { fins++ }, { fetchImpl: relay.fetchImpl, mortoMs: 40 })
    await ate(() => fins === 1)
    expect(relay.ouvindo()).toBe(false)
  })
})
