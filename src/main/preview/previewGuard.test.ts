// @vitest-environment node
import { promises, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { checkPreviewPath, isNetworkOrDevicePath } from './previewGuard'

const dir = mkdtempSync(join(tmpdir(), 'agent-preview-guard-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => vi.restoreAllMocks())

describe('checkPreviewPath — caminho de rede (UNC)', () => {
  const network = [
    '\\\\host\\share\\a.png',
    '//host/share/a.png',
    '\\\\?\\UNC\\host\\share\\a.png',
    '//?/UNC/host/share/a.png',
    '\\\\.\\pipe\\x',
    '\\/host/share/a.png',
    '/\\host\\share\\a.png'
  ]

  it.each(network)('recusa %s como blocked SEM tocar no disco (sem realpath/SMB)', async (p) => {
    const realpath = vi.spyOn(promises, 'realpath')
    const stat = vi.spyOn(promises, 'stat')
    expect(isNetworkOrDevicePath(p)).toBe(true)
    expect(await checkPreviewPath(p)).toMatchObject({ ok: false, reason: 'blocked', message: expect.stringContaining('rede') })
    expect(realpath).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
  })

  it('caminho local continua passando', async () => {
    const p = join(dir, 'a.png')
    writeFileSync(p, 'png')
    expect(isNetworkOrDevicePath(p)).toBe(false)
    expect(isNetworkOrDevicePath('/home/u/a.png')).toBe(false)
    expect(await checkPreviewPath(p)).toMatchObject({ ok: true, size: 3 })
  })

  it('link local cujo destino real é de rede também é recusado', async () => {
    const p = join(dir, 'link.png')
    writeFileSync(p, 'png')
    vi.spyOn(promises, 'realpath').mockResolvedValue('\\\\host\\share\\a.png' as never)
    const stat = vi.spyOn(promises, 'stat')
    expect(await checkPreviewPath(p)).toMatchObject({ ok: false, reason: 'blocked' })
    expect(stat).not.toHaveBeenCalled()
  })
})
