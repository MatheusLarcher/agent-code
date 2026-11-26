// Confere o suporte remoto PELO RELAY DE PRODUÇÃO, nesta máquina: abre o exe do cliente (sem
// variável de teste: ele usa o endereço fixo), pareia com a chave da equipe, o helper de
// controle do Windows clica em Permitir, e uma chamada de leitura e um comando passam.
//
// A chave vem de um ARQUIVO fora do repositório (nunca por argumento nem variável):
//   node scripts/suporte-e2e-producao.mjs <arquivo-com-a-chave> [caminho-do-exe]
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const root = resolve(import.meta.dirname, '..')
const [arquivoDaChave, exeArg] = process.argv.slice(2)
const exePath = resolve(exeArg ?? resolve(root, 'dist/AgentCode-Suporte.exe'))
const helperPath = resolve(root, 'out/windows-control/AgentCode.WindowsControl.exe')
const base = 'https://agent-code.larchertech.com'
if (!arquivoDaChave || !existsSync(arquivoDaChave) || !existsSync(exePath) || !existsSync(helperPath)) {
  console.error('Uso: node scripts/suporte-e2e-producao.mjs <arquivo-com-a-chave> [caminho-do-exe]')
  process.exit(2)
}
const chave = readFileSync(arquivoDaChave, 'utf8').trim()
const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms))
const confere = (condicao, oQue) => { if (!condicao) throw new Error(oQue) }
const ok = (oQue) => console.log(`ok      ${oQue}`)
async function ate(condicao, oQue, prazoMs = 30_000) {
  const fim = Date.now() + prazoMs
  for (;;) {
    const valor = await condicao()
    if (valor) return valor
    if (Date.now() > fim) throw new Error(`tempo esgotado esperando: ${oQue}`)
    await pausa(300)
  }
}

const helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
const esperas = new Map()
createInterface({ input: helper.stdout }).on('line', (linha) => {
  let r
  try { r = JSON.parse(linha) } catch { return }
  const e = esperas.get(r.id)
  if (!e) return
  esperas.delete(r.id)
  if (r.error) e.falhar(new Error(r.error.message))
  else e.resolver(r.result)
})
let seq = 0
const controle = (method, params = {}) => new Promise((resolver, falhar) => {
  const id = String(++seq)
  esperas.set(id, { resolver, falhar })
  helper.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
})

const ambiente = { ...process.env }
delete ambiente.AGENT_CODE_SUPORTE_RELAY
let exe = null
try {
  exe = spawn(exePath, [], { env: ambiente, stdio: 'ignore' })
  const janela = await ate(async () => (await controle('list_windows')).find((j) => j.processId === exe.pid && j.title === 'Agent Code Suporte'), 'a janela do suporte aparecer')
  const campos = async () => (await controle('get_accessibility', { windowId: janela.id })).tree
  // O código de 9 dígitos aparece na janela quando o exe alcança o relay.
  const codigo = await ate(async () => {
    const arvore = await campos()
    const partes = [1, 2, 3].map((n) => arvore.match(new RegExp(`name="(\\d{3})" id="Codigo${n}"`))?.[1])
    return partes.every(Boolean) ? partes.join('') : null
  }, 'o código aparecer na janela (exe ligado ao relay de produção)', 45_000)
  ok('o exe ligou no relay de produção e mostrou um código')

  const semChave = await fetch(`${base}/suporte/parear`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codigo, tecnico: 'Teste de produção' }) })
  confere(semChave.status === 403, `sem a chave o relay devolveu ${semChave.status}`)
  confere(!(await campos()).includes('Quer Acessar'), 'o cliente viu um pedido vindo sem a chave')
  ok('sem a chave da equipe o relay recusa e o cliente não vê pedido')

  const pedido = fetch(`${base}/suporte/parear`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-suporte-chave': chave }, body: JSON.stringify({ codigo, tecnico: 'Teste de produção' }) })
  await ate(async () => (await campos()).includes('Quer Acessar Este Computador'), 'o pedido aparecer na janela do cliente')
  await controle('run_steps', { windowId: janela.id, steps: [{ action: 'click', target: { name: 'Permitir', type: 'Button' } }] })
  const aceite = await pedido
  confere(aceite.status === 200, `parear devolveu ${aceite.status}`)
  const { sessao, token } = await aceite.json()
  ok('com a chave e o Permitir do cliente, a sessão abre')

  const cliente = new Client({ name: 'suporte-e2e-producao', version: '1.0.0' })
  await cliente.connect(new StreamableHTTPClientTransport(new URL(`${base}/suporte/mcp/${sessao}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  const texto = (r) => r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const info = JSON.parse(texto(await cliente.callTool({ name: 'remoto_info', arguments: {} })))
  confere(String(info.pc).toLowerCase() === hostname().toLowerCase(), `remoto_info devolveu outro computador: ${info.pc}`)
  const saida = texto(await cliente.callTool({ name: 'remoto_executar', arguments: { comando: 'hostname' } }))
  confere(saida.toLowerCase().includes(hostname().toLowerCase()), `o comando devolveu: ${saida.slice(0, 120)}`)
  ok('remoto_info e um comando passaram pelo relay de produção')

  const fim = await fetch(`${base}/suporte/encerrar/${sessao}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  confere(fim.ok, `encerrar devolveu ${fim.status}`)
  ok('sessão encerrada pelo técnico')
  console.log('\nproducao: tudo certo')
} catch (erro) {
  console.error(`\nFALHOU  ${erro?.message ?? erro}`)
  process.exitCode = 1
} finally {
  if (exe) exe.kill()
  helper.stdin.end()
  helper.kill()
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref()
}
