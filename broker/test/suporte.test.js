import { describe, it, expect, afterEach } from 'vitest'
import { request as httpRequest } from 'node:http'
import { WebSocket } from 'ws'
import { createBroker } from '../src/broker.js'
import { createSuporte, DOWNLOAD_URL } from '../src/suporte.js'

// Canal de suporte remoto: exe do cliente (WebSocket) ↔ relay ↔ Agent Code (HTTP).
// Chave, token e códigos daqui são de mentira, só para o teste.

const CHAVE = 'chave-da-equipe-de-teste'
const TOKEN = 'token-de-teste-0123456789abcdefghijklmnopqrstuvwxyz'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let broker = null
let suporte = null
let port = 0
let relogio = 0
const sockets = []

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate()
  if (broker) await broker.close()
  broker = null
})

async function start(opts = {}) {
  relogio = 1_000_000
  suporte = createSuporte({ chave: CHAVE, now: () => relogio, ...opts })
  broker = createBroker({ suporte })
  await new Promise((resolve) => broker.listen(0, resolve))
  port = broker.server.address().port
}

/** Requisição HTTP ao relay. Resolve com { status, body, json, headers }. */
function http(method, path, { headers = {}, body, aoAbrir } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${port}${path}`, { method, headers }, (res) => {
      let texto = ''
      res.on('data', (d) => (texto += d))
      res.on('end', () => {
        let json = null
        try {
          json = JSON.parse(texto)
        } catch {
          /* não é JSON */
        }
        resolve({ status: res.statusCode, body: texto, json, headers: res.headers })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    aoAbrir?.(req)
    req.end(body)
  })
}

const parear = (codigo, { chave = CHAVE, tecnico = 'Matheus', ip } = {}) =>
  http('POST', '/suporte/parear', {
    headers: { 'content-type': 'application/json', 'x-suporte-chave': chave, ...(ip ? { 'x-real-ip': ip } : {}) },
    body: JSON.stringify({ codigo, tecnico })
  })

/**
 * Um "exe do cliente" fake. `aceitar`: true | false | 'calado'. `onOpen(ws, msg, corpo)`
 * responde às chamadas repassadas. Resolve com { ws, primeira, frames, pedidos }.
 */
function conectarExe(codigo, { aceitar = true, onOpen, hello = {} } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__suporte`)
    sockets.push(ws)
    const exe = { ws, primeira: null, frames: [], pedidos: [] }
    const corpos = new Map()
    ws.on('open', () =>
      ws.send(JSON.stringify({
        type: 'hello', v: 1, codigo, pc: 'PC-CLIENTE', sistema: 'windows', versaoSistema: '10.0', versao: '1.0.0',
        capacidades: ['tela', 'comandos', 'arquivos', 'administrador'], admin: false, ...hello
      })))
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      exe.frames.push(msg)
      if (!exe.primeira) {
        exe.primeira = msg
        resolve(exe)
        return
      }
      if (msg.type === 'pedido') {
        exe.pedidos.push(msg)
        if (aceitar === true) ws.send(JSON.stringify({ type: 'aceite', id: msg.id, ok: true, token: TOKEN }))
        else if (aceitar === false) ws.send(JSON.stringify({ type: 'aceite', id: msg.id, ok: false }))
      } else if (msg.type === 'open') corpos.set(msg.rid, { msg, texto: '' })
      else if (msg.type === 'data' && corpos.has(msg.rid)) corpos.get(msg.rid).texto += Buffer.from(msg.b64, 'base64').toString()
      else if (msg.type === 'end' && corpos.has(msg.rid)) {
        const { msg: open, texto } = corpos.get(msg.rid)
        corpos.delete(msg.rid)
        onOpen?.(ws, open, texto)
      }
    })
  })
}

function responder(ws, rid, status, headers, corpo) {
  ws.send(JSON.stringify({ type: 'head', rid, status, headers }))
  if (corpo) ws.send(JSON.stringify({ type: 'data', rid, b64: Buffer.from(corpo).toString('base64') }))
  ws.send(JSON.stringify({ type: 'end', rid }))
}

const mcp = (sessao, { token = TOKEN, body = '{"jsonrpc":"2.0","id":1,"method":"ping"}' } = {}) =>
  http('POST', `/suporte/mcp/${sessao}`, {
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body
  })

