/**
 * "Mostrar na pasta" (painel de Memórias) e o botão direito do VS Code do agente
 * (CodeMonitor): o Explorador com o arquivo SELECIONADO (shell.showItemInFolder)
 * ou o arquivo no programa padrão (shell.openPath). A borda do IPC
 * Channels.revealFile — o renderer manda o pedido, aqui ele é validado:
 *
 *   { memory: relPath }      só 'folder' (a memória continua só leitura): um .md
 *                            relativo, sem `..`, dentro da pasta de memórias
 *   { path, cwd }            caminho absoluto dentro de `cwd`, e `cwd` tem que ser
 *                            um projeto conhecido (uma pasta com conversa)
 *
 * Recusa caminho relativo, `.`/`..`, caractere de controle, `\\?\`/`\\.\`, fluxo
 * alternativo (`a.txt:x`), link que aponta para fora da pasta e o que não é
 * arquivo. Arquivo que não existe volta `missing` (o renderer avisa). "Abrir" um
 * executável (.bat, .js, .lnk…) no Windows é executá-lo: esses abrem a pasta
 * com o arquivo selecionado.
 *
 * Sem electron aqui: o shell e as fontes (pasta de memórias, projetos) chegam
 * por `deps`, para o teste.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RevealFileRequest, RevealFileResult } from '../shared/ipc'
import { diskReadVerdict, isInside, normalizePath } from '../shared/pathGuard'
import { realPathInside } from './memory/memoryPaths'

export interface RevealFileDeps {
  memoriesDir: () => string
  /** As pastas de projeto conhecidas (as que têm conversa). */
  knownProjects: () => Promise<readonly string[]>
  showItemInFolder: (path: string) => void
  /** '' quando abriu; senão, o motivo (o contrato do shell.openPath). */
  openPath: (path: string) => Promise<string>
}

const MAX_PATH = 4096
/** Extensões que o Windows EXECUTA ao abrir (a mesma lista de planning/mediaDrop.ts). */
const RUNNABLE_EXTS = new Set([
  'exe', 'bat', 'cmd', 'com', 'msi', 'msp', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
  'scr', 'pif', 'lnk', 'url', 'reg', 'cpl', 'jar', 'sh', 'msc', 'inf', 'scf', 'application', 'gadget'
])

const fail = (message: string, missing = false): RevealFileResult => (missing ? { ok: false, message, missing } : { ok: false, message })
const hasDotSegment = (p: string): boolean => p.split(/[\\/]+/).some((s) => s === '.' || s === '..')
const baseName = (p: string): string => p.split(/[\\/]+/).filter(Boolean).pop() ?? p

/** Por que um caminho absoluto não serve (null: serve). */
export function absolutePathProblem(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > MAX_PATH) return 'Caminho inválido.'
  if (/[\u0000-\u001f]/.test(p)) return 'Caminho inválido.'
  if (/^[\\/]{2}[?.]([\\/]|$)/.test(p)) return 'Caminho de dispositivo não é aceito.'
  if (diskReadVerdict(p, '') === 'relative') return 'O caminho precisa ser absoluto.'
  // Só o `C:` do começo tem dois-pontos: o resto seria um fluxo alternativo (a.txt:x).
  if ((/^[a-zA-Z]:/.test(p) ? p.slice(2) : p).includes(':')) return 'Caminho inválido.'
  if (hasDotSegment(p)) return 'O caminho não pode ter "." nem "..".'
  return null
}

/** O caminho absoluto da memória `relPath` (um .md da pasta de memórias), ou o motivo da recusa. */
export function memoryFilePath(memoriesDir: string, relPath: unknown): { file: string } | { problem: string } {
  if (typeof relPath !== 'string' || !relPath || relPath.length > MAX_PATH) return { problem: 'Memória inválida.' }
  if (/[\u0000-\u001f:]/.test(relPath) || /^[\\/]/.test(relPath)) return { problem: 'Memória inválida.' }
  const parts = relPath.split(/[\\/]/)
  if (parts.some((s) => !s || s === '.' || s === '..')) return { problem: 'Memória inválida.' }
  if (!/\.md$/i.test(relPath)) return { problem: 'Só arquivo de memória (.md).' }
  if (!memoriesDir || absolutePathProblem(memoriesDir)) return { problem: 'Pasta de memórias indisponível.' }
  return { file: join(memoriesDir, ...parts) }
}

/** O arquivo e a pasta que tem que contê-lo, já validados (sem tocar no disco). */
async function target(req: unknown, deps: RevealFileDeps): Promise<{ file: string; root: string } | { problem: string }> {
  if (!req || typeof req !== 'object') return { problem: 'Pedido inválido.' }
  const r = req as Record<string, unknown>
  if (r.mode !== 'folder' && r.mode !== 'open') return { problem: 'Pedido inválido.' }
  if ('memory' in r) {
    if (r.mode !== 'folder') return { problem: 'A memória é só leitura: dá só para mostrar na pasta.' }
    const root = deps.memoriesDir()
    const m = memoryFilePath(root, r.memory)
    return 'problem' in m ? m : { file: m.file, root }
  }
  const pathProblem = absolutePathProblem(r.path)
  if (pathProblem) return { problem: pathProblem }
  if (absolutePathProblem(r.cwd)) return { problem: 'Conversa sem pasta de projeto.' }
  const path = r.path as string
  const cwd = r.cwd as string
  let projects: readonly string[]
  try {
    projects = await deps.knownProjects()
  } catch {
    return { problem: 'Não deu para conferir os projetos.' }
  }
  const key = normalizePath(cwd)
  if (!projects.some((p) => typeof p === 'string' && p && normalizePath(p) === key)) return { problem: 'Pasta de projeto desconhecida.' }
  if (!isInside(path, cwd)) return { problem: 'O arquivo fica fora da pasta do projeto.' }
  return { file: path, root: cwd }
}

export async function revealFile(req: unknown, deps: RevealFileDeps): Promise<RevealFileResult> {
  const t = await target(req, deps)
  if ('problem' in t) return fail(t.problem)
  const name = baseName(t.file)
  try {
    const s = await stat(t.file)
    if (!s.isFile()) return fail(`${name} não é um arquivo.`)
  } catch {
    return fail(`${name} não existe mais (apagado ou movido).`, true)
  }
  // Depois de resolver links/junções: um link plantado na pasta não leva para fora dela.
  if (!realPathInside(t.root, t.file)) return fail('O arquivo fica fora da pasta permitida.')
  const mode = (req as { mode: RevealFileRequest['mode'] }).mode
  const ext = /\.([a-z0-9-]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  if (mode === 'folder' || RUNNABLE_EXTS.has(ext)) {
    deps.showItemInFolder(t.file)
    return mode === 'folder'
      ? { ok: true, message: 'Abrindo o Explorador com o arquivo selecionado…' }
      : { ok: true, message: `${name} é executável: abri a pasta com ele selecionado, sem executar.` }
  }
  const err = await deps.openPath(t.file)
  return err ? fail(`Não foi possível abrir ${name}: ${err}`) : { ok: true, message: `Abrindo ${name}…` }
}
