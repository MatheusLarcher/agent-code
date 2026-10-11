import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { Channels, type PlanningMockupDto, type PlanningOpenMockupResult } from '../../shared/ipc'
import { findChromeExe } from '../chromeBridge/install'
import { openUrlExternally } from '../openInBrowser'
import { isValidName } from './planningModel'
import { planDirPath, planSandboxDirPath } from './planningRoot'

/**
 * Os mockups do planejamento: as páginas .html/.htm que o Agent Manager gera no
 * _sandbox (docs/spec/<slug>/_sandbox) e as que vieram como mídia (midia/).
 * A tela lista e abre no Google Chrome do usuário (sem Chrome, no navegador
 * padrão) — só um arquivo da lista abre: o caminho do renderer não é confiado.
 */

const MAX_DEPTH = 3
const MAX_MOCKUPS = 50
const SKIP_DIRS = new Set(['node_modules', '.git'])
const HTML_RE = /\.html?$/i

const Ref = z.object({
  projectCwd: z
    .string()
    .min(1)
    .max(4096)
    .refine((p) => path.isAbsolute(p)),
  slug: z.string().refine(isValidName)
})
const OpenReq = Ref.extend({ path: z.string().min(1).max(4096) })

async function walk(root: string, dir: string, depth: number, out: { path: string; rel: string }[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) await walk(root, full, depth + 1, out)
    } else if (e.isFile() && HTML_RE.test(e.name)) {
      out.push({ path: full, rel: path.relative(root, full).replace(/\\/g, '/') })
    }
  }
}

/** Mockups do plano, o mais novo primeiro. Pasta que não existe = nada. */
export async function listMockups(projectCwd: string, slug: string): Promise<PlanningMockupDto[]> {
  const sources: { root: string; origem: PlanningMockupDto['origem'] }[] = [
    { root: planSandboxDirPath(projectCwd, slug), origem: 'sandbox' },
    { root: path.join(planDirPath(projectCwd, slug), 'midia'), origem: 'midia' }
  ]
  const out: PlanningMockupDto[] = []
  for (const { root, origem } of sources) {
    const found: { path: string; rel: string }[] = []
    await walk(root, root, 0, found)
    for (const f of found) {
      const st = await fs.stat(f.path).catch(() => null)
      if (st) out.push({ ...f, origem, mtimeMs: st.mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_MOCKUPS)
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  return norm(a) === norm(b)
}

/** Chrome instalado (janela nova do perfil dele); sem Chrome, o navegador padrão. */
async function openInChrome(file: string): Promise<void> {
  const url = pathToFileURL(file).href
  const chrome = process.platform === 'win32' ? findChromeExe() : null
  if (chrome) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(chrome, [url], { detached: true, stdio: 'ignore', windowsHide: false })
      child.once('error', () => resolve(false))
      child.once('spawn', () => resolve(true))
      child.unref()
    })
    if (ok) return
  }
  await openUrlExternally(url)
}

export async function openMockup(
  projectCwd: string,
  slug: string,
  file: string,
  open: (file: string) => Promise<void> = openInChrome
): Promise<PlanningOpenMockupResult> {
  const list = await listMockups(projectCwd, slug)
  const hit = list.find((m) => samePath(m.path, file))
  if (!hit) return { ok: false, message: 'Esse mockup não existe mais no plano.' }
  await open(hit.path)
  return { ok: true }
}

export function registerPlanningMockupsIpc(
  handle: (channel: string, listener: (event: unknown, req: unknown) => unknown) => void
): void {
  handle(Channels.planningListMockups, async (_e, req) => {
    const r = Ref.safeParse(req)
    if (!r.success) return []
    try {
      return await listMockups(r.data.projectCwd, r.data.slug)
    } catch {
      return []
    }
  })
  handle(Channels.planningOpenMockup, async (_e, req): Promise<PlanningOpenMockupResult> => {
    const r = OpenReq.safeParse(req)
    if (!r.success) return { ok: false, message: 'Pedido inválido.' }
    try {
      return await openMockup(r.data.projectCwd, r.data.slug, r.data.path)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
}
