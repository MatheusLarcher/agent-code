import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reaMcpConfig, reaScriptPath } from './reaMcp'

const PKG = join('C:', 'app', 'node_modules', 'rea-agents', 'package.json')
const SCRIPT = join('C:', 'app', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs')
const EXE = join('C:', 'app', 'Agent Code.exe')

describe('reaMcp', () => {
  it('rea.mjs existe → stdio pelo Node do Electron com o subcomando mcp', () => {
    const cfg = reaMcpConfig({ resolvePackageJson: () => PKG, exists: (p) => p === SCRIPT, execPath: EXE, env: {} })
    expect(cfg).toEqual({ type: 'stdio', command: EXE, args: [SCRIPT, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } })
  })

  it('rea.mjs ausente → null', () => {
    expect(reaMcpConfig({ resolvePackageJson: () => PKG, exists: () => false, execPath: EXE, env: {} })).toBeNull()
  })

  it('pacote não instalado (resolve lança) → null', () => {
    const resolvePackageJson = (): string => { throw new Error('Cannot find module') }
    expect(reaScriptPath({ resolvePackageJson, exists: () => true })).toBeNull()
    expect(reaMcpConfig({ resolvePackageJson, exists: () => true })).toBeNull()
  })

  it('GHIDRA_INSTALL_DIR e JAVA_HOME só quando definidos; o resto do ambiente não vai', () => {
    const base = { resolvePackageJson: () => PKG, exists: () => true, execPath: EXE }
    const full = reaMcpConfig({ ...base, env: { GHIDRA_INSTALL_DIR: 'C:\\ghidra', JAVA_HOME: 'C:\\jdk', SECRET: 'x' } })
    expect(full?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', GHIDRA_INSTALL_DIR: 'C:\\ghidra', JAVA_HOME: 'C:\\jdk' })
    const partial = reaMcpConfig({ ...base, env: { JAVA_HOME: 'C:\\jdk', GHIDRA_INSTALL_DIR: '' } })
    expect(partial?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', JAVA_HOME: 'C:\\jdk' })
  })

  it('padrão: acha o rea.mjs instalado em node_modules', () => {
    const script = reaScriptPath()
    expect(script).toMatch(/rea-agents[\\/]scripts[\\/]rea\.mjs$/)
  })
})
