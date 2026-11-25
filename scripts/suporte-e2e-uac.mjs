// Ponta a ponta da permissão de administrador do suporte remoto, COM UMA PESSOA na frente do
// PC: o Sim/Não do UAC fica na área protegida do Windows e nenhuma automação clica nele (é
// de propósito). Tudo nesta máquina: relay local + o exe do cliente + um cliente MCP.
//
// O helper de controle do Windows clica no Permitir da janela do suporte (sessão e recurso);
// o aviso do Windows é com você: na 1ª vez clique em NÃO, na 2ª clique em SIM.
//
// Antes: npm run suporte:build && npm run windows-control:build
// Rode:  node scripts/suporte-e2e-uac.mjs
// Com --ensaio ele para antes do aviso do Windows (confere o roteiro sem ninguém na frente).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createBroker } from '../broker/src/broker.js'
import { createSuporte } from '../broker/src/suporte.js'

const root = resolve(import.meta.dirname, '..')
const exePath = resolve(root, 'dist/AgentCode-Suporte.exe')
const helperPath = resolve(root, 'out/windows-control/AgentCode.WindowsControl.exe')
const PRAZO_DO_UAC_MS = 180_000
const ENSAIO = process.argv.includes('--ensaio')
const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms))

if (process.platform !== 'win32') {
  console.log('Suporte remoto: o teste do UAC só roda no Windows.')
  process.exit(0)
}
for (const [caminho, comando] of [[exePath, 'npm run suporte:build'], [helperPath, 'npm run windows-control:build']]) {
  if (!existsSync(caminho)) {
    console.error(`Falta ${caminho}. Rode: ${comando}`)
    process.exit(1)
  }
}

let passos = 0
const confere = (condicao, oQue) => { if (!condicao) throw new Error(oQue) }
const ok = (oQue) => { passos++; console.log(`ok      ${oQue}`) }
const peca = (oQue) => console.log(`\n>>> ${oQue}\n`)
async function ate(condicao, oQue, prazoMs = 20_000) {
  const fim = Date.now() + prazoMs
  for (;;) {
    const valor = await condicao()
    if (valor) return valor
    if (Date.now() > fim) throw new Error(`tempo esgotado esperando: ${oQue}`)
    await pausa(150)
  }
}

// Relay local, com chave sorteada nesta execução.
const chave = randomBytes(24).toString('base64url')
const suporte = createSuporte({ chave, log: () => {} })
const broker = createBroker({ suporte, log: () => {} })
await new Promise((pronto) => broker.server.listen(0, '127.0.0.1', pronto))
const base = `http://127.0.0.1:${broker.server.address().port}`

// Helper de controle do Windows: os cliques "do cliente" na janela do suporte.
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
const controle = (method, params = {}) => new Promise((resolver, falhar) => {
  const id = String(++proximoId)
  esperas.set(id, { resolver, falhar })
  helper.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
})

let exe = null
let elevou = false
const textoDe = (resultado) => resultado.content.filter((bloco) => bloco.type === 'text').map((bloco) => bloco.text).join('\n')

