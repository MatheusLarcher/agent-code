// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Fora do Electron o androidEnv usa AGENT_CODE_HOME como userData.
vi.mock('electron', () => ({}))

import { detect, parseJavaMajor } from './androidEnv'

describe('parseJavaMajor', () => {
  it('lê a versão principal do arquivo release do JDK', () => {
    expect(parseJavaMajor('IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="21.0.5"\n')).toBe(21)
    expect(parseJavaMajor('JAVA_VERSION="17.0.19"')).toBe(17)
    expect(parseJavaMajor('JAVA_VERSION="1.8.0_412"')).toBe(8)
    expect(parseJavaMajor('JAVA_VERSION="25"')).toBe(25)
  })

  it('sem JAVA_VERSION → null', () => {
    expect(parseJavaMajor('')).toBeNull()
  })
})

// O preview Android depende de detect().ready com o JDK 17 + android-34. O build
// do APK (Capacitor 8: JDK 21 + android-36) não pode passar a ser exigido ali.
describe('detect() do preview', () => {
  const EXE = process.platform === 'win32' ? '.exe' : ''
  const BAT = process.platform === 'win32' ? '.bat' : ''
  let home = ''

  const touch = async (...parts: string[]): Promise<void> => {
    const f = join(home, ...parts)
    await mkdir(dirname(f), { recursive: true })
    await writeFile(f, '')
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'android-env-'))
    await touch('jdk-17', 'jdk-17.0.19+10', 'bin', `java${EXE}`)
    await touch('android-sdk', 'cmdline-tools', 'latest', 'bin', `sdkmanager${BAT}`)
    await touch('android-sdk', 'cmdline-tools', 'latest', 'bin', `avdmanager${BAT}`)
    await touch('android-sdk', 'platform-tools', `adb${EXE}`)
    await touch('android-sdk', 'emulator', `emulator${EXE}`)
    await touch('android-sdk', 'system-images', 'android-34', 'google_apis', 'x86_64', 'system.img')
    await touch('avd', 'agent_code_avd.ini')
    vi.stubEnv('AGENT_CODE_HOME', home)
    vi.stubEnv('ANDROID_AVD_HOME', join(home, 'avd'))
    vi.stubEnv('JAVA_HOME', '')
    vi.stubEnv('ANDROID_HOME', '')
    vi.stubEnv('ANDROID_SDK_ROOT', '')
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })

  it('fica pronto só com JDK 17 + android-34, sem JDK 21 nem android-36', async () => {
    const d = await detect()
    expect(d.sdkRoot).toBe(join(home, 'android-sdk'))
    expect(d.javaHome).toBe(join(home, 'jdk-17', 'jdk-17.0.19+10'))
    expect(d.missing).toEqual([])
    expect(d.ready).toBe(true)
  })
})
