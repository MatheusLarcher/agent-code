import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { officeAgentFilePath, readOfficeAgentFile } from './officeAgents'

describe('arquivos 3D dos agentes do Escritório (IPC)', () => {
  const root = mkdtempSync(join(tmpdir(), 'office-agents-'))
  const dev = { packaged: false, resourcesPath: join(root, 'pkg'), appPath: root }
  const pkg = { packaged: true, resourcesPath: join(root, 'pkg'), appPath: root }
  mkdirSync(join(root, 'resources', 'office-agents'), { recursive: true })
  mkdirSync(join(root, 'pkg', 'office-agents'), { recursive: true })
  writeFileSync(join(root, 'resources', 'office-agents', 'principal.glb'), Buffer.from('glTF-dev'))
  writeFileSync(join(root, 'pkg', 'office-agents', 'principal.glb'), Buffer.from('glTF-pkg'))
  writeFileSync(join(root, 'pkg', 'office-agents', 'ambiente.bin'), Buffer.from('PMRM'))
  writeFileSync(join(root, 'segredo.glb'), Buffer.from('fora'))

  it('no dev lê da raiz do projeto; empacotado, de resources (extraResources)', async () => {
    expect(officeAgentFilePath('principal.glb', dev)).toBe(join(root, 'resources', 'office-agents', 'principal.glb'))
    expect(Buffer.from((await readOfficeAgentFile('principal.glb', dev))!).toString()).toBe('glTF-dev')
    expect(Buffer.from((await readOfficeAgentFile('principal.glb', pkg))!).toString()).toBe('glTF-pkg')
    expect(Buffer.from((await readOfficeAgentFile('ambiente.bin', pkg))!).toString()).toBe('PMRM')
  })

  it('recusa nome fora do padrão (caminho, outra extensão, não-texto) e arquivo ausente', async () => {
    for (const bad of ['../segredo.glb', '..\\segredo.glb', 'principal', 'principal.js', 'Principal.glb', '/etc/passwd', '', 42, null, { a: 1 }]) {
      expect(await readOfficeAgentFile(bad, dev)).toBeNull()
    }
    expect(await readOfficeAgentFile('executor.glb', dev)).toBeNull()
  })
})
