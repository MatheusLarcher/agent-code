// Caso do celular no ponta a ponta do suporte remoto (scripts/suporte-e2e.mjs).
// O download das ferramentas do Google é o de verdade, pelo exe; não precisa de aparelho
// ligado: sem ele a lista vem vazia, com o que pedir ao cliente. O adb de outros programas
// deste PC (o do próprio Agent Code, por exemplo) tem que continuar de pé do começo ao fim.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { responderPedido } from './suporte-e2e-chrome.mjs'

export const pastaDasFerramentas = join(process.env.LOCALAPPDATA ?? '', 'AgentCodeSuporte', 'platform-tools')
const TITULO = 'Permitir o Controle do Celular?'
const DETALHE = 'Baixa ferramentas do Google (15 MB), apagadas ao encerrar.'

function powershell(comando) {
  const feito = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', comando], { encoding: 'utf8' })
  return (feito.stdout ?? '').trim()
}

function lista(json) {
  if (!json) return []
  const valor = JSON.parse(json)
  return Array.isArray(valor) ? valor : [valor]
}

/** Os adb.exe abertos neste PC: os do suporte rodam de dentro da pasta da sessão. */
function adbs() {
  const todos = lista(powershell("Get-CimInstance Win32_Process -Filter \"Name='adb.exe'\" | Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress"))
    .map((item) => ({ pid: item.ProcessId, caminho: item.ExecutablePath ?? '' }))
  const doSuporte = (item) => item.caminho.toLowerCase().startsWith(pastaDasFerramentas.toLowerCase())
  return { doSuporte: todos.filter(doSuporte), deOutros: todos.filter((item) => !doSuporte(item)) }
}

/** A chave de pareamento do adb fica sempre na pasta do usuário (o adb não deixa mudar). */
const chaveDoPc = join(process.env.USERPROFILE ?? '', '.android', 'adbkey')
const retratoDaChave = () => (existsSync(chaveDoPc) ? `${statSync(chaveDoPc).mtimeMs}|${statSync(chaveDoPc).size}` : null)

const vivo = (pid) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Antes do Permitir, toda remoto_android_* responde "peça ao cliente". */
export async function celularSemPermitir({ chamar, textoDe, confere, tools }) {
  const doCelular = tools.filter((tool) => tool.name.startsWith('remoto_android_'))
  confere(doCelular.length === 8, `${doCelular.length} ferramentas do celular, esperava 8`)
  const escrita = doCelular.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name).sort()
  confere(escrita.join() === 'remoto_android_instalar,remoto_android_shell', `marcadas como escrita: ${escrita.join()}`)
  const leitura = doCelular.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name).sort()
  confere(leitura.join() === 'remoto_android_captura,remoto_android_dispositivos', `marcadas como leitura: ${leitura.join()}`)
  const argumentos = {
    remoto_android_tocar: { x: 0.5, y: 0.5 },
    remoto_android_deslizar: { x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2 },
    remoto_android_digitar: { texto: 'teste' },
    remoto_android_tecla: { tecla: 'HOME' },
    remoto_android_instalar: { caminho: 'C:\\nao-existe.apk' },
    remoto_android_shell: { comando: 'getprop ro.product.model' }
  }
  for (const { name } of doCelular) {
    const barrada = await chamar(name, argumentos[name] ?? {})
    confere(barrada.isError && textoDe(barrada).includes('peça ao cliente'), `${name} passou sem o Permitir: ${textoDe(barrada)}`)
  }
  confere(!existsSync(pastaDasFerramentas), 'a pasta das ferramentas existe antes do Permitir')
}

