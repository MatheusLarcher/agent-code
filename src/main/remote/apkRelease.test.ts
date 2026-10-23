// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureReleaseConfig, patchAppGradle, versionCodeOf } from './apkRelease'

// Trecho do app/build.gradle como o `cap add android` (Capacitor 8) gera.
const TEMPLATE = `apply plugin: 'com.android.application'

android {
    namespace = "com.larchertech.agentcode"
    defaultConfig {
        applicationId "com.larchertech.agentcode"
        versionCode 1
        versionName "1.0"
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}
`

describe('versionCodeOf', () => {
  it('cresce a cada versão e nunca é 0', () => {
    expect(versionCodeOf('0.1.133')).toBe(1133)
    expect(versionCodeOf('0.2.0')).toBeGreaterThan(versionCodeOf('0.1.999')!)
    expect(versionCodeOf('1.0.0')).toBe(1_000_000)
    expect(versionCodeOf('0.0.0')).toBe(1)
    expect(versionCodeOf('x')).toBeNull()
  })
})

describe('patchAppGradle', () => {
  it('no template recém-gerado: assinatura release e versão do package.json', () => {
    const out = patchAppGradle(TEMPLATE, '0.1.133')
    expect(out).toContain("rootProject.file('keystore.properties')")
    expect(out).toMatch(/signingConfigs \{[\s\S]*keyAlias keystoreProps\['keyAlias'\][\s\S]*buildTypes \{/)
    expect(out).toMatch(/release \{\n\s+signingConfig signingConfigs\.release\n\s+minifyEnabled false/)
    expect(out).toContain('versionCode 1133')
    expect(out).toContain('versionName "0.1.133"')
  })

  it('idempotente: aplicar de novo não duplica nada', () => {
    const once = patchAppGradle(TEMPLATE, '0.1.133')
    expect(patchAppGradle(once, '0.1.133')).toBe(once)
    expect(patchAppGradle(once, '0.1.134')).toContain('versionCode 1134')
  })
})

describe('ensureReleaseConfig', () => {
  it('restaura o keystore.properties do backup e grava o build.gradle', async () => {
    const base = mkdtempSync(join(tmpdir(), 'agent-code-apk-release-'))
    try {
      const root = join(base, 'smartfone-remote')
      const android = join(root, 'android')
      const keys = join(base, 'keys')
      mkdirSync(join(android, 'app'), { recursive: true })
      mkdirSync(keys)
      writeFileSync(join(base, 'package.json'), JSON.stringify({ version: '0.1.140' }))
      writeFileSync(join(android, 'app', 'build.gradle'), TEMPLATE)
      writeFileSync(join(keys, 'keystore.properties'), 'keyAlias=agentcode\n')
      const lines: string[] = []
      await ensureReleaseConfig(root, android, (l) => lines.push(l), keys)
      expect(readFileSync(join(android, 'keystore.properties'), 'utf8')).toBe('keyAlias=agentcode\n')
      expect(readFileSync(join(android, 'app', 'build.gradle'), 'utf8')).toContain('versionCode 1140')
      expect(lines.join('\n')).toMatch(/restaurado/)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
