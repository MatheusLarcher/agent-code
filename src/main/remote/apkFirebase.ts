import { copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * O `google-services.json` do Firebase (push com o app fechado) mora em
 * `smartfone-remote/firebase/`, FORA de `android/` — que é ignorada pelo git e
 * recriada pelo `cap add android`. A cada build ele é copiado para `android/app/`,
 * onde o build.gradle do template do Capacitor aplica o plugin
 * `com.google.gms.google-services` sozinho quando o arquivo existe.
 * O arquivo é configuração pública do app (a chave de API fica restrita ao app
 * Android no Google Cloud); a chave da conta de serviço NUNCA vem para cá.
 */

export const FIREBASE_CONFIG_DIR = 'firebase'
/** Pacote do app na Google Play (definitivo: não muda depois de publicado). */
export const APP_ID = 'com.larchertech.agentcode'
const PACKAGE = APP_ID

/** Copia o config do Firebase para o projeto Android. Sem o arquivo (ou de outro app): segue sem push. */
export async function applyFirebaseConfig(rootDir: string, androidDir: string, onLine: (line: string) => void): Promise<boolean> {
  const src = join(rootDir, FIREBASE_CONFIG_DIR, 'google-services.json')
  let raw: string
  try {
    raw = await readFile(src, 'utf8')
  } catch {
    onLine('Aviso: sem firebase/google-services.json — o APK sai sem aviso com o app fechado.')
    return false
  }
  try {
    const json = JSON.parse(raw) as { client?: Array<{ client_info?: { android_client_info?: { package_name?: string } } }> }
    const ok = (json.client ?? []).some((c) => c.client_info?.android_client_info?.package_name === PACKAGE)
    if (!ok) {
      onLine(`Aviso: firebase/google-services.json não é do app ${PACKAGE} — ignorado.`)
      return false
    }
    await copyFile(src, join(androidDir, 'app', 'google-services.json'))
    onLine('Firebase: google-services.json aplicado (aviso com o app fechado).')
    return true
  } catch (err) {
    onLine(`Aviso: não foi possível aplicar o google-services.json (${String(err)}).`)
    return false
  }
}
