import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FastUpdateStager, isStagedReady, oldDirFor, stagedDirFor } from './fastSwap'

const EXE = 'Agent Code.exe'
const dirs: string[] = []

function sandbox(): { root: string; installDir: string; sevenZip: string } {
  const root = mkdtempSync(join(tmpdir(), 'fastswap-'))
  dirs.push(root)
  const installDir = join(root, 'agent-code-desktop')
  mkdirSync(installDir)
  const sevenZip = join(root, '7za.exe')
  writeFileSync(sevenZip, '')
  return { root, installDir, sevenZip }
}

/** Cria a árvore que o 7za extrairia, na pasta do `-o`. */
function fakeTree(dir: string, version: string, withExe = true): void {
  mkdirSync(join(dir, 'resources', 'app'), { recursive: true })
  writeFileSync(join(dir, 'resources', 'app', 'package.json'), JSON.stringify({ version }))
  if (withExe) writeFileSync(join(dir, EXE), 'exe')
}

const outDirOf = (args: string[]): string => args.find((a) => a.startsWith('-o'))!.slice(2)

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('FastUpdateStager', () => {
  it('extrai para a pasta irmã e a troca fica pronta', async () => {
    const { installDir, sevenZip } = sandbox()
    const lines: string[] = []
    const calls: string[][] = []
    const stager = new FastUpdateStager({
      log: (l) => lines.push(l), installDir, exeName: EXE, sevenZip,
      run: async (_bin, args) => (calls.push(args), fakeTree(outDirOf(args), '0.2.0'), 0)
    })
    expect(stager.readyDir('0.2.0')).toBeNull()
    expect(await stager.stage('C:\\cache\\AgentCode-setup.exe', '0.2.0')).toBe(true)
    expect(calls[0][0]).toBe('x')
    expect(calls[0][1]).toBe('C:\\cache\\AgentCode-setup.exe')
    expect(stager.readyDir('0.2.0')).toBe(stagedDirFor(installDir, '0.2.0'))
    // Mesma versão de novo: não extrai outra vez.
    expect(await stager.stage('C:\\cache\\AgentCode-setup.exe', '0.2.0')).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('extração sem a versão esperada não vira pasta pronta e pode tentar de novo', async () => {
    const { installDir, sevenZip } = sandbox()
    const lines: string[] = []
    let version = '0.1.9'
    const stager = new FastUpdateStager({
      log: (l) => lines.push(l), installDir, exeName: EXE, sevenZip,
      run: async (_bin, args) => (fakeTree(outDirOf(args), version), 0)
    })
    expect(await stager.stage('setup.exe', '0.2.0')).toBe(false)
    expect(stager.readyDir('0.2.0')).toBeNull()
    expect(lines.some((l) => l.includes('falhou'))).toBe(true)
    version = '0.2.0'
    expect(await stager.stage('setup.exe', '0.2.0')).toBe(true)
  })

  it('sem 7-Zip na build: não extrai', async () => {
    const { installDir } = sandbox()
    const stager = new FastUpdateStager({ log: () => undefined, installDir, exeName: EXE, sevenZip: null, run: async () => 0 })
    expect(await stager.stage('setup.exe', '0.2.0')).toBe(false)
  })

  it('versão com caractere estranho é recusada', async () => {
    const { installDir, sevenZip } = sandbox()
    const stager = new FastUpdateStager({ log: () => undefined, installDir, exeName: EXE, sevenZip, run: async () => 0 })
    expect(await stager.stage('setup.exe', '0.2.0\\..\\x')).toBe(false)
    expect(stager.readyDir('0.2.0\\..\\x')).toBeNull()
  })

  it('apaga extrações de outras versões e a sobra .old, sem tocar na instalação', async () => {
    const { root, installDir, sevenZip } = sandbox()
    fakeTree(stagedDirFor(installDir, '0.1.5'), '0.1.5')
    mkdirSync(oldDirFor(installDir))
    mkdirSync(join(root, 'outra-pasta'))
    const stager = new FastUpdateStager({
      log: () => undefined, installDir, exeName: EXE, sevenZip,
      run: async (_bin, args) => (fakeTree(outDirOf(args), '0.2.0'), 0)
    })
    await stager.stage('setup.exe', '0.2.0')
    expect(readdirSync(root).sort()).toEqual(['7za.exe', 'agent-code-desktop', 'agent-code-desktop.next-0.2.0', 'outra-pasta'])
  })

  it('isStagedReady exige o executável', () => {
    const { installDir } = sandbox()
    const dir = stagedDirFor(installDir, '0.2.0')
    fakeTree(dir, '0.2.0', false)
    expect(isStagedReady(dir, EXE, '0.2.0')).toBe(false)
  })
})
