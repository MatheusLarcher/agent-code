// Caso do Chrome no ponta a ponta do suporte remoto (scripts/suporte-e2e.mjs).
// O script faz o papel da IA do técnico: pede o recurso, instala a extensão pela
// automação do próprio exe (ferramentas remoto_*) e usa as remoto_chrome_*. O Chrome é
// o instalado neste PC, com janela visível, num perfil temporário só deste teste
// (--user-data-dir): nenhuma aba nem perfil do usuário é tocado.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Suporte E2E</title></head><body>
<h1>Página de teste do suporte</h1>
<label for="nome">Nome</label><input id="nome">
<button id="enviar" onclick="document.getElementById('saida').textContent = 'recebido: ' + document.getElementById('nome').value">Enviar</button>
<p id="saida">vazio</p></body></html>`

export const pastaDaExtensao = join(process.env.LOCALAPPDATA ?? '', 'AgentCodeSuporte', 'chrome-extension')

/** Antes do Permitir, toda remoto_chrome_* responde "peça ao cliente". */
export async function chromeSemPermitir({ chamar, textoDe, confere, tools }) {
  const doChrome = tools.filter((tool) => tool.name.startsWith('remoto_chrome_'))
  confere(doChrome.length === 15, `${doChrome.length} ferramentas do Chrome, esperava 15`)
  for (const nome of ['remoto_chrome_status', 'remoto_chrome_list_tabs', 'remoto_chrome_screenshot', 'remoto_chrome_evaluate']) {
    const barrada = await chamar(nome, nome.endsWith('evaluate') ? { expression: '1' } : {})
    confere(barrada.isError && textoDe(barrada).includes('peça ao cliente'), `${nome} passou sem o Permitir: ${textoDe(barrada)}`)
  }
  confere(!existsSync(pastaDaExtensao), 'a pasta da extensão existe antes do Permitir')
}

/** Pergunta de recurso extra na janela do cliente: confere o texto e clica na resposta. */
export async function responderPedido({ campos, clicar, ate, confere, janela }, titulo, detalhe, botao) {
  const tela = await ate(async () => {
    const texto = await campos(janela.id)
    return texto.includes(titulo) ? texto : null
  }, `a pergunta "${titulo}" aparecer`)
  confere(tela.includes(detalhe), `a pergunta não traz a linha "${detalhe}"`)
  confere(tela.includes('Não') && tela.includes('Permitir'), 'a pergunta não tem os botões Não e Permitir')
  await clicar(janela.id, botao)
}

function janelasDoChrome(lista, antes) {
  return lista.filter((item) => item.processName?.toLowerCase() === 'chrome' && !antes.has(item.id))
}

/** `estado` é preenchido aos poucos: o que já foi aberto é fechado mesmo se o caso falhar no meio. */
export async function casoDoChrome(ctx, estado) {
  const { chamar, textoDe, confere, ate, ok, eventos } = ctx
  const json = async (nome, args) => {
    const resposta = await chamar(nome, args)
    confere(!resposta.isError, `${nome} falhou: ${textoDe(resposta)}`)
    return JSON.parse(textoDe(resposta))
  }

  // ---- O cliente decide --------------------------------------------------------
  const recusa = chamar('remoto_pedir_recurso', { recurso: 'chrome' })
  await responderPedido(ctx, 'Permitir o Controle do Chrome?', 'Instala uma extensão, removida ao encerrar.', 'Não')
  const negado = await recusa
  confere(negado.isError && textoDe(negado).includes('não permitiu'), `o "Não" do cliente não chegou: ${textoDe(negado)}`)
  confere(!existsSync(pastaDaExtensao), 'gravou a extensão com o cliente dizendo não')

  const pedido = chamar('remoto_pedir_recurso', { recurso: 'chrome' })
  await responderPedido(ctx, 'Permitir o Controle do Chrome?', 'Instala uma extensão, removida ao encerrar.', 'Permitir')
  const liberado = await pedido
  confere(!liberado.isError && textoDe(liberado).includes(pastaDaExtensao), `o Permitir não devolveu a pasta: ${textoDe(liberado)}`)
  await ate(() => eventos.some((evento) => evento.evento === 'recurso' && evento.recurso === 'chrome' && evento.estado === 'ligado'), 'o aviso de Chrome liberado')
  const config = readFileSync(join(pastaDaExtensao, 'config.js'), 'utf8')
  confere(/"token":"[0-9a-f]{32}"/.test(config) && config.includes('"suporte":true'), 'config.js da sessão fora do formato')
  const manifest = JSON.parse(readFileSync(join(pastaDaExtensao, 'manifest.json'), 'utf8'))
  confere(!manifest.key && manifest.name.startsWith('Agent Code Suporte'), 'manifest da cópia do suporte errado')
  const antesDeInstalar = await json('remoto_chrome_status')
  confere(antesDeInstalar.conectada === false && antesDeInstalar.oQueFazer.includes('Carregar sem compactação'), 'status sem extensão não ensina a instalar')
  ok('Chrome: "Não" recusa; Permitir grava a pasta da extensão com token novo e sobe a ponte')

  // ---- A IA instala a extensão pela tela ---------------------------------------
  const perfil = mkdtempSync(join(tmpdir(), 'agentcode-suporte-chrome-'))
  estado.perfil = perfil
  const antes = new Set(JSON.parse(textoDe(await chamar('remoto_list_windows'))).map((item) => item.id))
  const aberto = await chamar('remoto_launch_app', {
    app: 'chrome',
    arguments: [`--user-data-dir=${perfil}`, '--no-first-run', '--no-default-browser-check', '--new-window', 'about:blank']
  })
  confere(!aberto.isError, `não abriu o Chrome: ${textoDe(aberto)}`)
  const janela = await ate(async () => janelasDoChrome(JSON.parse(textoDe(await chamar('remoto_list_windows'))), antes)[0], 'a janela do Chrome de teste', 30_000)
  estado.janelaId = janela.id

  // Só acessibilidade, sem tecla nem mouse de verdade: vale também com a tela bloqueada.
  // Um clique que abre página ou diálogo costuma responder "não respondeu em 1,2 s" e
  // chegar logo depois; por isso cada passo confere o efeito, não só o retorno.
  const passos = async (windowId, steps) => {
    const feito = await chamar('remoto_run_steps', { windowId, steps })
    const texto = textoDe(feito)
    confere(!feito.isError && (!texto.startsWith('{"ok":false') || texto.includes('não respondeu')), `passos falharam: ${texto.slice(0, 600)}`)
  }
  const tela = async () => textoDe(await chamar('remoto_form_fields', { windowId: janela.id }))
  const cartoes = (texto) => texto.split('\n').filter((linha) => linha.includes('(removeButton)')).length

  await passos(janela.id, [
    { action: 'focus', target: { name: 'Barra de endereço e de pesquisa' } },
    { action: 'fill', target: { name: 'Barra de endereço e de pesquisa' }, value: 'chrome://extensions' }
  ])
  await passos(janela.id, [{ action: 'click', target: { automationId: 'match-0' } }]) // a sugestão "chrome://extensions"
  const pagina = await ate(async () => {
    const texto = await tela()
    return texto.includes('Modo do desenvolvedor') ? texto : null
  }, 'a página de extensões abrir', 30_000)
  estado.cartoesAntes = cartoes(pagina)
  await passos(janela.id, [{ action: 'toggle', target: { name: 'Modo do desenvolvedor' }, value: 'on' }])
  await ate(async () => (await tela()).includes('Carregar sem compactação'), 'o modo do desenvolvedor ligar', 20_000)
  await passos(janela.id, [{ action: 'click', target: { name: 'Carregar sem compactação' } }])
  // A janela de escolher pasta é de outro processo do Chrome: a IA age nela pelo id dela.
  const dialogo = await ate(async () => janelasDoChrome(JSON.parse(textoDe(await chamar('remoto_list_windows'))), antes).find((item) => item.id !== janela.id),
    'a janela de escolher pasta', 20_000)
  await passos(dialogo.id, [
    { action: 'fill', target: { name: 'Pasta', type: 'Edit' }, value: pastaDaExtensao },
    { action: 'click', target: { name: 'Selecionar pasta', type: 'Button' } }
  ])
  const conectada = await ate(async () => {
    const agora = await json('remoto_chrome_status')
    return agora.conectada ? agora : null
  }, 'a extensão conectar à ponte do exe', 40_000)
  confere(conectada.versaoDaExtensao === manifest.version && /Chrome\//.test(conectada.navegador), 'a extensão conectada não é a gravada pelo exe')
  await ate(async () => cartoes(await tela()) === estado.cartoesAntes + 1, 'o cartão da extensão aparecer em chrome://extensions')
  ok(`Chrome: a extensão ${conectada.versaoDaExtensao} foi instalada pela automação do exe e conectou`)

  // ---- As ferramentas de página --------------------------------------------------
  const servidor = createServer((_, resposta) => resposta.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGINA))
  await new Promise((pronto) => servidor.listen(0, '127.0.0.1', pronto))
  estado.servidor = servidor
  const endereco = `http://127.0.0.1:${servidor.address().port}/`
  const aba = await json('remoto_chrome_open_tab', { url: endereco })
  confere(aba.title === 'Suporte E2E' && aba.url === endereco, `a aba aberta não é a página de teste: ${JSON.stringify(aba)}`)
  const { tabs } = await json('remoto_chrome_list_tabs')
  confere(tabs.some((item) => item.tabId === aba.tabId && item.active && item.title === 'Suporte E2E'), 'a aba aberta não está na lista')
  const extensoes = tabs.find((item) => item.url.startsWith('chrome://extensions'))
  confere(extensoes, `a aba de extensões não está na lista: ${JSON.stringify(tabs)}`)
  estado.abaDeExtensoes = extensoes.tabId

  const lido = (await json('remoto_chrome_snapshot')).text
  const ref = (rotulo) => {
    const achado = lido.split('\n').find((linha) => linha.includes(rotulo))?.match(/^\[(e\d+)\]/)
    confere(achado, `"${rotulo}" não está no snapshot:\n${lido}`)
    return achado[1]
  }
  confere(lido.includes('Página de teste do suporte'), 'o snapshot não traz o texto da página')
  await json('remoto_chrome_type', { ref: ref('Nome'), text: 'ação do técnico' })
  await json('remoto_chrome_click', { ref: ref('Enviar') })
  const saida = await json('remoto_chrome_evaluate', { expression: "document.getElementById('saida').textContent" })
  confere(JSON.parse(saida.value) === 'recebido: ação do técnico', `digitar e clicar não chegaram à página: ${saida.value}`)

  const foto = await chamar('remoto_chrome_screenshot')
  const imagem = foto.content.find((bloco) => bloco.type === 'image')
  const jpeg = imagem ? Buffer.from(imagem.data, 'base64') : Buffer.alloc(0)
  confere(imagem?.mimeType === 'image/jpeg' && jpeg.length > 2000 && jpeg[0] === 0xff && jpeg[1] === 0xd8, 'captura da página vazia')
  ok(`Chrome: abas reais (${tabs.length}), leitura, digitação, clique e captura da página (${Math.round(jpeg.length / 1024)} KB)`)

  // Deixa a aba de extensões na frente: é nela que o teste confere a remoção.
  await json('remoto_chrome_select_tab', { tabId: estado.abaDeExtensoes })
}

