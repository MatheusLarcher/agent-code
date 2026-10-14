import { dirname, join, resolve, sep } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  GHIDRA_SHA256, GHIDRA_URL, GHIDRA_VERSION, GHIDRA_ZIP_ROOT, defaultLocalDir, detectGhidra, ghidraPaths, ghidraStatus,
  installGhidra, javaHomeSync, parseGhidraVersion, reaCachePaths, resetGhidraInstallForTests, type GhidraDeps
} from './ghidraEnv'

const LOCAL = resolve('/perfil/userData/agent-code-local')
const WIN = process.platform === 'win32'
const EXE = WIN ? '.exe' : ''
const HEADLESS = WIN ? 'analyzeHeadless.bat' : 'analyzeHeadless'
const P = ghidraPaths(LOCAL)

/** Disco em memória: só arquivos; uma "pasta" existe se tem algo dentro. */
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const under = (dir: string): string[] => [...files.keys()].filter((k) => k === dir || k.startsWith(dir + sep))
  const add = (more: Record<string, string>): void => { for (const [k, v] of Object.entries(more)) files.set(k, v) }
  return {
    files,
    add,
    exists: async (p: string) => under(p).length > 0,
    readText: async (p: string) => files.get(p) ?? '',
    remove: async (p: string) => { for (const k of under(p)) files.delete(k) },
    rename: async (from: string, to: string) => {
      for (const k of under(from)) { files.set(to + k.slice(from.length), files.get(k)!); files.delete(k) }
    },
    javaMajor: async (home: string) => {
      const m = (files.get(join(home, 'release')) ?? '').match(/JAVA_VERSION="(\d+)/)
      return m ? Number(m[1]) : null
    },
    findJavaHome: async (base: string) => {
      const java = under(base).find((k) => k.endsWith(join('bin', `java${EXE}`)))
      return java ? dirname(dirname(java)) : null
    }
  }
}

const ghidraFiles = (root: string, version: string): Record<string, string> => ({
  [join(root, 'support', HEADLESS)]: '@echo off',
  [join(root, 'Ghidra', 'application.properties')]: `application.name=Ghidra\napplication.version=${version}\napplication.release.name=PUBLIC\n`
})
const jdkFiles = (home: string, major: number): Record<string, string> => ({
  [join(home, 'bin', `java${EXE}`)]: 'x',
  [join(home, 'bin', `javac${EXE}`)]: 'x',
  [join(home, 'release')]: `JAVA_VERSION="${major}.0.5"\n`
})
const JDK_HOME = join(P.jdkBase, 'jdk-21.0.5+11')

/** Dependências falsas, sem rede: download grava o "zip", unzip põe a raiz do Ghidra. */
function deps(fs: ReturnType<typeof fakeFs>, over: Partial<GhidraDeps> = {}) {
  const download = vi.fn(async (_url: string, dest: string, onProgress: (l: string) => void, label: string) => {
    onProgress(`${label}: 50%`)
    fs.files.set(dest, 'zip')
  })
  const unzip = vi.fn(async (_zip: string, dest: string) => fs.add(ghidraFiles(join(dest, GHIDRA_ZIP_ROOT), GHIDRA_VERSION)))
  const installJdk = vi.fn(async (_major: number, base: string) => {
    fs.add(jdkFiles(join(base, 'jdk-21.0.5+11'), 21))
    return join(base, 'jdk-21.0.5+11')
  })
  const d: GhidraDeps = {
    localDir: LOCAL, env: {}, exists: fs.exists, readText: fs.readText, remove: fs.remove, rename: fs.rename,
    javaMajor: fs.javaMajor, findJavaHome: fs.findJavaHome, download, unzip, installJdk, sha256: async () => GHIDRA_SHA256, ...over
  }
  return { d, download, unzip, installJdk }
}

beforeEach(() => resetGhidraInstallForTests())

