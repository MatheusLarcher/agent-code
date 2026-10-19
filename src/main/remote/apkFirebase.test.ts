// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyFirebaseConfig } from './apkFirebase'

const config = (pkg: string): string =>
  JSON.stringify({ project_info: { project_id: 'p' }, client: [{ client_info: { android_client_info: { package_name: pkg } } }] })

function projeto(json: string | null): { root: string; android: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-code-apk-firebase-'))
  const android = join(root, 'android')
  mkdirSync(join(android, 'app'), { recursive: true })
  if (json !== null) {
    mkdirSync(join(root, 'firebase'))
    writeFileSync(join(root, 'firebase', 'google-services.json'), json)
  }
  return { root, android }
}

describe('applyFirebaseConfig', () => {
  it('copia o config do app certo para android/app (sobrevive à pasta android recriada)', async () => {
    const p = projeto(config('com.matheus.agentremote'))
    const lines: string[] = []
    try {
      expect(await applyFirebaseConfig(p.root, p.android, (l) => lines.push(l))).toBe(true)
      expect(readFileSync(join(p.android, 'app', 'google-services.json'), 'utf8')).toBe(config('com.matheus.agentremote'))
      expect(lines.join('\n')).toMatch(/aplicado/)
    } finally {
      rmSync(p.root, { recursive: true, force: true })
    }
  })

  it('sem o arquivo, de outro app ou quebrado: não copia e avisa, sem falhar o build', async () => {
    for (const json of [null, config('com.outro.app'), '{quebrado']) {
      const p = projeto(json)
      const lines: string[] = []
      try {
        expect(await applyFirebaseConfig(p.root, p.android, (l) => lines.push(l))).toBe(false)
        expect(existsSync(join(p.android, 'app', 'google-services.json'))).toBe(false)
        expect(lines[0]).toMatch(/^Aviso:/)
      } finally {
        rmSync(p.root, { recursive: true, force: true })
      }
    }
  })
})
