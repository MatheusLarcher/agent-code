// End-to-end smoke test for the phone question map in the real web client.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const root = join(process.cwd(), 'smartfone-remote', 'www')
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const messages = [{ kind: 'user', id: 'new', text: 'Pergunta nova' }]
const questions = [
  { id: 'old', text: 'Pergunta antiga', position: 0 },
  { id: 'new', text: 'Pergunta nova', position: 100 }
]
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (url.pathname === '/api/state') return res.end(JSON.stringify({ conversations: [{ id: 'c1', title: 'Teste', questions }], models: [] }))
  if (url.pathname === '/api/history') return res.end(JSON.stringify({ messages }))
  if (url.pathname === '/api/history-window') return res.end(JSON.stringify({ messages: [{ kind: 'user', id: 'old', text: 'Pergunta antiga' }] }))
  if (url.pathname === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return }
  const file = join(root, url.pathname === '/' ? 'index.html' : url.pathname)
  try { res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream'); res.end(await readFile(file)) } catch { res.writeHead(404).end() }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.addInitScript((base) => localStorage.setItem('agent-remote-config', JSON.stringify({ base, token: 'test' })), `http://127.0.0.1:${port}`)
  await page.goto(`http://127.0.0.1:${port}`)
  await page.waitForSelector('.question-point')
  await page.getByLabel('Pergunta antiga').click()
  await page.getByText('Pergunta antiga', { exact: true }).click()
  await page.waitForSelector('[data-mid="old"].msg-highlight')
  console.log('[mobile-question-map-probe] touch preview and old-history navigation passed')
} finally {
  await browser.close()
  server.close()
}