/** `estado` guarda o que havia antes, para conferir depois de encerrar. */
export async function casoDoCelular(ctx, estado) {
  const { chamar, textoDe, confere, ate, ok, eventos } = ctx
  estado.deOutros = adbs().deOutros
  estado.chave = retratoDaChave()

  // ---- O cliente decide --------------------------------------------------------
  const recusa = chamar('remoto_pedir_recurso', { recurso: 'celular' })
  await responderPedido(ctx, TITULO, DETALHE, 'Não')
  const negado = await recusa
  confere(negado.isError && textoDe(negado).includes('não permitiu'), `o "Não" do cliente não chegou: ${textoDe(negado)}`)
  confere(!existsSync(pastaDasFerramentas), 'baixou as ferramentas com o cliente dizendo não')

  const pedido = chamar('remoto_pedir_recurso', { recurso: 'celular' })
  await responderPedido(ctx, TITULO, DETALHE, 'Permitir')
  const liberado = await pedido
  confere(!liberado.isError && textoDe(liberado).includes('Depuração USB'), `o Permitir não preparou o celular: ${textoDe(liberado)}`)
  await ate(() => eventos.some((evento) => evento.evento === 'recurso' && evento.recurso === 'celular' && evento.estado === 'ligado'), 'o aviso de celular liberado')

  // ---- Download de verdade, só os três arquivos, assinados pelo Google ----------------
  const arquivos = readdirSync(pastaDasFerramentas).sort((a, b) => a.localeCompare(b))
  confere(arquivos.join() === 'adb.exe,AdbWinApi.dll,AdbWinUsbApi.dll', `a pasta deveria ter só o adb e as duas bibliotecas: ${arquivos.join()}`)
  for (const arquivo of arquivos) {
    // Conferência de fora do exe, pelo Windows: a mesma que o exe fez antes de usar.
    const assinatura = powershell(`$s = Get-AuthenticodeSignature -LiteralPath '${join(pastaDasFerramentas, arquivo)}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`)
    confere(assinatura.startsWith('Valid|') && assinatura.includes('O=Google LLC'), `${arquivo} sem assinatura válida do Google: ${assinatura}`)
  }
  confere(adbs().doSuporte.length === 0, 'o adb rodou no Permitir, antes de qualquer ferramenta')
  ok('Celular: "Não" recusa; Permitir baixa só o adb, com assinatura digital válida do Google')

  // ---- Lista de aparelhos --------------------------------------------------------------
  const resposta = await chamar('remoto_android_dispositivos')
  confere(!resposta.isError, `remoto_android_dispositivos falhou: ${textoDe(resposta)}`)
  const { dispositivos, oQueFazer } = JSON.parse(textoDe(resposta))
  confere(Array.isArray(dispositivos), 'a lista de aparelhos não veio')
  if (dispositivos.length === 0) {
    confere(oQueFazer?.includes('Depuração USB') && oQueFazer.includes('cabo USB'), `lista vazia sem instrução: ${oQueFazer}`)
    const semAparelho = await chamar('remoto_android_captura')
    confere(semAparelho.isError && textoDe(semAparelho).includes('Nenhum aparelho ligado'), `captura sem aparelho: ${textoDe(semAparelho)}`)
  }

  // O adb do suporte roda de dentro da pasta, numa porta só dele e só nesta máquina.
  const doSuporte = adbs().doSuporte
  confere(doSuporte.length > 0, 'o servidor do adb do suporte não está rodando')
  const escutas = lista(powershell(`Get-NetTCPConnection -State Listen -OwningProcess ${doSuporte.map((item) => item.pid).join(',')} -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort | ConvertTo-Json -Compress`))
  confere(escutas.length > 0 && escutas.every((porta) => porta.LocalAddress === '127.0.0.1' && porta.LocalPort !== 5037), `o adb do suporte deveria escutar só em 127.0.0.1, fora da porta padrão: ${JSON.stringify(escutas)}`)
  confere(estado.deOutros.every((item) => vivo(item.pid)), 'o adb de outro programa deste PC foi derrubado')
  estado.usou = true
  ok(dispositivos.length === 0
    ? 'Celular: sem aparelho, a lista vem vazia com o que pedir ao cliente; o adb roda em porta própria'
    : `Celular: ${dispositivos.length} aparelho(s) na lista (${dispositivos.map((item) => item.estado).join(', ')}); o adb roda em porta própria`)
}

/** Depois do Encerrar: pasta apagada, nenhum adb do suporte, e o adb dos outros programas intacto. */
export async function celularDepoisDeEncerrar({ confere, ate, ok }, estado) {
  if (!estado?.usou) return
  await ate(() => !existsSync(pastaDasFerramentas), 'a pasta das ferramentas ser apagada', 20_000)
  confere(adbs().doSuporte.length === 0, 'ficou um adb do suporte rodando depois de encerrar')
  confere(estado.deOutros.every((item) => vivo(item.pid)), 'encerrar derrubou o adb de outro programa deste PC')
  // A chave que já era deste PC fica intacta; a que nasceu na sessão some com ela.
  confere(retratoDaChave() === estado.chave, estado.chave ? 'a chave de pareamento que já existia neste PC foi alterada ou apagada' : 'a chave de pareamento criada na sessão ficou no PC')
  ok(`Encerrar para o adb do suporte e apaga a pasta das ferramentas; a chave de pareamento ${estado.chave ? 'que já era deste PC ficou intacta' : 'criada na sessão foi apagada'}`)
}
