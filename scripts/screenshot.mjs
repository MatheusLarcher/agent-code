// Generates the README hero screenshot: launches the built app, seeds a small
// realistic conversation and captures the whole window (chat + the Quadro /
// Scrum Master pane) to docs/screenshot.png. Re-run with: node scripts/screenshot.mjs
import { _electron as electron } from 'playwright'
import { join } from 'node:path'

const OUT = join(process.cwd(), 'docs', 'screenshot.png')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[shot]', ...a)

const conv = {
  id: 'demo',
  title: 'O que é o React?',
  cwd: 'meu-projeto',
  model: 'claude-opus-4-8',
  sdkSessionId: 'sess-demo',
  tokens: { context: 18450, output: 1230, cost: 0.0421 },
  createdAt: 1,
  updatedAt: 2,
  messages: [
    { kind: 'user', id: 'u1', text: 'Abra a página do React e me explique em poucas linhas o que é o React.' },
    {
      kind: 'assistant-text',
      id: 'a1',
      final: true,
      text: 'Vou abrir o site oficial numa janela do Chrome e dar uma olhada.'
    },
    {
      kind: 'tool-use',
      id: 't1',
      name: 'mcp__browser__browser_navigate',
      input: { url: 'https://react.dev' },
      parentToolUseId: null,
      result: { isError: false, text: 'Navegou para https://react.dev — "React" (aba: "web - React").' }
    },
    {
      kind: 'assistant-text',
      id: 'a2',
      final: true,
      answer: true,
      text:
        'Pronto — abri o **react.dev** na janela do Chrome. Em resumo:\n\n' +
        '**React** é uma biblioteca JavaScript para construir **interfaces de usuário** a partir de componentes reutilizáveis.\n\n' +
        '- **Componentes**: pedaços de UI isolados e combináveis\n' +
        '- **Estado reativo**: a tela atualiza sozinha quando os dados mudam\n' +
        '- **Ecossistema enorme** e suporte a web, mobile e desktop'
    }
  ]
}

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate((c) => {
    localStorage.setItem('agentcode.conversations.v1', JSON.stringify([c]))
    localStorage.setItem(
      'agentcode.ui.v1',
      JSON.stringify({ collapsed: false, activeId: 'demo', rightPaneMinimized: false, rightPaneWidth: 720 })
    )
  }, conv)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('.pane-tabs', { timeout: 15000 })
  await sleep(1500) // let the chat and the board paint

  await win.screenshot({ path: OUT })
  log('saved', OUT)
} catch (err) {
  log('ERROR', err)
  process.exitCode = 1
} finally {
  await app.close()
}
