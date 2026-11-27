/**
 * Abre um arquivo web local (file:///….html) no NAVEGADOR padrão, não no app
 * associado à extensão: no Windows, `.html` costuma estar ligado ao VS Code e
 * shell.openExternal seguiria essa associação. Aqui usamos o programa do
 * protocolo https (UserChoice), o mesmo que abre os links da web.
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { shell } from 'electron'

const run = promisify(execFile)

/** file:///….html / .htm (com ou sem ?query/#hash). */
export function isLocalWebFile(url: string): boolean {
  return /^file:\/\//i.test(url) && /\.html?(?:[?#].*)?$/i.test(url)
}

/** Valor padrão de `reg query` → o texto depois de REG_SZ/REG_EXPAND_SZ. */
export function parseRegValue(stdout: string): string | null {
  const m = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(stdout)
  return m ? m[1].trim() : null
}

/** `"C:\x\chrome.exe" --single-argument %1` → exe + args com o %1 trocado pela url. */
export function buildCommand(template: string, url: string): { exe: string; args: string[] } | null {
  const tokens = template.match(/"[^"]*"|\S+/g)?.map((t) => t.replace(/^"|"$/g, '')) ?? []
  if (!tokens.length) return null
  const [exe, ...rest] = tokens
  const hasPlaceholder = rest.some((t) => /%[1lL]/.test(t))
  const args = rest.map((t) => t.replace(/%[1lL]/g, url)).filter((t) => !/^%\*$/.test(t))
  return { exe: exe.replace(/%([^%]+)%/g, (_, v: string) => process.env[v] ?? ''), args: hasPlaceholder ? args : [...args, url] }
}

async function regDefault(key: string, value?: string): Promise<string | null> {
  const args = ['query', key, ...(value ? ['/v', value] : ['/ve'])]
  const { stdout } = await run('reg', args, { windowsHide: true })
  return parseRegValue(stdout)
}

async function defaultBrowserCommand(url: string): Promise<{ exe: string; args: string[] } | null> {
  const progId = await regDefault(
    'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
    'ProgId'
  )
  if (!progId) return null
  const template = await regDefault(`HKCR\\${progId}\\shell\\open\\command`)
  return template ? buildCommand(template, url) : null
}

/** macOS: o bundle do app que abre https, na saída de
 *  `defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers`. */
export function parseMacHttpsHandler(stdout: string): string | null {
  for (const block of stdout.split('}')) {
    if (!/LSHandlerURLScheme\s*=\s*"?https"?\s*;/.test(block)) continue
    const m = /LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?\s*;/.exec(block)
    if (m && m[1] !== '-') return m[1]
  }
  return null
}

async function macBrowserCommand(url: string): Promise<{ exe: string; args: string[] } | null> {
  const { stdout } = await run('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers'])
  const bundle = parseMacHttpsHandler(stdout)
  // Sem escolha gravada o padrão do sistema é o Safari.
  return { exe: 'open', args: ['-b', bundle ?? 'com.apple.Safari', url] }
}

/** Abre `url`; arquivo web local vai para o navegador padrão (Windows e macOS), não
 *  para o app associado à extensão .html (costuma ser um editor). */
export async function openUrlExternally(url: string): Promise<void> {
  const plat = process.platform
  if ((plat === 'win32' || plat === 'darwin') && isLocalWebFile(url)) {
    try {
      const cmd = plat === 'win32' ? await defaultBrowserCommand(url) : await macBrowserCommand(url)
      if (cmd) {
        const child = spawn(cmd.exe, cmd.args, { detached: true, stdio: 'ignore', windowsHide: false })
        child.on('error', (err) => {
          console.error('[openInBrowser] falha ao abrir o navegador:', err)
          void shell.openExternal(url)
        })
        child.unref()
        return
      }
    } catch (err) {
      console.error('[openInBrowser] navegador padrão não encontrado:', err)
    }
  }
  await shell.openExternal(url)
}
