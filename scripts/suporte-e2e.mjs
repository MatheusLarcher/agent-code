// Ponta a ponta do suporte remoto, tudo nesta máquina: relay local + o exe do cliente
// (dist/AgentCode-Suporte.exe) + um cliente MCP de verdade no lugar do Agent Code do
// técnico. Quem clica em Permitir, nas chaves e em Encerrar é o helper local de controle
// do Windows, DE FORA do exe — não existe atalho de aceite em nenhum build.
//
// Antes: npm run suporte:build && npm run windows-control:build
// O cliente MCP é o oficial (@modelcontextprotocol/sdk), que vem com o SDK do Claude.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createBroker } from '../broker/src/broker.js'
import { createSuporte } from '../broker/src/suporte.js'
import { casoDoCelular, celularDepoisDeEncerrar, celularSemPermitir } from './suporte-e2e-celular.mjs'
import { casoDoChrome, chromeAntesDeEncerrar, chromeDepoisDeEncerrar, chromeSemPermitir, fecharChromeDeTeste } from './suporte-e2e-chrome.mjs'

const root = resolve(import.meta.dirname, '..')
const exePath = resolve(root, 'dist/AgentCode-Suporte.exe')
const helperPath = resolve(root, 'out/windows-control/AgentCode.WindowsControl.exe')
const TECNICO = 'Teste E2E'
const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms))

if (process.platform !== 'win32') {
  console.log('Suporte remoto: ponta a ponta só roda no Windows.')
  process.exit(0)
}
for (const [caminho, comando] of [[exePath, 'npm run suporte:build'], [helperPath, 'npm run windows-control:build']]) {
  if (!existsSync(caminho)) {
    console.error(`Falta ${caminho}. Rode: ${comando}`)
    process.exit(1)
  }
}

let passos = 0
function confere(condicao, oQue) {
  if (!condicao) throw new Error(oQue)
}
function ok(oQue) {
  passos++
  console.log(`ok      ${oQue}`)
}
async function ate(condicao, oQue, prazoMs = 20_000) {
  const fim = Date.now() + prazoMs
  for (;;) {
    const valor = await condicao()
    if (valor) return valor
    if (Date.now() > fim) throw new Error(`tempo esgotado esperando: ${oQue}`)
    await pausa(150)
  }
}

// ---- Relay local, com chave sorteada nesta execução ---------------------------
const chave = randomBytes(24).toString('base64url')
const registroDoRelay = []
const suporte = createSuporte({ chave, log: (linha) => registroDoRelay.push(linha) })
const broker = createBroker({ suporte, log: (linha) => registroDoRelay.push(linha) })
await new Promise((pronto) => broker.server.listen(0, '127.0.0.1', pronto))
const porta = broker.server.address().port
const base = `http://127.0.0.1:${porta}`