/** Abre o fluxo de eventos e acumula as linhas `data:`. */
function ouvir(sessao, token = TOKEN) {
  return new Promise((resolve, reject) => {
    const dados = []
    const req = httpRequest(`http://127.0.0.1:${port}/suporte/eventos/${sessao}`, { headers: { authorization: `Bearer ${token}` } }, (res) => {
      const fluxo = { status: res.statusCode, dados, fim: false, fechar: () => req.destroy() }
      res.on('data', (d) => {
        for (const linha of d.toString().split('\n')) if (linha.startsWith('data: ')) dados.push(JSON.parse(linha.slice(6)))
      })
      res.on('end', () => (fluxo.fim = true))
      res.on('error', () => {})
      resolve(fluxo)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('suporte — parear e repassar', () => {
  it('pareia com chave + código + aceite e repassa a chamada MCP ida e volta', async () => {
    await start()
    const vistos = []
    const exe = await conectarExe('482917305', {
      onOpen: (ws, open, corpo) => {
        vistos.push({ open, corpo })
        responder(ws, open.rid, 200, { 'content-type': 'application/json' }, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { eco: JSON.parse(corpo).method } }))
      }
    })
    expect(exe.primeira).toEqual({ type: 'ready' })

    const r = await parear('482 917 305')
    expect(r.status).toBe(200)
    expect(r.json.token).toBe(TOKEN)
    expect(r.json.info).toMatchObject({ pc: 'PC-CLIENTE', sistema: 'windows', admin: false })
    expect(r.json.info.capacidades).toEqual(['tela', 'comandos', 'arquivos', 'administrador'])
    expect(exe.pedidos[0].tecnico).toBe('Matheus')
    await wait(20)
    const retomar = exe.frames.find((f) => f.type === 'retomar')
    expect(retomar.sessao).toBe(r.json.sessao)
    expect(retomar.segredo.length).toBeGreaterThan(30)

    const chamada = await mcp(r.json.sessao)
    expect(chamada.status).toBe(200)
    expect(chamada.json.result.eco).toBe('ping')
    // O token chega ao exe (é ele quem confere o valor); a chave da equipe não desce.
    expect(vistos[0].open.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(vistos[0].open.method).toBe('POST')
    expect(vistos[0].open.url).toBe(`/suporte/mcp/${r.json.sessao}`)
    expect(JSON.stringify(vistos[0].open.headers)).not.toContain(CHAVE)
  })

  it('resposta em streaming (SSE) do exe chega em pedaços', async () => {
    await start()
    await conectarExe('111222333', {
      onOpen: (ws, open) => {
        ws.send(JSON.stringify({ type: 'head', rid: open.rid, status: 200, headers: { 'content-type': 'text/event-stream' } }))
        ws.send(JSON.stringify({ type: 'data', rid: open.rid, b64: Buffer.from(': vivo\n\n').toString('base64') }))
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'data', rid: open.rid, b64: Buffer.from('event: message\ndata: {"ok":true}\n\n').toString('base64') }))
          ws.send(JSON.stringify({ type: 'end', rid: open.rid }))
        }, 40)
      }
    })
    const { json: sessao } = await parear('111222333')
    const r = await mcp(sessao.sessao)
    expect(r.headers['content-type']).toContain('text/event-stream')
    expect(r.body).toBe(': vivo\n\nevent: message\ndata: {"ok":true}\n\n')
  })

  it('um técnico por código: pedido em aberto → 409; depois de pareado o código some', async () => {
    await start()
    await conectarExe('555666777', { aceitar: 'calado' })
    const primeiro = parear('555666777')
    await wait(30)
    expect((await parear('555666777', { tecnico: 'Outro' })).json).toEqual({ erro: 'ocupado' })
    // O exe responde o primeiro pedido e a sessão nasce.
    const exe = [...suporte.exes.values()][0]
    exe.pedido.responder({ ok: true, token: TOKEN })
    expect((await primeiro).status).toBe(200)
    expect((await parear('555666777', { ip: '10.9.9.9' })).json).toEqual({ erro: 'codigo' })
  })

  it('chamada grande demais → 413', async () => {
    await start({ chamadaBytes: 1024 })
    await conectarExe('999888777')
    const { json: sessao } = await parear('999888777')
    const r = await mcp(sessao.sessao, { body: 'x'.repeat(5000) })
    expect(r.status).toBe(413)
  })
})

