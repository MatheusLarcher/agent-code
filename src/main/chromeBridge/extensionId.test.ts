import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHROME_EXTENSION_ID, extensionIdFromKey } from './extensionId'

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../chromeExtension/manifest.json'), 'utf8')
) as { key: string; permissions: string[]; manifest_version: number }

describe('CHROME_EXTENSION_ID', () => {
  it('bate com o ID calculado da key do manifest', () => {
    expect(extensionIdFromKey(manifest.key)).toBe(CHROME_EXTENSION_ID)
  })

  it('tem o formato de ID do Chrome (32 letras a-p)', () => {
    expect(CHROME_EXTENSION_ID).toMatch(/^[a-p]{32}$/)
  })

  it('manifest MV3 com as permissões do contrato e só a chave pública', () => {
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.permissions).toEqual(['debugger', 'tabs', 'tabGroups', 'storage', 'alarms'])
    expect(manifest.key).not.toMatch(/PRIVATE/)
  })

  it('recusa key vazia', () => {
    expect(() => extensionIdFromKey('')).toThrow()
  })
})