/** Quantos cartões há em chrome://extensions, lido de fora pelo helper local (o exe já saiu). */
async function cartoesDeFora({ controle }, janelaId) {
  const lido = await controle('form_fields', { windowId: janelaId })
  return lido.text.split('\n').filter((linha) => linha.includes('(removeButton)')).length
}

export async function chromeAntesDeEncerrar(ctx, estado) {
  const agora = await ctx.ate(async () => {
    const quantos = await cartoesDeFora(ctx, estado.janelaId)
    return quantos === estado.cartoesAntes + 1 ? quantos : null
  }, 'a aba de extensões mostrar o cartão do suporte')
  ctx.confere(agora === estado.cartoesAntes + 1, 'o cartão da extensão não está em chrome://extensions')
}

/** Depois do Encerrar: a extensão saiu do Chrome e a pasta foi apagada. */
export async function chromeDepoisDeEncerrar(ctx, estado) {
  const { ate, confere, ok } = ctx
  await ate(async () => (await cartoesDeFora(ctx, estado.janelaId)) === estado.cartoesAntes, 'a extensão sumir de chrome://extensions', 20_000)
  confere(!existsSync(pastaDaExtensao), 'a pasta da extensão ficou depois de encerrar')
  ok('Chrome: ao encerrar, a extensão some de chrome://extensions e a pasta é apagada')
}

/** Fecha só o Chrome que este teste abriu (o do perfil temporário) e apaga o perfil. */
export function fecharChromeDeTeste(estado) {
  estado?.servidor?.close()
  if (!estado?.perfil) return
  // Todo processo que cita o perfil temporário na linha de comando: o Chrome e os auxiliares dele.
  const filtro = estado.perfil.replaceAll("'", "''")
  const dele = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${filtro}*' -and $_.ProcessId -ne $PID }`
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `${dele} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; ` +
    `for ($i = 0; $i -lt 40 -and (${dele}); $i++) { Start-Sleep -Milliseconds 250 }`
  ], { windowsHide: true, stdio: 'ignore' })
  try {
    rmSync(estado.perfil, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 })
  } catch (erro) {
    console.error(`aviso: o perfil temporário do Chrome ficou em ${estado.perfil} (${erro.code ?? erro.message})`)
  }
}
