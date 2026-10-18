// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findAndroidIcon } from './androidIcon'
import { findProjectIconFile } from './projectIcon'

let root = ''

const put = (rel: string, content: Buffer | string): void => {
  const file = join(root, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:icon="@mipmap/ic_launcher" android:label="X"></application></manifest>`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-code-android-icon-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('findAndroidIcon', () => {
  it('null quando não é projeto Android', async () => {
    expect(await findAndroidIcon(root)).toBeNull()
  })

  it('prefere o PNG da maior densidade', async () => {
    put('app/src/main/AndroidManifest.xml', MANIFEST)
    put('app/src/main/res/mipmap-mdpi/ic_launcher.png', 'small')
    put('app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', 'big')
    const icon = await findAndroidIcon(root)
    expect(icon?.mime).toBe('image/png')
    expect(icon?.bytes.toString()).toBe('big')
  })

  it('converte adaptive-icon vetorial em SVG (cor de fundo + path da frente)', async () => {
    put('app/src/main/AndroidManifest.xml', MANIFEST)
    put('app/src/main/res/values/colors.xml', '<resources><color name="rota">#2F7DF6</color></resources>')
    put(
      'app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
      `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
        <background android:drawable="@color/rota" />
        <foreground android:drawable="@drawable/frente" /></adaptive-icon>`
    )
    put(
      'app/src/main/res/drawable/frente.xml',
      `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:viewportWidth="108" android:viewportHeight="108">
        <path android:fillColor="#80FFFFFF" android:pathData="M30,54a24,24 0,1 0,48 0z" /></vector>`
    )
    const icon = await findAndroidIcon(root)
    expect(icon?.mime).toBe('image/svg+xml')
    const svg = icon!.bytes.toString('utf8')
    expect(svg).toContain('fill="#2F7DF6"')
    expect(svg).toContain('d="M30,54a24,24 0,1 0,48 0z"')
    expect(svg).toContain('rgba(255,255,255,0.502)')
  })

  it('findProjectIconFile cai no ícone Android quando não há logo convencional', async () => {
    put('app/src/main/AndroidManifest.xml', MANIFEST)
    put('app/src/main/res/mipmap-xxhdpi/ic_launcher.webp', 'w')
    expect((await findProjectIconFile(root))?.mime).toBe('image/webp')
  })
})