// ---- Helper de controle do Windows (os cliques "do cliente") --------------------
const helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
const esperas = new Map()
createInterface({ input: helper.stdout }).on('line', (linha) => {
  let resposta
  try { resposta = JSON.parse(linha) } catch { return }
  const espera = esperas.get(resposta.id)
  if (!espera) return
  esperas.delete(resposta.id)
  if (resposta.error) espera.falhar(new Error(resposta.error.message))
  else espera.resolver(resposta.result)
})
let proximoId = 0
function controle(method, params = {}) {
  const id = String(++proximoId)
  return new Promise((resolver, falhar) => {
    esperas.set(id, { resolver, falhar })
    helper.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
}

let exe = null
let pasta = null
let eventosAbort = null
let chromeDeTeste = null
const sairam = { codigo: undefined }

async function janelaDoSuporte() {
  const janelas = await controle('list_windows')
  return janelas.find((janela) => janela.processId === exe.pid && janela.title === 'Agent Code Suporte')
}
// O que a janela mostra, lido de fora por acessibilidade (textos e botões).
async function campos(windowId) {
  return (await controle('get_accessibility', { windowId })).tree
}
// Clique "do cliente", por acessibilidade. Numa janela WPF o helper local costuma
// acusar "não respondeu em 1,2 s" e o clique chega logo depois; por isso cada passo
// confere o EFEITO do clique (resposta do relay, aviso, estado), nunca só este retorno.
async function clicar(windowId, name, action = 'click') {
  const feito = await controle('run_steps', { windowId, steps: [{ action, target: { name, type: 'Button' } }] })
  const erro = feito.failedStep?.error ?? ''
  confere(feito.ok !== false || erro.includes('não respondeu'), `o clique em "${name}" falhou: ${JSON.stringify(feito).slice(0, 400)}`)
}
function parear(codigo, comChave = chave) {
  return fetch(`${base}/suporte/parear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-suporte-chave': comChave },
    body: JSON.stringify({ codigo, tecnico: TECNICO })
  })
}
function textoDe(resultado) {
  return resultado.content.filter((bloco) => bloco.type === 'text').map((bloco) => bloco.text).join('\n')
}

try {
  // ---- O exe abre e mostra o código ---------------------------------------------
  exe = spawn(exePath, [], {
    env: { ...process.env, AGENT_CODE_SUPORTE_RELAY: `ws://127.0.0.1:${porta}` },
    stdio: 'ignore'
  })
  exe.on('exit', (codigo) => { sairam.codigo = codigo ?? -1 })
  await ate(() => suporte.exes.size === 1, 'o exe se apresentar ao relay')
  const codigo = [...suporte.exes.keys()][0]
  confere(/^\d{9}$/.test(codigo), 'o código não tem 9 dígitos')
  const janela = await ate(janelaDoSuporte, 'a janela do suporte aparecer')
  const tela = await ate(async () => {
    const texto = await campos(janela.id)
    return texto.includes(codigo.slice(0, 3)) ? texto : null
  }, 'o código aparecer na janela')
  confere(tela.includes(codigo.slice(3, 6)) && tela.includes(codigo.slice(6)), 'a janela não mostra o código inteiro')
  confere(tela.includes('Aguardando o técnico') && tela.includes('Copiar'), 'a janela não está no estado "Aguardando o técnico"')
  ok('o exe abriu, conectou ao relay local e mostra o código')

  // ---- As três travas -------------------------------------------------------------
  confere((await parear(codigo, 'chave-errada')).status === 403, 'aceitou chave da equipe errada')
  const outro = codigo === '000000000' ? '000000001' : '000000000'
  confere((await parear(outro)).status === 404, 'aceitou código errado')
  ok('chave errada e código errado são recusados')

  const recusa = parear(codigo)
  const telaPedido = await ate(async () => {
    const texto = await campos(janela.id)
    return texto.includes('Permitir') ? texto : null
  }, 'o pedido de acesso aparecer')
  confere(telaPedido.includes(`${TECNICO} Quer Acessar Este Computador`), 'o pedido não mostra quem quer acessar')
  confere(suporte.sessoes.size === 0, 'a sessão nasceu antes do clique do cliente')
  await clicar(janela.id, 'Recusar')
  confere((await recusa).status === 403, 'a recusa do cliente não chegou ao técnico')
  confere(suporte.sessoes.size === 0, 'recusa abriu sessão')
  ok('sem o clique não há sessão; Recusar devolve 403 ao técnico')

  const pedido = parear(codigo)
  await ate(async () => (await campos(janela.id)).includes('Permitir'), 'o segundo pedido aparecer')
  await clicar(janela.id, 'Permitir')
  const aceite = await pedido
  confere(aceite.status === 200, `parear devolveu ${aceite.status}`)
  const { sessao, token, info } = await aceite.json()
  confere(typeof sessao === 'string' && typeof token === 'string' && token.length >= 32, 'resposta do pareamento incompleta')
  confere(info.sistema === 'windows' && info.pc.toLowerCase() === hostname().toLowerCase(), 'info do exe errada')
  confere((await parear(codigo)).status === 404, 'o código valeu para uma segunda sessão')
  ok('parear + clique em Permitir entregam sessão e token')

  // ---- Avisos do exe para o técnico -----------------------------------------------
  const eventos = []
  eventosAbort = new AbortController()
  const fluxo = await fetch(`${base}/suporte/eventos/${sessao}`, { headers: { authorization: `Bearer ${token}` }, signal: eventosAbort.signal })
  confere(fluxo.status === 200, `eventos devolveu ${fluxo.status}`)
  ;(async () => {
    const leitor = fluxo.body.pipeThrough(new TextDecoderStream()).getReader()
    let resto = ''
    try {
      for (;;) {
        const { value, done } = await leitor.read()
        if (done) break
        resto += value
        for (let fim = resto.indexOf('\n\n'); fim >= 0; fim = resto.indexOf('\n\n')) {
          const bloco = resto.slice(0, fim)
          resto = resto.slice(fim + 2)
          if (bloco.startsWith('data: ')) eventos.push(JSON.parse(bloco.slice(6)))
        }
      }
    } catch { /* fluxo fechado */ }
  })()

  // ---- O técnico fala MCP com o exe -----------------------------------------------
  const mcpUrl = new URL(`${base}/suporte/mcp/${sessao}`)
  const cliente = new Client({ name: 'suporte-e2e', version: '1.0.0' })
  await cliente.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  const { tools } = await cliente.listTools()
  confere(tools.length >= 30 && tools.every((tool) => tool.name.startsWith('remoto_')), `tools/list inesperado (${tools.length})`)
  confere(tools.every((tool) => tool.annotations && typeof tool.annotations.readOnlyHint === 'boolean'), 'ferramenta sem anotações')
  ok(`tools/list: ${tools.length} ferramentas, todas com o prefixo remoto_`)

  // Instalar a extensão pela tela leva mais que o minuto padrão do cliente MCP.
  const chamar = (name, args = {}) => cliente.callTool({ name, arguments: args }, undefined, { timeout: 200_000 })
  const ctx = { chamar, textoDe, confere, ate, ok, campos, clicar, controle, eventos, janela, tools }
  const retrato = await chamar('remoto_info')
  const dados = JSON.parse(textoDe(retrato))
  confere(dados.pc.toLowerCase() === hostname().toLowerCase() && dados.recursos.tela === 'ligado' && dados.recursos.administrador === 'travado', 'remoto_info errado')
  ok('remoto_info devolve o computador e o estado dos recursos')

  const frase = 'ação concluída: coração, pão, À, ñ'
  const comando = await chamar('remoto_executar', { comando: `Write-Output '${frase}'; exit 7` })
  confere(textoDe(comando).includes(frase), `acentos perdidos no comando: ${textoDe(comando)}`)
  confere(textoDe(comando).includes('código de saída 7'), `código de saída errado: ${textoDe(comando)}`)
  ok('remoto_executar devolve a saída com acentos e o código de saída')

  pasta = mkdtempSync(join(tmpdir(), 'agentcode-suporte-e2e-'))
  const bytes = randomBytes(300_000)
  const binario = join(pasta, 'ida e volta.bin')
  const enviado = await chamar('remoto_arquivo_enviar', { caminho: binario, conteudoBase64: bytes.toString('base64') })
  confere(!enviado.isError, `enviar falhou: ${textoDe(enviado)}`)
  const baixado = await chamar('remoto_arquivo_baixar', { caminho: binario })
  const recurso = baixado.content.find((bloco) => bloco.type === 'resource')
  confere(recurso && Buffer.from(recurso.resource.blob, 'base64').equals(bytes), 'o arquivo voltou diferente do que foi')
  const anotacao = join(pasta, 'anotação.txt')
  await chamar('remoto_arquivo_escrever', { caminho: anotacao, conteudo: 'primeira\nsegunda: ação\n' })
  await chamar('remoto_arquivo_editar', { caminho: anotacao, antigo: 'segunda', novo: 'última' })
  const lido = textoDe(await chamar('remoto_arquivo_ler', { caminho: anotacao }))
  confere(lido.includes('2\túltima: ação'), `leitura depois da edição errada: ${lido}`)
  ok('arquivo de ida e volta (300 KB binário) e texto escrito, editado e lido')

  const captura = await chamar('remoto_captura_tela')
  const imagem = captura.content.find((bloco) => bloco.type === 'image')
  const png = imagem ? Buffer.from(imagem.data, 'base64') : Buffer.alloc(0)
  confere(imagem?.mimeType === 'image/png' && png.length > 2000 && png.subarray(1, 4).toString() === 'PNG', 'captura de tela vazia')
  ok(`captura de tela não vazia (${Math.round(png.length / 1024)} KB)`)

  const remotas = JSON.parse(textoDe(await chamar('remoto_list_windows')))
  const deFora = await controle('list_windows')
  confere(Array.isArray(remotas) && remotas.length > 0, 'remoto_list_windows veio vazio')
  confere(deFora.some((item) => item.processId === exe.pid), 'o helper de fora deveria enxergar a janela do suporte')
  confere(!remotas.some((item) => item.processId === exe.pid), 'a janela do suporte apareceu em remoto_list_windows')
  const proibido = await chamar('remoto_form_fields', { windowId: janela.id })
  confere(proibido.isError && textoDe(proibido).includes('não existe mais'), 'a IA conseguiu ler a própria janela do suporte')
  const alvo = remotas.find((item) => !item.isMinimized) ?? remotas[0]
  const estado = await chamar('remoto_get_state', { windowId: alvo.id, includeText: false })
  confere(!estado.isError && estado.content.some((bloco) => bloco.type === 'image'), `remoto_get_state falhou: ${textoDe(estado)}`)
  ok('remoto_list_windows lista as janelas do PC e nunca as do suporte')

  // ---- A chave do cliente manda ------------------------------------------------------
  await clicar(janela.id, 'Arquivos', 'toggle')
  await ate(() => eventos.some((evento) => evento.evento === 'recurso' && evento.recurso === 'arquivos' && evento.estado === 'desligado'), 'o aviso de recurso desligado')
  const barrado = await chamar('remoto_arquivo_ler', { caminho: anotacao })
  confere(barrado.isError && textoDe(barrado).includes('O cliente desligou este recurso'), `arquivos desligado não bloqueou: ${textoDe(barrado)}`)
  await clicar(janela.id, 'Arquivos', 'toggle')
  await ate(() => eventos.some((evento) => evento.evento === 'recurso' && evento.recurso === 'arquivos' && evento.estado === 'ligado'), 'o aviso de recurso religado')
  confere(!(await chamar('remoto_arquivo_ler', { caminho: anotacao })).isError, 'religar não devolveu o recurso')
  const travado = await chamar('remoto_elevar')
  confere(travado.isError && textoDe(travado).includes('remoto_pedir_recurso'), 'elevar passou sem o cliente liberar')
  ok('o cliente desliga e religa um recurso na janela, e o técnico é avisado')

  // ---- Token -------------------------------------------------------------------------
  const corpo = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const cabecalhos = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const errado = await fetch(mcpUrl, { method: 'POST', headers: { ...cabecalhos, authorization: `Bearer ${token.slice(0, -2)}xx` }, body: corpo })
  confere(errado.status === 401, `token errado devolveu ${errado.status}`)
  confere((await fetch(mcpUrl, { method: 'POST', headers: cabecalhos, body: corpo })).status === 401, 'aceitou chamada sem token')
  const semSessao = await fetch(`${base}/suporte/mcp/sessao-que-nao-existe`, { method: 'POST', headers: { ...cabecalhos, authorization: `Bearer ${token}` }, body: corpo })
  confere(semSessao.status === 404, `sessão desconhecida devolveu ${semSessao.status}`)
  ok('token errado, ausente e sessão desconhecida são recusados')

  // ---- Recursos extras: só depois do Permitir do cliente -------------------------------
  await chromeSemPermitir(ctx)
  await celularSemPermitir(ctx)
  ok('sem o Permitir, as ferramentas do Chrome e do celular respondem "peça ao cliente"')
  chromeDeTeste = {}
  await casoDoChrome(ctx, chromeDeTeste)
  await chromeAntesDeEncerrar(ctx, chromeDeTeste)
  const celularDeTeste = {}
  await casoDoCelular(ctx, celularDeTeste)

  // ---- Encerrar ----------------------------------------------------------------------
  const fundo = await chamar('remoto_executar', { comando: 'Start-Sleep -Seconds 300', segundoPlano: true })
  const pid = Number(/p(\d+)/.exec(textoDe(fundo))?.[1])
  confere(pid > 0, 'o processo em segundo plano não iniciou')
  await clicar(janela.id, 'Encerrar').catch(() => {}) // a janela some no meio do clique
  await ate(() => sairam.codigo !== undefined, 'o exe fechar depois de Encerrar')
  await ate(() => suporte.sessoes.size === 0, 'o relay largar a sessão')
  await ate(() => eventos.some((evento) => evento.evento === 'encerrado'), 'o aviso de sessão encerrada')
  const depois = await fetch(mcpUrl, { method: 'POST', headers: { ...cabecalhos, authorization: `Bearer ${token}` }, body: corpo })
  confere(depois.status === 404, `depois de encerrar o relay devolveu ${depois.status}`)
  await ate(() => { try { process.kill(pid, 0); return false } catch { return true } }, 'o processo em segundo plano morrer', 10_000)
  ok('Encerrar fecha o exe, derruba a sessão, avisa o técnico e mata o que ficou rodando')
  await chromeDepoisDeEncerrar(ctx, chromeDeTeste)
  await celularDepoisDeEncerrar(ctx, celularDeTeste)

  // ---- O registro do relay não leva segredo ------------------------------------------
  const linhas = registroDoRelay.join('\n')
  confere(registroDoRelay.some((linha) => linha.includes('pareou')), 'o relay não registrou o pareamento')
  for (const segredo of [token, chave, codigo, frase]) confere(!linhas.includes(segredo), 'o registro do relay contém segredo ou conteúdo de chamada')
  ok('o registro do relay não traz token, chave, código nem conteúdo')

  console.log(`\n${passos} verificações passaram`)
} catch (erro) {
  console.error(`\nFALHOU  ${erro?.message ?? erro}`)
  if (registroDoRelay.length > 0) console.error(`registro do relay:\n  ${registroDoRelay.slice(-12).join('\n  ')}`)
  process.exitCode = 1
} finally {
  eventosAbort?.abort()
  if (exe && sairam.codigo === undefined) exe.kill()
  fecharChromeDeTeste(chromeDeTeste)
  helper.stdin.end()
  helper.kill()
  if (pasta) rmSync(pasta, { recursive: true, force: true })
  await broker.close().catch(() => {})
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref()
}
