// Fumaça da aba Preview no app DE VERDADE (instância isolada, build em out/). Sem IA: 0 tokens.
// Abre a aba Preview, cola o caminho de cada arquivo na barra de endereço e confere que
// abriu sem aviso de erro; tira uma captura de cada. Também chama a leitura do main direto.
//
//   npx electron-vite build
//   node scripts/bateria/fumaca-preview.mjs
//
// Capturas e dados fora do repo, em ~/agent-code-bateria/_dados/fumaca-preview-<hora>.
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launch, shutdown } from '../replay/instance.mjs'

const log = (m) => console.log(`[preview] ${m}`)
const hora = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
const base = path.join(os.homedir(), 'agent-code-bateria', '_dados', `fumaca-preview-${hora}`)
const dados = path.join(base, 'dados')
const arquivos = path.join(base, 'arquivos')
mkdirSync(arquivos, { recursive: true })

const FIXTURES = {
  'leia-me.md': '# Loja da padaria\n\nLista de **pedidos** do dia.\n\n- pão francês\n- sonho\n',
  'vendas.csv': 'produto;quantidade;preco\npão francês;120;0,75\nsonho;30;6,50\n',
  'config.json': JSON.stringify({ loja: 'Pão Quente', abre: '06:00', produtos: ['pão', 'sonho'] }, null, 2),
  'app.ts': 'export function total(itens: { preco: number }[]): number {\n  return itens.reduce((s, i) => s + i.preco, 0)\n}\n',
  'pagina.html': '<!doctype html><html><body><h1 id="titulo">Padaria Pão Quente</h1><button>Comprar</button></body></html>'
}
for (const [nome, conteudo] of Object.entries(FIXTURES)) writeFileSync(path.join(arquivos, nome), conteudo)

const { app, page } = await launch(dados, { log })
let ok = true
const falhou = (m) => {
  ok = false
  log(`FALHOU: ${m}`)
}
try {
  // 1) leitura no processo principal (o que a aba usa por baixo)
  for (const nome of Object.keys(FIXTURES)) {
    const r = await page.evaluate((p) => window.api.previewReadFile(p), path.join(arquivos, nome)).catch((e) => ({ erro: String(e) }))
    const resumo = JSON.stringify(r).slice(0, 140)
    if (!r || r.erro || r.ok === false || r.error) falhou(`leitura de ${nome}: ${resumo}`)
    else log(`leitura ${nome}: ${resumo}`)
  }

  // 2) pela tela, como o usuário: aba Preview → caminho na barra de endereço → Enter
  await page.getByRole('tab', { name: /preview/i }).first().click({ timeout: 15_000 })
  const endereco = page.getByLabel('Endereço: link do site ou caminho do arquivo')
  await endereco.waitFor({ timeout: 15_000 })
  for (const nome of Object.keys(FIXTURES)) {
    await endereco.fill(path.join(arquivos, nome))
    await endereco.press('Enter')
    await page.waitForTimeout(2500)
    const captura = path.join(base, `${nome}.png`)
    await page.screenshot({ path: captura })
    // Aviso de erro do visualizador (ViewerNotice) ou texto de falha na área do Preview.
    const aviso = await page.locator('.viewer-notice, [role="alert"]').allInnerTexts().catch(() => [])
    const erros = aviso.filter((t) => /erro|falh|não (foi possível|consegu)/i.test(t))
    if (erros.length) falhou(`${nome} mostrou aviso: ${erros.join(' | ').slice(0, 200)}`)
    else log(`tela ${nome}: aberto (captura ${captura})`)
  }
} catch (e) {
  falhou(String(e).slice(0, 300))
  await page.screenshot({ path: path.join(base, 'erro.png') }).catch(() => undefined)
} finally {
  await shutdown(app, dados, { log })
}
log(ok ? `OK — capturas em ${base}` : `FALHOU — capturas em ${base}`)
process.exit(ok ? 0 : 1)
