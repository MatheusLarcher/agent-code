// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { buildConfigJs, findChromeExe, installExtensionFiles, readManifestVersion } from './install'

const TOKEN = '0123456789abcdef0123456789abcdef'
const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'chrome-ext-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function source(): string {
  const src = tmp()
  writeFileSync(join(src, 'manifest.json'), JSON.stringify({ version: '1.2.3' }))
  writeFileSync(join(src, 'background.js'), '// bg')
  writeFileSync(join(src, 'config.js'), 'self.AGENT_CODE_CONFIG = { stale: true }')
  mkdirSync(join(src, 'icons'))
  writeFileSync(join(src, 'icons', 'icon16.png'), 'png')
  return src
}

describe('instalador da extensão', () => {
  it('copia os arquivos e grava config.js com portas e token', () => {
    const src = source()
    const target = join(tmp(), 'chrome-extension')
    installExtensionFiles({ sourceDir: src, targetDir: target, ports: [47831, 47832], token: TOKEN })
    expect(readFileSync(join(target, 'background.js'), 'utf8')).toBe('// bg')
    expect(existsSync(join(target, 'icons', 'icon16.png'))).toBe(true)
    const sandbox: { self: { AGENT_CODE_CONFIG?: unknown } } = { self: {} }
    runInNewContext(readFileSync(join(target, 'config.js'), 'utf8'), sandbox)
    expect(sandbox.self.AGENT_CODE_CONFIG).toEqual({ ports: [47831, 47832], token: TOKEN })
  })

  it('reinstalar sobrescreve arquivos atualizados', () => {
    const src = source()
    const target = tmp()
    installExtensionFiles({ sourceDir: src, targetDir: target, ports: [1], token: TOKEN })
    writeFileSync(join(src, 'background.js'), '// v2')
    installExtensionFiles({ sourceDir: src, targetDir: target, ports: [1], token: TOKEN })
    expect(readFileSync(join(target, 'background.js'), 'utf8')).toBe('// v2')
  })

  it('recusa token inválido e origem sem manifest', () => {
    expect(() => installExtensionFiles({ sourceDir: source(), targetDir: tmp(), ports: [1], token: 'x' })).toThrow()
    expect(() => installExtensionFiles({ sourceDir: tmp(), targetDir: tmp(), ports: [1], token: TOKEN })).toThrow(/não encontrada/)
  })

  it('lê a versão do manifest e monta config.js', () => {
    expect(readManifestVersion(source())).toBe('1.2.3')
    expect(buildConfigJs([5], TOKEN)).toBe(`self.AGENT_CODE_CONFIG = {"ports":[5],"token":"${TOKEN}"}\n`)
  })

  it('com identidade (Homol) grava key, nome e título no manifest copiado, não no original', () => {
    const src = source()
    const original = { version: '1.2.3', action: { default_title: 'Agent Code' } }
    writeFileSync(join(src, 'manifest.json'), JSON.stringify(original))
    const target = tmp()
    const identity = { key: 'QUJD', name: 'Agent Code Homol — Controle do Chrome', shortName: 'Agent Code Homol' }
    installExtensionFiles({ sourceDir: src, targetDir: target, ports: [47841], token: TOKEN, identity })
    const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ version: '1.2.3', key: 'QUJD', name: identity.name, short_name: 'Agent Code Homol' })
    expect(manifest.action.default_title).toBe('Agent Code Homol')
    expect(JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'))).toEqual(original)
  })

  it('acha o chrome.exe nos caminhos padrão', () => {
    const want = join('C:\\PF', 'Google', 'Chrome', 'Application', 'chrome.exe')
    expect(findChromeExe({ PROGRAMFILES: 'C:\\PF' }, (p) => p === want)).toBe(want)
    expect(findChromeExe({}, () => true)).toBeNull()
  })
})