describe('suporte — quem pode', () => {
  it('chave errada → 403 e o exe nem fica sabendo', async () => {
    await start()
    const exe = await conectarExe('482917305')
    const r = await parear('482917305', { chave: 'outra-chave' })
    expect(r.status).toBe(403)
    expect(r.json).toEqual({ erro: 'chave' })
    await wait(20)
    expect(exe.pedidos).toHaveLength(0)
  })

  it('sem SUPORTE_KEY o canal inteiro recusa (HTTP 503 e exe negado), mas o link de download segue', async () => {
    await start({ chave: '' })
    const exe = await conectarExe('482917305')
    expect(exe.primeira).toEqual({ type: 'negado', motivo: 'desligado' })
    expect((await parear('482917305', { chave: '' })).status).toBe(503)
    expect((await mcp('sessao-qualquer-0123456789')).status).toBe(503)
    const r = await http('GET', '/suporte')
    expect(r.status).toBe(302)
    expect(r.headers.location).toBe(DOWNLOAD_URL)
  })

  it('código errado 5 vezes no minuto bloqueia o endereço por 10 min', async () => {
    await start()
    await conectarExe('482917305')
    for (let i = 0; i < 5; i++) {
      const r = await parear('000000000', { ip: '203.0.113.7' })
      expect(r.status).toBe(404)
      expect(r.json).toEqual({ erro: 'codigo' })
    }
    // Bloqueado: nem o código certo passa — e outro endereço não é afetado.
    const bloqueado = await parear('482917305', { ip: '203.0.113.7' })
    expect(bloqueado.status).toBe(429)
    expect(bloqueado.json.erro).toBe('bloqueado')
    expect(Number(bloqueado.headers['retry-after'])).toBe(600)
    relogio += 9 * 60_000
    expect((await parear('482917305', { ip: '203.0.113.7' })).status).toBe(429)
    relogio += 61_000
    expect((await parear('482917305', { ip: '203.0.113.7' })).status).toBe(200)
  })

  it('chave errada também conta para o bloqueio', async () => {
    await start()
    for (let i = 0; i < 5; i++) expect((await parear('482917305', { chave: `errada-${i}`, ip: '203.0.113.8' })).status).toBe(403)
    expect((await parear('482917305', { ip: '203.0.113.8' })).status).toBe(429)
    expect((await parear('482917305', { ip: '203.0.113.9' })).status).toBe(404)
  })

  it('recusa do cliente → 403 recusado, e o código continua valendo para outra tentativa', async () => {
    await start()
    const exe = await conectarExe('482917305', { aceitar: false })
    const r = await parear('482917305')
    expect(r.status).toBe(403)
    expect(r.json).toEqual({ erro: 'recusado' })
    expect(suporte.sessoes.size).toBe(0)
    expect(suporte.exes.has('482917305')).toBe(true)
    expect(exe.pedidos).toHaveLength(1)
  })

  it('cliente que não responde no prazo → recusado, e o exe é avisado para fechar a pergunta', async () => {
    await start({ pedidoMs: -4950 }) // prazo + 5 s de folga = 50 ms
    const exe = await conectarExe('482917305', { aceitar: 'calado' })
    const r = await parear('482917305')
    expect(r.json).toEqual({ erro: 'recusado' })
    await wait(20)
    expect(exe.frames.some((f) => f.type === 'cancelado' && f.id === exe.pedidos[0].id)).toBe(true)
  })

  it('token ausente → 401 sem chegar ao exe; sessão inexistente → 404', async () => {
    await start()
    const vistos = []
    await conectarExe('482917305', { onOpen: (ws, open) => { vistos.push(open); responder(ws, open.rid, 200, {}, 'ok') } })
    const { json: sessao } = await parear('482917305')
    const sem = await mcp(sessao.sessao, { token: '' })
    expect(sem.status).toBe(401)
    expect(vistos).toHaveLength(0)
    expect((await mcp('sessao-que-nao-existe-00')).status).toBe(404)
  })

  it('pedido malformado → 400 (sem contar como tentativa)', async () => {
    await start()
    for (let i = 0; i < 7; i++) expect((await parear('12ab', { ip: '203.0.113.20' })).status).toBe(400)
    expect((await http('GET', '/suporte/parear')).status).toBe(405)
  })
})

