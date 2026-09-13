// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProjectIcon } from './projectIcon'

let root = ''

const put = (rel: string, bytes: Buffer | string = 'x'): void => {
  const file = join(root, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, bytes)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-code-icon-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readProjectIcon', () => {
  it('devolve null quando a pasta não tem ícone', async () => {
    put('src/index.ts', 'const a = 1')
    expect(await readProjectIcon(root)).toBeNull()
  })

  it('devolve null (sem lançar) para pasta inexistente ou caminho vazio', async () => {
    expect(await readProjectIcon(join(root, 'nao-existe'))).toBeNull()
    expect(await readProjectIcon('')).toBeNull()
  })

  it('acha o ícone na raiz e devolve um data URL com o mime do arquivo', async () => {
    put('icon.png', Buffer.from([1, 2, 3]))
    expect(await readProjectIcon(root)).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`)
  })

  it('acha o ícone em subpasta convencional (build/, public/…)', async () => {
    put('build/icon.ico', 'i')
    expect(await readProjectIcon(root)).toMatch(/^data:image\/x-icon;base64,/)
  })

  it('a raiz vence a subpasta', async () => {
    put('logo.svg', '<svg/>')
    put('build/icon.png', 'p')
    expect(await readProjectIcon(root)).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('"icon" vence "logo" na mesma pasta, e png vence svg no mesmo nome', async () => {
    put('assets/logo.png', 'l')
    put('assets/icon.svg', '<svg/>')
    put('assets/icon.png', 'i')
    expect(await readProjectIcon(root)).toBe(`data:image/png;base64,${Buffer.from('i').toString('base64')}`)
  })

  it('não confunde outro arquivo de imagem com o ícone do projeto', async () => {
    put('screenshot.png', 's')
    put('banner.jpg', 'b')
    put('logo-banner.png', 'lb')
    put('icon-dark.png', 'id')
    expect(await readProjectIcon(root)).toBeNull()
  })

  it('aceita as variantes com tamanho no nome e prefere a maior', async () => {
    put('public/favicon-16x16.png', 'p')
    put('public/favicon-32x32.png', 'g')
    expect(await readProjectIcon(root)).toBe(`data:image/png;base64,${Buffer.from('g').toString('base64')}`)
  })

  it('o nome sem tamanho vence a variante com tamanho', async () => {
    put('assets/logo512.png', 'g')
    put('assets/logo.png', 'c')
    expect(await readProjectIcon(root)).toBe(`data:image/png;base64,${Buffer.from('c').toString('base64')}`)
  })

  it('aceita apple-touch-icon e android-chrome', async () => {
    put('public/apple-touch-icon.png', 'a')
    expect(await readProjectIcon(root)).toMatch(/^data:image\/png;base64,/)
  })

  it('ignora arquivo vazio e arquivo grande demais para ser ícone', async () => {
    put('icon.png', '')
    put('build/logo.png', Buffer.alloc(3 * 1024 * 1024))
    expect(await readProjectIcon(root)).toBeNull()
  })

  it('casa o nome sem diferenciar maiúscula (Windows não diferencia)', async () => {
    put('public/Logo.PNG', 'L')
    expect(await readProjectIcon(root)).toMatch(/^data:image\/png;base64,/)
  })
})
