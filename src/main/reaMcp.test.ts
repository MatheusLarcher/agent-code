import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { reaMcpConfig, reaScriptPath } from './reaMcp'

const PKG = join('C:', 'app', 'node_modules', 'rea-agents', 'package.json')
const SCRIPT = join('C:', 'app', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs')
const EXE = join('C:', 'app', 'Agent Code.exe')
const noCache = (): null => null

describe('reaMcp', () => {
  it('rea.mjs existe → stdio pelo Node do Electron com o subcomando mcp', () => {
    const cfg = reaMcpConfig({ resolvePackageJson: () => PKG, exists: (p) => p === SCRIPT, execPath: EXE, env: {}, cachePaths: noCache })
    expect(cfg).toEqual({ type: 'stdio', command: EXE, args: [SCRIPT, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } })
  })

  it('rea.mjs ausente → null', () => {
    expect(reaMcpConfig({ resolvePackageJson: () => PKG, exists: () => false, execPath: EXE, env: {}, cachePaths: noCache })).toBeNull()
  })

  it('pacote não instalado (resolve lança) → null', () => {
    const resolvePackageJson = (): string => { throw new Error('Cannot find module') }
    expect(reaScriptPath({ resolvePackageJson, exists: () => true })).toBeNull()
    expect(reaMcpConfig({ resolvePackageJson, exists: () => true })).toBeNull()
  })

  it('GHIDRA_INSTALL_DIR e JAVA_HOME só quando definidos; o resto do ambiente não vai', () => {
    const base = { resolvePackageJson: () => PKG, exists: () => true, execPath: EXE, cachePaths: noCache }
    const full = reaMcpConfig({ ...base, env: { GHIDRA_INSTALL_DIR: 'C:\\ghidra', JAVA_HOME: 'C:\\jdk', SECRET: 'x' } })
    expect(full?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', GHIDRA_INSTALL_DIR: 'C:\\ghidra', JAVA_HOME: 'C:\\jdk' })
    const partial = reaMcpConfig({ ...base, env: { JAVA_HOME: 'C:\\jdk', GHIDRA_INSTALL_DIR: '' } })
    expect(partial?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', JAVA_HOME: 'C:\\jdk' })
  })

  describe('caminhos fixos do cache local (Ghidra sob demanda)', () => {
    const base = { resolvePackageJson: () => PKG, exists: () => true, execPath: EXE }
    const cache = { GHIDRA_INSTALL_DIR: 'C:\\local\\ghidra', JAVA_HOME: 'C:\\data\\jdk-21' }

    it('sem as variáveis no ambiente → sempre os caminhos do cache, mesmo que ainda não existam', () => {
      // `exists` diz que nada existe além do rea.mjs: a regra não depende da pasta.
      const cfg = reaMcpConfig({ ...base, exists: (p) => p === SCRIPT, env: {}, cachePaths: () => cache })
      expect(cfg?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', ...cache })
    })

    it('o ambiente tem prioridade, variável a variável', () => {
      const both = reaMcpConfig({ ...base, env: { GHIDRA_INSTALL_DIR: 'D:\\g', JAVA_HOME: 'D:\\j' }, cachePaths: () => cache })
      expect(both?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', GHIDRA_INSTALL_DIR: 'D:\\g', JAVA_HOME: 'D:\\j' })
      const onlyJava = reaMcpConfig({ ...base, env: { JAVA_HOME: 'D:\\j' }, cachePaths: () => cache })
      expect(onlyJava?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', GHIDRA_INSTALL_DIR: cache.GHIDRA_INSTALL_DIR, JAVA_HOME: 'D:\\j' })
      const onlyGhidra = reaMcpConfig({ ...base, env: { GHIDRA_INSTALL_DIR: 'D:\\g' }, cachePaths: () => cache })
      expect(onlyGhidra?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', GHIDRA_INSTALL_DIR: 'D:\\g', JAVA_HOME: cache.JAVA_HOME })
    })

    it('com as duas no ambiente o cache nem é consultado; sem cache local, nada é inventado', () => {
      const cachePaths = vi.fn(() => cache)
      reaMcpConfig({ ...base, env: { GHIDRA_INSTALL_DIR: 'D:\\g', JAVA_HOME: 'D:\\j' }, cachePaths })
      expect(cachePaths).not.toHaveBeenCalled()
      expect(reaMcpConfig({ ...base, env: {}, cachePaths: noCache })?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    })
  })

  it('padrão: acha o rea.mjs instalado em node_modules', () => {
    const script = reaScriptPath()
    expect(script).toMatch(/rea-agents[\\/]scripts[\\/]rea\.mjs$/)
  })
})