try {
  exe = spawn(exePath, [], { env: { ...process.env, AGENT_CODE_SUPORTE_RELAY: base.replace('http', 'ws') }, stdio: 'ignore' })
  await ate(() => suporte.exes.size === 1, 'o exe se apresentar ao relay')
  const codigo = [...suporte.exes.keys()][0]
  const janela = await ate(async () => (await controle('list_windows')).find((j) => j.processId === exe.pid && j.title === 'Agent Code Suporte'), 'a janela do suporte aparecer')
  const campos = async () => (await controle('get_accessibility', { windowId: janela.id })).tree
  const permitir = async (titulo) => {
    await ate(async () => (await campos()).includes(titulo), `o pedido "${titulo}" aparecer`)
    const feito = await controle('run_steps', { windowId: janela.id, steps: [{ action: 'click', target: { name: 'Permitir', type: 'Button' } }] })
    confere(feito.ok !== false || String(feito.failedStep?.error ?? '').includes('não respondeu'), `o clique em Permitir falhou: ${JSON.stringify(feito).slice(0, 300)}`)
  }

  const pedido = fetch(`${base}/suporte/parear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-suporte-chave': chave },
    body: JSON.stringify({ codigo, tecnico: 'Teste do UAC' })
  })
  await permitir('Quer Acessar Este Computador')
  const aceite = await pedido
  confere(aceite.status === 200, `parear devolveu ${aceite.status}`)
  const { sessao, token } = await aceite.json()
  const cliente = new Client({ name: 'suporte-e2e-uac', version: '1.0.0' })
  await cliente.connect(new StreamableHTTPClientTransport(new URL(`${base}/suporte/mcp/${sessao}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  const chamar = (name, args = {}) => cliente.callTool({ name, arguments: args }, undefined, { timeout: PRAZO_DO_UAC_MS + 90_000 })
  const info = async () => JSON.parse(textoDe(await chamar('remoto_info')))
  const antes = await info()
  confere(antes.administrador === false && antes.recursos.administrador === 'travado', 'o suporte já começou como administrador: rode este teste num terminal comum')
  ok('sessão aberta, sem administrador')

  const travado = await chamar('remoto_elevar')
  confere(travado.isError && textoDe(travado).includes('remoto_pedir_recurso'), 'elevar passou sem o cliente liberar o recurso')
  const liberar = chamar('remoto_pedir_recurso', { recurso: 'administrador' })
  await permitir('Permitir Acesso de Administrador?')
  confere(!(await liberar).isError, 'o cliente permitiu e o recurso não liberou')
  ok('sem o Permitir do cliente não eleva; com ele, o recurso libera')

  const comOAvisoDoWindows = async () => {
    // ---- UAC negado: segue sem administrador -----------------------------------------
    peca('1 de 2 — O Windows vai perguntar se o Agent Code Suporte pode fazer alterações. Clique em NÃO.')
    const negado = await chamar('remoto_elevar')
    confere(negado.isError && textoDe(negado).includes('não confirmou'), `com o Não, elevar respondeu: ${textoDe(negado)}`)
    const depoisDoNao = await info()
    confere(depoisDoNao.administrador === false, 'o suporte virou administrador mesmo com o Não')
    confere(!(await chamar('remoto_executar', { comando: 'hostname' })).isError, 'a sessão parou de responder depois do Não')
    ok('UAC negado: o técnico é avisado e a sessão segue sem administrador')

    // ---- UAC aceito: a mesma sessão continua, elevada ----------------------------------
    if ((await info()).recursos.administrador !== 'ligado') {
      const denovo = chamar('remoto_pedir_recurso', { recurso: 'administrador' })
      await permitir('Permitir Acesso de Administrador?')
      confere(!(await denovo).isError, 'o cliente permitiu de novo e o recurso não liberou')
    }
    peca('2 de 2 — O Windows vai perguntar de novo. Agora clique em SIM.')
    const aceito = await chamar('remoto_elevar')
    confere(!aceito.isError, `com o Sim, elevar respondeu: ${textoDe(aceito)}`)
    elevou = true
    const elevado = await ate(async () => {
      try {
        const dados = await info()
        return dados.administrador ? dados : null
      } catch {
        return null // a troca de exe leva um instante
      }
    }, 'a mesma sessão responder como administrador', 60_000)
    confere(suporte.sessoes.size === 1 && suporte.sessoes.has(sessao), 'a sessão não é mais a mesma')
    const papel = textoDe(await chamar('remoto_executar', {
      comando: '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    }))
    confere(papel.includes('True'), `o comando não rodou como administrador: ${papel}`)
    ok(`UAC aceito: a mesma sessão continua, agora como administrador (${elevado.pc})`)
  }
  if (ENSAIO) console.log('\n(ensaio: parei antes do aviso do Windows; rode sem --ensaio para os dois cliques)')
  else await comOAvisoDoWindows()

  await fetch(`${base}/suporte/encerrar/${sessao}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  await ate(() => suporte.sessoes.size === 0, 'o relay largar a sessão')
  ok('sessão encerrada pelo técnico')
  console.log(`\n${passos} verificações passaram`)
} catch (erro) {
  console.error(`\nFALHOU  ${erro?.message ?? erro}`)
  process.exitCode = 1
} finally {
  if (exe && !elevou) exe.kill()
  // O exe elevado não pode ser fechado por este script (roda acima dele): feche a janela.
  if (elevou) peca('Feche a janela do Agent Code Suporte que ficou aberta (ela roda como administrador).')
  helper.stdin.end()
  helper.kill()
  await broker.close().catch(() => {})
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref()
}
