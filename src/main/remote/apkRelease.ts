import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * `android/` é gitignorada e recriada pelo `cap add android` (template antigo ou
 * de outro pacote). Tudo o que a publicação na Google Play exige do
 * `app/build.gradle` é reaplicado aqui a cada build, para não se perder:
 *  - assinatura release lida de `android/keystore.properties` — copiado de
 *    `~/.agent-code/keys/keystore.properties` quando falta (a chave NUNCA é gerada aqui);
 *  - versionCode/versionName derivados da versão do app desktop (package.json da raiz);
 *  - manifesto sem backup (o token de pareamento não pode ir para a nuvem).
 */

/** "0.1.133" → 1133 (major·10⁶ + minor·10³ + patch): sobe a cada versão, como a Play exige. */
export function versionCodeOf(version: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!m) return null
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (min > 999 || pat > 999) return null
  return Math.max(1, maj * 1_000_000 + min * 1_000 + pat)
}

const PROPS_LOADER = `
// Chave de assinatura release (fora do git; backup no cofre do Agent Code).
def keystorePropsFile = rootProject.file('keystore.properties')
def keystoreProps = new Properties()
if (keystorePropsFile.exists()) keystorePropsFile.withInputStream { keystoreProps.load(it) }
`

const SIGNING_CONFIGS = `    signingConfigs {
        release {
            if (keystorePropsFile.exists()) {
                storeFile file(keystoreProps['storeFile'])
                storePassword keystoreProps['storePassword']
                keyAlias keystoreProps['keyAlias']
                keyPassword keystoreProps['keyPassword']
            }
        }
    }
`

/** Aplica assinatura e versão no texto do app/build.gradle. Idempotente. */
export function patchAppGradle(gradle: string, version: string): string {
  let out = gradle
  if (!out.includes('keystorePropsFile')) {
    out = out.replace(/(apply plugin: 'com\.android\.application'\r?\n)/, `$1${PROPS_LOADER}`)
  }
  if (!out.includes('signingConfigs {')) {
    out = out.replace(/(\n\s*buildTypes \{)/, `\n${SIGNING_CONFIGS.trimEnd()}$1`)
  }
  if (!out.includes('signingConfig signingConfigs.release')) {
    out = out.replace(/(buildTypes \{\s*\n\s*release \{\r?\n)/, '$1            signingConfig signingConfigs.release\n')
  }
  const code = versionCodeOf(version)
  if (code !== null) {
    out = out.replace(/versionCode\s+\d+/, `versionCode ${code}`).replace(/versionName\s+"[^"]*"/, `versionName "${version}"`)
  }
  return out
}

/** Sem backup na nuvem nem cópia para outro aparelho: o token de pareamento (localStorage do
 *  WebView) dá controle do agente no PC e não pode sair do celular. */
export const DATA_EXTRACTION_RULES = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup>
${['root', 'file', 'database', 'sharedpref', 'external'].map((d) => `        <exclude domain="${d}" path="." />`).join('\n')}
    </cloud-backup>
    <device-transfer>
${['root', 'file', 'database', 'sharedpref', 'external'].map((d) => `        <exclude domain="${d}" path="." />`).join('\n')}
    </device-transfer>
</data-extraction-rules>
`

/** `<application>` do manifesto sem backup (Android ≤ 11 e ≥ 12). Idempotente. */
export function hardenManifest(xml: string): string {
  return xml.replace(/<application\b[^>]*>/, (tag) => {
    let t = tag.replace(/android:allowBackup="true"/, 'android:allowBackup="false"')
    if (!/android:allowBackup=/.test(t)) t = t.replace('<application', '<application\n        android:allowBackup="false"')
    if (!/android:fullBackupContent=/.test(t)) t = t.replace('<application', '<application\n        android:fullBackupContent="false"')
    if (!/android:dataExtractionRules=/.test(t)) {
      t = t.replace('<application', '<application\n        android:dataExtractionRules="@xml/data_extraction_rules"')
    }
    return t
  })
}

async function ensureNoBackup(androidDir: string, onLine: (line: string) => void): Promise<void> {
  const main = join(androidDir, 'app', 'src', 'main')
  try {
    const manifest = join(main, 'AndroidManifest.xml')
    const cur = await readFile(manifest, 'utf8')
    const next = hardenManifest(cur)
    if (next !== cur) await writeFile(manifest, next)
    await mkdir(join(main, 'res', 'xml'), { recursive: true })
    await writeFile(join(main, 'res', 'xml', 'data_extraction_rules.xml'), DATA_EXTRACTION_RULES)
    onLine('Backup do app desligado (o token de pareamento não sai do celular).')
  } catch (err) {
    onLine(`Aviso: não foi possível desligar o backup do app (${String(err)}).`)
  }
}

/**
 * @param rootDir projeto smartfone-remote (o package.json da versão fica no pai).
 * @param keysDir onde mora o keystore.properties de backup (padrão ~/.agent-code/keys).
 */
export async function ensureReleaseConfig(
  rootDir: string,
  androidDir: string,
  onLine: (line: string) => void,
  keysDir = join(homedir(), '.agent-code', 'keys')
): Promise<void> {
  const props = join(androidDir, 'keystore.properties')
  const hasProps = await readFile(props).then(() => true, () => false)
  if (!hasProps) {
    try {
      await copyFile(join(keysDir, 'keystore.properties'), props)
      onLine('Assinatura release: keystore.properties restaurado de ~/.agent-code/keys.')
    } catch {
      onLine('Aviso: sem keystore.properties — o build release sai sem assinatura.')
    }
  }
  try {
    const pkg = JSON.parse(await readFile(join(rootDir, '..', 'package.json'), 'utf8')) as { version?: unknown }
    const gradlePath = join(androidDir, 'app', 'build.gradle')
    const cur = await readFile(gradlePath, 'utf8')
    const next = patchAppGradle(cur, String(pkg.version ?? ''))
    if (next !== cur) await writeFile(gradlePath, next)
    onLine(`Versão do app: ${String(pkg.version ?? '?')} (versionCode ${versionCodeOf(String(pkg.version ?? '')) ?? '?'}).`)
  } catch (err) {
    onLine(`Aviso: não foi possível aplicar assinatura/versão no build.gradle (${String(err)}).`)
  }
  await ensureNoBackup(androidDir, onLine)
}
