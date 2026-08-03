// Junta os prints de cada modelo num painel único, com rótulo e veredito.
// Uso: node scripts/bench/visual-panel.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const REPO = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const VIS = join(REPO, 'docs/bench/visual')
const CHROME = [
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
].find((p) => existsSync(p))

const MODELOS = [
  { dir: 'opus', nome: 'Claude Opus (max)', nota: 'vidro + aro + animação' },
  { dir: '3b-lora', nome: 'Qwen2.5-Coder 3B + LoRA', nota: 'não compila: importou @emotion e CSS inválido' },
  { dir: '3b-base', nome: 'Qwen2.5-Coder 3B', nota: 'ReferenceError: isOpen fora do componente' },
  { dir: '7b-base', nome: 'Qwen2.5-Coder 7B', nota: 'ReferenceError: isOpen fora do componente' },
  { dir: 'deepseek-base', nome: 'DeepSeek-Coder 6.7B Base', nota: 'não seguiu a instrução (repetiu o prompt)' }
]

const cartoes = MODELOS.map((m) => {
  const png = join(VIS, m.dir, '2-aberto.png')
  const img = existsSync(png)
    ? `<img src="data:image/png;base64,${readFileSync(png).toString('base64')}">`
    : `<div class="vazio">sem render<br><span>o código não compila</span></div>`
  return `<figure><figcaption><b>${m.nome}</b><span>${m.nota}</span></figcaption>${img}</figure>`
}).join('\n')

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 26px; background: #141312; color: #e8e6e3;
         font-family: -apple-system, "Segoe UI", system-ui, sans-serif; width: 1180px; }
  h1 { font-size: 19px; margin: 0 0 4px; font-weight: 600; }
  p.sub { margin: 0 0 22px; color: #a3a09b; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
  figure { margin: 0; border: 1px solid #3a3836; border-radius: 12px; overflow: hidden; background: #1f1e1d; }
  figcaption { padding: 10px 13px; border-bottom: 1px solid #3a3836; display: flex; flex-direction: column; gap: 2px; }
  figcaption b { font-size: 13.5px; }
  figcaption span { font-size: 11.5px; color: #a3a09b; }
  img { width: 100%; display: block; }
  .vazio { height: 278px; display: flex; flex-direction: column; align-items: center; justify-content: center;
           color: #d97070; font-size: 14px; gap: 6px; text-align: center; }
  .vazio span { color: #a3a09b; font-size: 12px; }
</style></head><body>
  <h1>Mesmo pedido, cinco modelos — card "Arquivadas" em vidro</h1>
  <p class="sub">Componente React de arquivo único: vidro com brightness, aro cromático com mask-composite, expandir animado com grid-template-rows, chevron girando e botão que só aparece no hover.</p>
  <div class="grid">${cartoes}</div>
</body></html>`

mkdirSync(VIS, { recursive: true })
const htmlPath = join(VIS, 'comparacao.html')
writeFileSync(htmlPath, html, 'utf8')

const port = 9251
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  '--window-size=1180,1000',
  '--hide-scrollbars',
  '--disable-gpu',
  // perfil novo a cada execução: reaproveitar servia o painel antigo do cache
  `--user-data-dir=${join(REPO, 'node_modules/.cache', `panel-${Date.now()}`)}`,
  `file:///${htmlPath.replace(/\\/g, '/')}`
])

async function alvo() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* subindo */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('Chrome não respondeu')
}

const ws = new WebSocket(await alvo())
let id = 0
const pend = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
  if (m.id && pend.has(m.id)) pend.get(m.id)(m.result)
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const myId = ++id
    pend.set(myId, res)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })

await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await new Promise((r) => setTimeout(r, 1400))
const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
writeFileSync(join(VIS, 'COMPARACAO.png'), Buffer.from(data, 'base64'))
ws.close()
chrome.kill()
process.stdout.write(`painel em ${join(VIS, 'COMPARACAO.png')}\n`)