describe('ghidraEnv: caminhos fixos', () => {
  it('Ghidra no cache local; JDK na base do androidEnv (<userData>/jdk-21); recusa caminho relativo', () => {
    expect(P.installDir).toBe(join(LOCAL, 'ghidra'))
    expect(P.workDir).toBe(join(LOCAL, 'ghidra-tmp'))
    expect(P.jdkBase).toBe(resolve('/perfil/userData/jdk-21'))
    expect(() => ghidraPaths('')).toThrow(/inválido/)
    expect(() => ghidraPaths('relativo/x')).toThrow(/inválido/)
    // Fora do Electron não há userData: nada de caminho inventado (e nada de store/sqlite).
    expect(defaultLocalDir()).toBeNull()
    expect(reaCachePaths()).toBeNull()
  })

  it('reaCachePaths: caminhos mesmo antes de existirem; o JAVA_HOME acha o filho versionado', () => {
    expect(reaCachePaths(null)).toBeNull()
    const paths = reaCachePaths(LOCAL)
    expect(paths?.GHIDRA_INSTALL_DIR).toBe(P.installDir)
    const java = join(JDK_HOME, 'bin', `java${EXE}`)
    expect(javaHomeSync(P.jdkBase, () => false, () => { throw new Error('ENOENT') })).toBe(P.jdkBase)
    expect(javaHomeSync(P.jdkBase, (p) => p === java, () => ['jdk-21.0.5+11'])).toBe(JDK_HOME)
    expect(javaHomeSync(P.jdkBase, (p) => p === join(P.jdkBase, 'bin', `java${EXE}`), () => [])).toBe(P.jdkBase)
  })

  it('lê a versão do application.properties', () => {
    expect(parseGhidraVersion('a=b\napplication.version=12.1.4\n')).toBe('12.1.4')
    expect(parseGhidraVersion('application.version = 11.0.3\r\n')).toBe('11.0.3')
    expect(parseGhidraVersion('nada')).toBeNull()
  })
})

describe('ghidraEnv: detect', () => {
  it('nada instalado → nem Ghidra nem JDK', async () => {
    const r = await detectGhidra(deps(fakeFs()).d)
    expect(r).toMatchObject({ installDir: P.installDir, ghidraReady: false, version: null, javaReady: false, javaHome: null })
  })

  it('Ghidra 12.1.4 com analyzeHeadless + JDK 21 do androidEnv → pronto', async () => {
    const fs = fakeFs({ ...ghidraFiles(P.installDir, '12.1.4'), ...jdkFiles(JDK_HOME, 21) })
    expect(await detectGhidra(deps(fs).d)).toMatchObject({ ghidraReady: true, version: '12.1.4', javaReady: true, javaHome: JDK_HOME, javaMajor: 21 })
  })

  it('versão errada ou sem analyzeHeadless → não pronto', async () => {
    expect((await detectGhidra(deps(fakeFs(ghidraFiles(P.installDir, '11.4'))).d)).ghidraReady).toBe(false)
    const semBat = fakeFs(ghidraFiles(P.installDir, '12.1.4'))
    semBat.files.delete(join(P.installDir, 'support', HEADLESS))
    expect((await detectGhidra(deps(semBat).d)).ghidraReady).toBe(false)
  })

  it('JAVA_HOME do ambiente ≥ 21 vale; < 21 ou só JRE (sem javac) não', async () => {
    const envJdk = resolve('/jdks/temurin-25')
    const fs = fakeFs({ ...jdkFiles(envJdk, 25), ...jdkFiles(resolve('/jdks/17'), 17) })
    expect(await detectGhidra(deps(fs, { env: { JAVA_HOME: envJdk } }).d)).toMatchObject({ javaReady: true, javaHome: envJdk, javaMajor: 25 })
    expect((await detectGhidra(deps(fs, { env: { JAVA_HOME: resolve('/jdks/17') } }).d)).javaReady).toBe(false)
    fs.files.delete(join(envJdk, 'bin', `javac${EXE}`))
    expect((await detectGhidra(deps(fs, { env: { JAVA_HOME: envJdk } }).d)).javaReady).toBe(false)
  })

  it('sem cache local → erro claro', async () => {
    await expect(detectGhidra({ ...deps(fakeFs()).d, localDir: null })).rejects.toThrow(/Cache local/)
  })
})