describe('suporte — sessão, eventos e quedas', () => {
  it('queda do exe: chamada pendente recebe 502 com motivo claro, a sessão some e o fluxo avisa "caiu"', async () => {
    await start()
    const exe = await conectarExe('482917305') // não responde às chamadas
    const { json: sessao } = await parear('482917305')
    const fluxo = await ouvir(sessao.sessao)
    const pendente = mcp(sessao.sessao)
    await wait(40)
    exe.ws.terminate()
    const r = await pendente
    expect(r.status).toBe(502)
    expect(r.json.erro).toContain('desconectou')
    await wait(30)
    expect(fluxo.dados.map((d) => d.evento)).toEqual(['conectado', 'caiu'])
    expect(fluxo.fim).toBe(true)
    expect((await mcp(sessao.sessao)).status).toBe(404)
  })

  it('eventos: token errado → 401; aviso de recurso do exe chega ao técnico', async () => {
    await start()
    const exe = await conectarExe('482917305')
    const { json: sessao } = await parear('482917305')
    expect((await ouvir(sessao.sessao, 'token-errado-0123456789abcdefghijklmnop')).status).toBe(401)
    const fluxo = await ouvir(sessao.sessao)
    await wait(20)
    exe.ws.send(JSON.stringify({ type: 'evento', evento: 'recurso', recurso: 'comandos', estado: 'desligado' }))
    exe.ws.send(JSON.stringify({ type: 'evento', evento: 'recurso', recurso: 'inventado', estado: 'ligado' }))
    await wait(40)
    expect(fluxo.dados).toEqual([
      { evento: 'conectado', admin: false },
      { evento: 'recurso', recurso: 'comandos', estado: 'desligado' }
    ])
    fluxo.fechar()
  })

  it('cliente encerra → sessão acaba com motivo "cliente"', async () => {
    await start()
    const exe = await conectarExe('482917305')
    const { json: sessao } = await parear('482917305')
    const fluxo = await ouvir(sessao.sessao)
    exe.ws.send(JSON.stringify({ type: 'encerrar' }))
    await wait(40)
    expect(fluxo.dados.at(-1)).toEqual({ evento: 'encerrado', motivo: 'cliente' })
    expect((await mcp(sessao.sessao)).status).toBe(404)
  })

  it('técnico encerra: precisa do token; o exe é avisado e desconectado', async () => {
    await start()
    const exe = await conectarExe('482917305')
    const { json: sessao } = await parear('482917305')
    const errado = await http('POST', `/suporte/encerrar/${sessao.sessao}`, { headers: { authorization: 'Bearer token-errado-0123456789abcdefghijklmnop' } })
    expect(errado.status).toBe(401)
    const r = await http('POST', `/suporte/encerrar/${sessao.sessao}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(r.json).toEqual({ ok: true })
    await wait(50)
    expect(exe.frames.at(-1)).toEqual({ type: 'encerrar', motivo: 'tecnico' })
    expect(exe.ws.readyState).toBe(WebSocket.CLOSED)
    expect(suporte.stats()).toEqual({ exes: 0, sessoes: 0 })
  })

  it('exe reaberto como admin retoma a sessão com o segredo; segredo errado é negado', async () => {
    await start()
    const antigo = await conectarExe('482917305')
    const { json: sessao } = await parear('482917305')
    await wait(20)
    const { segredo } = antigo.frames.find((f) => f.type === 'retomar')
    const fluxo = await ouvir(sessao.sessao)

    const intruso = await conectarExe(undefined, { hello: { retomar: { sessao: sessao.sessao, segredo: 'x'.repeat(43) } } })
    expect(intruso.primeira).toEqual({ type: 'negado', motivo: 'invalido' })

    const elevado = await conectarExe(undefined, {
      hello: { retomar: { sessao: sessao.sessao, segredo }, admin: true },
      onOpen: (ws, open) => responder(ws, open.rid, 200, {}, 'sou-o-elevado')
    })
    expect(elevado.primeira).toEqual({ type: 'ready', sessao: sessao.sessao })
    expect((await mcp(sessao.sessao)).body).toBe('sou-o-elevado')
    // O exe antigo sai sem derrubar a sessão.
    antigo.ws.terminate()
    await wait(40)
    expect((await mcp(sessao.sessao)).body).toBe('sou-o-elevado')
    expect(fluxo.dados.map((d) => d.evento)).toEqual(['conectado', 'admin'])
    fluxo.fechar()
  })
})

describe('suporte — entrada do exe e manutenção', () => {
  it('exe antigo recebe "atualize"; código repetido e hello sem código são negados', async () => {
    await start()
    expect((await conectarExe('482917305', { hello: { v: 0 } })).primeira).toEqual({ type: 'atualize', url: DOWNLOAD_URL })
    expect((await conectarExe('482917305')).primeira).toEqual({ type: 'ready' })
    expect((await conectarExe('482917305')).primeira).toEqual({ type: 'negado', motivo: 'codigo' })
    expect((await conectarExe('12345')).primeira).toEqual({ type: 'negado', motivo: 'invalido' })
  })

  it('limite de exes conectados → "cheio"', async () => {
    await start({ maximoExes: 2, maximoPorEndereco: 99 })
    expect((await conectarExe('100000001')).primeira.type).toBe('ready')
    expect((await conectarExe('100000002')).primeira.type).toBe('ready')
    expect((await conectarExe('100000003')).primeira).toEqual({ type: 'negado', motivo: 'cheio' })
  })

  it('exe sem técnico por 15 min é desconectado; em sessão, não', async () => {
    await start()
    const ocioso = await conectarExe('100000001')
    await conectarExe('100000002')
    const { json: sessao } = await parear('100000002')
    relogio += 15 * 60_000 + 1
    for (const exe of suporte.exes.values()) exe.lastSeen = relogio // os dois seguem "vivos"
    suporte.sessoes.get(sessao.sessao).exe.lastSeen = relogio
    suporte.sweep()
    await wait(40)
    expect(ocioso.frames.at(-1)).toEqual({ type: 'negado', motivo: 'ocioso' })
    expect(suporte.exes.has('100000001')).toBe(false)
    expect(suporte.sessoes.has(sessao.sessao)).toBe(true)
  })

  it('exe mudo por mais de 65 s cai no sweep e leva a sessão junto; ping recebe pong', async () => {
    await start()
    const exe = await conectarExe('100000001')
    const pong = new Promise((resolve) => exe.ws.on('message', (raw) => { if (JSON.parse(raw.toString()).type === 'pong') resolve(true) }))
    exe.ws.send(JSON.stringify({ type: 'ping' }))
    expect(await pong).toBe(true)
    const { json: sessao } = await parear('100000001')
    relogio += 66_000
    suporte.sweep()
    expect(suporte.sessoes.has(sessao.sessao)).toBe(false)
    expect(suporte.stats()).toEqual({ exes: 0, sessoes: 0 })
  })

  it('o log não traz token, chave nem código', async () => {
    const linhas = []
    await start({ log: (l) => linhas.push(l) })
    await conectarExe('482917305', { onOpen: (ws, open) => responder(ws, open.rid, 200, {}, 'segredo-da-resposta') })
    await parear('000000001', { ip: '203.0.113.30' })
    const { json: sessao } = await parear('482917305')
    await mcp(sessao.sessao, { body: '{"conteudo":"segredo-da-chamada"}' })
    await http('POST', `/suporte/encerrar/${sessao.sessao}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    const tudo = linhas.join('\n')
    expect(linhas.length).toBeGreaterThan(1)
    for (const proibido of [TOKEN, CHAVE, '482917305', sessao.sessao, 'segredo-da']) expect(tudo).not.toContain(proibido)
  })
})

describe('suporte — o caminho do celular (/__relay) segue intacto', () => {
  it('PC no /__relay e exe no /__suporte convivem no mesmo servidor', async () => {
    await start()
    await conectarExe('482917305')
    const pc = new WebSocket(`ws://127.0.0.1:${port}/__relay`)
    sockets.push(pc)
    await new Promise((resolve) => {
      pc.on('open', () => pc.send(JSON.stringify({ type: 'hello', token: 'tok-celular' })))
      pc.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'ready') resolve()
        else if (msg.type === 'open') responder(pc, msg.rid, 200, {}, `celular:${msg.url}`)
      })
    })
    const r = await http('GET', '/api/state?token=tok-celular')
    expect(r.body).toBe('celular:/api/state?token=tok-celular')
    expect((await http('GET', '/api/state')).status).toBe(400)
    expect((await parear('482917305')).status).toBe(200)
  })

  it('upgrade em caminho desconhecido é recusado', async () => {
    await start()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__outro`)
    sockets.push(ws)
    const erro = await new Promise((resolve) => ws.on('error', (e) => resolve(e.message)))
    expect(erro).toContain('400')
  })

  it('sem o canal de suporte ligado, /suporte cai no roteamento antigo', async () => {
    broker = createBroker({})
    await new Promise((resolve) => broker.listen(0, resolve))
    port = broker.server.address().port
    expect((await http('GET', '/suporte')).status).toBe(400) // "token ausente", como qualquer caminho
  })
})
