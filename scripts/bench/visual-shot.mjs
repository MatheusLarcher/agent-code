// Renderiza o ArchivedCard de um modelo e fotografa — fechado (1) e aberto (2).
//
// O componente é empacotado com esbuild sobre um fundo com imagem (o vidro só
// aparece se houver algo atrás) e fotografado com Chrome headless via CDP:
// screenshot de janela real do Electron sai branco, esse caminho é o que funciona.
//
// Uso: node scripts/bench/visual-shot.mjs --card <ArchivedCard.tsx> --out docs/bench/visual/<nome>

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), [])
)
const CARD = resolve(args.card)
const OUT = resolve(args.out)
const REPO = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
// Dentro do repo de propósito: fora dele o esbuild não acha o `react` do projeto.
const TMP = join(REPO, 'node_modules/.cache', `bench-visual-${Date.now()}`)
const CHROME = [
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find((p) => existsSync(p))

mkdirSync(TMP, { recursive: true })
mkdirSync(OUT, { recursive: true })

// Palco: fundo com foto + o tema do projeto, para o vidro ter o que atravessar.
const MAIN = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import ArchivedCard from './ArchivedCard'

const conversas = [
  { id: 'a', title: 'Corrigir duplicação da sidebar', updatedAt: 3 },
  { id: 'b', title: 'Benchmark dos modelos locais', updatedAt: 2 },
  { id: 'c', title: 'Deploy do CRM na VPS', updatedAt: 1 }
]

createRoot(document.getElementById('root')).render(
  React.createElement(ArchivedCard, { conversations: conversas, onUnarchive: () => {} })
)
`

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root {
    --bg: #1f1e1d; --bg-2: #262624; --bg-3: #302e2c; --line: #3a3836;
    --text: #e8e6e3; --muted: #a3a09b; --accent: #d97757; --accent-dim: #b9603f;
    --radius: 12px; --font: -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  body {
    margin: 0; width: 720px; height: 460px; font-family: var(--font); color: var(--text);
    background:
      radial-gradient(circle at 22% 28%, #d97757 0 12%, transparent 42%),
      radial-gradient(circle at 74% 66%, #5b8fb9 0 14%, transparent 46%),
      repeating-linear-gradient(45deg, #2a2826 0 18px, #201f1e 18px 36px);
    display: flex; align-items: center; justify-content: center;
  }
  #root { width: 340px; }
</style></head>
<body><div id="root"></div><script src="./bundle.js"></script></body></html>`

writeFileSync(join(TMP, 'ArchivedCard.tsx'), readFileSync(CARD, 'utf8'), 'utf8')
writeFileSync(join(TMP, 'main.tsx'), MAIN, 'utf8')
writeFileSync(join(TMP, 'index.html'), HTML, 'utf8')

// esbuild resolve react a partir do node_modules do repo
try {
  execFileSync(
    'npx',
    ['esbuild', join(TMP, 'main.tsx'), '--bundle', '--loader:.tsx=tsx', '--jsx=automatic', `--outfile=${join(TMP, 'bundle.js')}`],
    { cwd: REPO, stdio: 'pipe', encoding: 'utf8', shell: true }
  )
} catch (e) {
  writeFileSync(join(OUT, 'ERRO-build.txt'), `${e.stdout ?? ''}\n${e.stderr ?? ''}`, 'utf8')
  process.stdout.write('FALHOU no build (ver ERRO-build.txt)\n')
  process.exit(2)
}

/** Chrome headless com CDP: abre a página, clica no cabeçalho e fotografa os dois estados. */
const port = 9223 + Math.floor((Date.now() % 100) / 10)
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  '--window-size=720,460',
  '--hide-scrollbars',
  '--disable-gpu',
  `--user-data-dir=${join(TMP, 'profile')}`,
  `file:///${join(TMP, 'index.html').replace(/\\/g, '/')}`
])

async function cdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('Chrome não respondeu ao CDP')
}

// WebSocket nativo do Node (>=22): API de browser, não a do pacote `ws`.
const ws = new WebSocket(await cdp())
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
  if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg.result)
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const myId = ++id
    pending.set(myId, res)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })

await new Promise((r) => ws.addEventListener('open', r, { once: true }))

// Componente que quebra em runtime renderiza tela vazia sem dizer o motivo —
// guardar a exceção é o que separa "não fez" de "fez errado".
const erros = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params?.exceptionDetails
    erros.push(d?.exception?.description ?? d?.text ?? JSON.stringify(d))
  }
  if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') erros.push(msg.params.entry.text)
})
await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
await new Promise((r) => setTimeout(r, 1500))

async function shot(nome) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, nome), Buffer.from(data, 'base64'))
}

await shot('1-fechado.png')

// Clica no cabeçalho (primeiro elemento clicável do card) e espera a animação.
await send('Runtime.evaluate', {
  expression: `(() => {
    const alvo = document.querySelector('#root [role="button"], #root button, #root [class*="head"], #root > * > *');
    if (alvo) alvo.click();
    return !!alvo;
  })()`
})
await new Promise((r) => setTimeout(r, 1200))
await shot('2-aberto.png')

// Guarda o que foi realmente aplicado, para conferir as exigências sem olhar o CSS.
const { result } = await send('Runtime.evaluate', {
  expression: `(() => {
    const card = document.querySelector('#root > *');
    if (!card) return JSON.stringify({ erro: 'nada renderizado' });
    const cs = getComputedStyle(card);
    const todos = [...document.querySelectorAll('#root *')];
    const comBackdrop = todos.filter(e => {
      const v = getComputedStyle(e).backdropFilter;
      return v && v !== 'none';
    }).map(e => getComputedStyle(e).backdropFilter);
    const comMask = todos.filter(e => {
      const s = getComputedStyle(e);
      return (s.maskComposite && s.maskComposite !== 'add') || (s.webkitMaskComposite && s.webkitMaskComposite !== 'source-over');
    }).length;
    const comTransition = todos.filter(e => {
      const t = getComputedStyle(e).transition;
      return t && t !== 'all 0s ease 0s';
    }).length;
    const grid = todos.filter(e => (getComputedStyle(e).gridTemplateRows || '').match(/^[0-9.]+px$|fr/)).length;
    return JSON.stringify({
      backdrop: comBackdrop,
      elementosComMask: comMask,
      elementosComTransition: comTransition,
      elementosComGridRows: grid,
      alturaCard: card.getBoundingClientRect().height
    }, null, 2);
  })()`,
  returnByValue: true
})
writeFileSync(join(OUT, 'medidas.json'), result.value ?? '{}', 'utf8')
if (erros.length) writeFileSync(join(OUT, 'erro-runtime.txt'), erros.join('\n\n'), 'utf8')

ws.close()
chrome.kill()
try {
  rmSync(TMP, { recursive: true, force: true })
} catch {
  /* o Chrome ainda pode segurar o perfil por um instante */
}
process.stdout.write(`prints em ${OUT}\n${result.value}\n`)