describe('ghidraEnv: install', () => {
  it('baixa do release oficial, confere o SHA-256, extrai no caminho fixo, instala o JDK e limpa o temporário', async () => {
    const fs = fakeFs({ [join(P.installDir, 'lixo-parcial.txt')]: 'velho' })
    const { d, download, unzip, installJdk } = deps(fs)
    const progress: string[] = []
    const r = await installGhidra((l) => progress.push(l), d)
    expect(download).toHaveBeenCalledWith(GHIDRA_URL, join(P.workDir, `${GHIDRA_ZIP_ROOT}_20260921.zip`), expect.any(Function), `Ghidra ${GHIDRA_VERSION}`)
    expect(unzip).toHaveBeenCalledTimes(1)
    expect(installJdk).toHaveBeenCalledWith(21, P.jdkBase, P.workDir, expect.any(Function))
    expect(r).toMatchObject({ ghidraReady: true, javaReady: true, javaHome: JDK_HOME })
    expect(fs.files.has(join(P.installDir, 'lixo-parcial.txt'))).toBe(false)
    expect(await fs.exists(P.workDir)).toBe(false)
    expect(progress).toContain(`Ghidra ${GHIDRA_VERSION}: 50%`)
    expect(ghidraStatus()).toMatchObject({ state: 'ready', error: null, result: r })
  })

  it('SHA-256 diferente → falha, descarta o zip e não extrai nem mexe na pasta final', async () => {
    const fs = fakeFs()
    const { d, unzip, installJdk } = deps(fs, { sha256: async () => 'f'.repeat(64) })
    await expect(installGhidra(undefined, d)).rejects.toThrow(/SHA-256 do Ghidra não confere/)
    expect(unzip).not.toHaveBeenCalled()
    expect(installJdk).not.toHaveBeenCalled()
    expect(fs.files.size).toBe(0)
    expect(ghidraStatus()).toMatchObject({ state: 'error', error: expect.stringMatching(/SHA-256/) })
  })

  it('idempotente: tudo pronto → não baixa nada', async () => {
    const fs = fakeFs({ ...ghidraFiles(P.installDir, '12.1.4'), ...jdkFiles(JDK_HOME, 21) })
    const { d, download, installJdk } = deps(fs)
    expect((await installGhidra(undefined, d)).ghidraReady).toBe(true)
    expect(download).not.toHaveBeenCalled()
    expect(installJdk).not.toHaveBeenCalled()
  })

  it('reaproveita o JAVA_HOME do ambiente ≥ 21 em vez de baixar o JDK', async () => {
    const envJdk = resolve('/jdks/21')
    const { d, installJdk } = deps(fakeFs(jdkFiles(envJdk, 21)), { env: { JAVA_HOME: envJdk } })
    expect((await installGhidra(undefined, d)).javaHome).toBe(envJdk)
    expect(installJdk).not.toHaveBeenCalled()
  })

  it('uma vez só: chamadas durante a instalação recebem a mesma promessa; depois de erro, tenta de novo', async () => {
    const fs = fakeFs()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { d, download } = deps(fs)
    const slow = vi.fn(async (...args: Parameters<typeof download>) => { await gate; return download(...args) })
    const a = installGhidra(undefined, { ...d, download: slow })
    const b = installGhidra(undefined, { ...d, download: slow })
    expect(b).toBe(a)
    expect(ghidraStatus().state).toBe('running')
    release()
    await a
    expect(slow).toHaveBeenCalledTimes(1)

    resetGhidraInstallForTests()
    const falha = deps(fakeFs(), { download: vi.fn(async () => { throw new Error('HTTP 503') }) })
    await expect(installGhidra(undefined, falha.d)).rejects.toThrow('HTTP 503')
    expect(ghidraStatus()).toMatchObject({ state: 'error', error: 'HTTP 503' })
    const ok = deps(fakeFs())
    expect((await installGhidra(undefined, ok.d)).ghidraReady).toBe(true)
    expect(ok.download).toHaveBeenCalledTimes(1)
  })
})
