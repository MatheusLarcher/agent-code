import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * `android/` é gitignorada e recriada pelo `cap add android` (template antigo ou
 * de outro pacote). Tudo o que a publicação na Google Play exige do
 * `app/build.gradle` é reaplicado aqui a cada build, para não se perder:
 *  - assinatura release lida de `android/keystore.properties` — copiado de
 *    `~/.agent-code/keys/keystore.properties` quando falta (a chave NUNCA é gerada aqui);
 *  - versionCode/versionName derivados da versão do app desktop (package.json da raiz).
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
}
