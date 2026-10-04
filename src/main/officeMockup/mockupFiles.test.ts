import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MOCKUP_CSP } from '../../shared/officeMockup'
import { MockupFiles } from './mockupFiles'

let root: string
let cwd: string
let outside: string

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mockup-'))
  cwd = path.join(root, 'proj')
  outside = path.join(root, 'fora')
  mkdirSync(path.join(cwd, 'mockups'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(path.join(cwd, 'mockups', 'tela.html'), '<h1>oi</h1><link rel="stylesheet" href="estilo.css">')
  writeFileSync(path.join(cwd, 'mockups', 'estilo.css'), 'h1{color:red}')
  writeFileSync(path.join(cwd, 'mockups', 'com espaço.html'), '<p>x</p>')
  writeFileSync(path.join(cwd, '.env'), 'SEGREDO=1')
  writeFileSync(path.join(outside, 'segredo.html'), '<p>fora</p>')
  // Junction dentro do projeto apontando para fora: o caminho real manda.
  symlinkSync(outside, path.join(cwd, 'link'), 'junction')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('protocolo agent-mockup (MockupFiles)', () => {
  it('dá endereço só para .html/.htm que existe dentro do cwd; recusa fora, sensível, outra extensão, sumido e junction', async () => {
    const f = new MockupFiles()
    const ok = await f.urlFor({ cwd, path: path.join(cwd, 'mockups', 'tela.html') })
    expect(ok.ok && ok.url).toMatch(/^agent-mockup:\/\/[0-9a-f]{32}\/mockups\/tela\.html$/)
    const sp = await f.urlFor({ cwd, path: path.join(cwd, 'mockups', 'com espaço.html') })
    expect(sp.ok && sp.url).toMatch(/\/mockups\/com%20espa%C3%A7o\.html$/)
    for (const p of [path.join(outside, 'segredo.html'), path.join(cwd, 'mockups', 'estilo.css'), path.join(cwd, 'sumiu.html'), path.join(cwd, 'link', 'segredo.html'), 'mockups/tela.html'])
      expect((await f.urlFor({ cwd, path: p })).ok, p).toBe(false)
    // Mesmo cwd → mesmo token.
    const again = await f.urlFor({ cwd, path: path.join(cwd, 'mockups', 'com espaço.html') })
    expect(again.ok && ok.ok && new URL(again.url).host).toBe(ok.ok && new URL(ok.url).host)
  })

  it('serve o HTML e os recursos relativos com a CSP; 404 para token desconhecido, sensível, junction e fora', async () => {
    const f = new MockupFiles()
    const r = await f.urlFor({ cwd, path: path.join(cwd, 'mockups', 'tela.html') })
    if (!r.ok) throw new Error(r.error)
    const page = await f.serve(r.url)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('content-security-policy')).toBe(MOCKUP_CSP)
    expect(await page.text()).toContain('<h1>oi</h1>')
    const css = await f.serve(new URL('estilo.css', r.url).href)
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
    const token = new URL(r.url).host
    for (const u of [
      `agent-mockup://${'0'.repeat(32)}/mockups/tela.html`,
      `agent-mockup://${token}/.env`,
      `agent-mockup://${token}/link/segredo.html`,
      `agent-mockup://${token}/..%2Ffora%2Fsegredo.html`,
      `agent-mockup://${token}/%2e%2e/fora/segredo.html`,
      `agent-mockup://${token}/mockups/`
    ]) {
      const res = await f.serve(u)
      expect(res.status, u).toBeGreaterThanOrEqual(400)
      expect(res.headers.get('content-security-policy')).toBe(MOCKUP_CSP)
    }
  })
})
