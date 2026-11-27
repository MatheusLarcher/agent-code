import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { machineConfigDir } from './accounts/accountDirs'

/**
 * Hooks do `settings.json` do Claude que apontam para um programa que não existe
 * mais. O CLI tenta rodá-los a cada evento e falha em silêncio ("stop hook
 * reported a problem" em todo turno); o app só avisa — nunca mexe no arquivo.
 */

export interface HookProblem {
  /** Caminho que não foi achado (o programa ou o script). */
  path: string
  /** Eventos que o usam (PreToolUse, Stop...). */
  events: string[]
}

/** Interpretadores: o que importa é o script que eles recebem. */
const RUNNERS = new Set(['powershell', 'pwsh', 'node', 'bash', 'sh', 'python', 'python3', 'py', 'cmd'])
/** Código inline: não há arquivo para conferir. */
const INLINE = new Set(['-c', '-e', '--eval', '-command', '/c', '/k'])

/** Quebra em palavras respeitando aspas duplas. */
function tokenize(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
}

/** Expande `~`, `%VAR%`, `$VAR` e `${VAR}`; null se alguma variável não existir. */
function expand(path: string, env: Record<string, string | undefined>, home: string): string | null {
  let missing = false
  const out = path
    .replace(/^~(?=[\\/]|$)/, home)
    .replace(/%([A-Za-z_][\w]*)%|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (_m, a, b, c) => {
      const value = env[a ?? b ?? c]
      if (value === undefined) missing = true
      return value ?? ''
    })
  return missing ? null : out
}

/** Arquivo que o comando precisa achar no disco, ou null (comando do PATH, inline, relativo). */
export function hookTarget(command: string): string | null {
  const tokens = tokenize(command.trim())
  const exe = tokens[0]
  if (!exe) return null
  const name = basename(exe.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '')
  if (!RUNNERS.has(name)) return exe
  const args = tokens.slice(1)
  const fileFlag = args.findIndex((a) => /^-f(ile)?$/i.test(a))
  if ((name === 'powershell' || name === 'pwsh') && fileFlag >= 0) return args[fileFlag + 1] ?? null
  if (args.some((a) => INLINE.has(a.toLowerCase()))) return null
  return args.find((a) => !a.startsWith('-')) ?? null
}

const looksLikePath = (p: string): boolean => /[\\/]/.test(p)

/** Lê o texto do settings.json e devolve os programas que faltam, agrupados por caminho. */
export function findBrokenHooks(
  settingsText: string,
  exists: (path: string) => boolean,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): HookProblem[] {
  let hooks: unknown
  try {
    hooks = (JSON.parse(settingsText) as { hooks?: unknown } | null)?.hooks
  } catch {
    return []
  }
  if (!hooks || typeof hooks !== 'object') return []
  const byPath = new Map<string, Set<string>>()
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const list = (group as { hooks?: unknown } | null)?.hooks
      if (!Array.isArray(list)) continue
      for (const hook of list) {
        const command = (hook as { command?: unknown } | null)?.command
        if (typeof command !== 'string') continue
        const raw = hookTarget(command)
        // Sem barra é nome resolvido pelo PATH (powershell, node) ou relativo a uma pasta que não sabemos.
        if (!raw || !looksLikePath(raw)) continue
        const path = expand(raw, env, home)
        if (!path || exists(path)) continue
        if (!byPath.has(path)) byPath.set(path, new Set())
        byPath.get(path)!.add(event)
      }
    }
  }
  return [...byPath].map(([path, events]) => ({ path, events: [...events] }))
}

/** Texto do aviso, para quem não sabe o que é um hook. */
export function hookNotice(problems: HookProblem[], settingsPath: string): { title: string; body: string } {
  const names = problems.map((p) => `"${basename(p.path.replace(/\\/g, '/'))}"`).join(', ')
  const one = problems.length === 1
  return {
    title: one ? 'Um programa ligado ao Claude sumiu' : 'Programas ligados ao Claude sumiram',
    body:
      `O Claude tenta abrir ${names} a cada mensagem, mas ${one ? 'ele não está' : 'eles não estão'} mais no computador. ` +
      `Isso está configurado em ${settingsPath}, na parte "hooks". ` +
      `Reinstale o programa ou apague essas linhas do arquivo.`
  }
}

/** Confere o settings.json da pasta do Claude desta máquina. Nunca lança. */
export function checkHookHealth(configDir = machineConfigDir()): { problems: HookProblem[]; settingsPath: string } {
  const settingsPath = join(configDir, 'settings.json')
  let text: string
  try {
    text = readFileSync(settingsPath, 'utf8')
  } catch {
    return { problems: [], settingsPath }
  }
  return { problems: findBrokenHooks(text, existsSync), settingsPath }
}
