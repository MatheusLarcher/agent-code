import { promises as fs } from 'node:fs'
import { z } from 'zod'
import { isValidName, PlanningValidationError } from './planningModel'
import { atomicWrite, PlanNotFoundError, resolvePlanPath } from './planningStore'

/**
 * Os prompts de handoff do planejamento: _handoff/AAAA-MM-DD-NN.md (o texto que
 * vai para a conversa de implementação) e, ao lado, _handoff/<base>.meta.json
 * com as etapas do roteiro que aquele prompt cobre: `{ "etapas": [...] }`.
 *
 * As etapas NUNCA vão no .md: o texto segue para o modelo como foi escrito, e o
 * listHandoffs de uma versão antiga do app (só .md) não vê nada novo. Prompt
 * sem o arquivo ao lado (antigo, ou ilegível) não declara etapas.
 *
 * O planningStore reexporta writeHandoff/listHandoffs: quem importava de lá
 * continua importando.
 */

export const MAX_HANDOFF_ETAPAS = 100
/** Teto de leitura do .meta.json: 100 ids de 64 caracteres cabem com folga. */
const MAX_META_BYTES = 64 * 1024

/** Um prompt de handoff gravado em _handoff/ (`createdAt` em ms desde a época). */
export interface HandoffFile {
  name: string
  createdAt: number
  content: string
  /** Ids das etapas que o prompt cobre, na ordem (do .meta.json). Ausente ou inválido = undefined. */
  etapas?: string[]
}

const HandoffMeta = z.object({
  etapas: z
    .array(z.string().refine(isValidName))
    .min(1)
    .max(MAX_HANDOFF_ETAPAS)
    .refine((ids) => new Set(ids).size === ids.length)
})

/** "2026-10-05-01.md" → "2026-10-05-01.meta.json". */
export function handoffMetaName(name: string): string {
  return `${name.replace(/\.md$/i, '')}.meta.json`
}

function assertEtapas(etapas: readonly string[]): void {
  if (etapas.length > MAX_HANDOFF_ETAPAS) {
    throw new PlanningValidationError(`no máximo ${MAX_HANDOFF_ETAPAS} etapas por prompt de handoff`)
  }
  const seen = new Set<string>()
  for (const id of etapas) {
    if (!isValidName(id)) throw new PlanningValidationError(`etapa inválida: ${String(id)} (use [a-z0-9-], de 1 a 64 caracteres)`)
    if (seen.has(id)) throw new PlanningValidationError(`etapa repetida: ${id}`)
    seen.add(id)
  }
}

function today(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/**
 * Grava o prompt enviado ao agente principal em _handoff/AAAA-MM-DD-NN.md;
 * devolve o caminho. Só num planejamento que existe (PlanNotFoundError): sem
 * isso, gravar criaria uma pasta de planejamento solta. Com `etapas` (não
 * vazias), grava logo depois o .meta.json; se ele falhar, o .md sai também —
 * nunca fica um prompt que perdeu as etapas que declarou.
 */
export async function writeHandoff(
  projectCwd: string,
  slug: string,
  conteudo: string,
  now: Date = new Date(),
  etapas?: readonly string[]
): Promise<string> {
  if (etapas) assertEtapas(etapas)
  const roteiro = await resolvePlanPath(projectCwd, slug, '_roteiro.md')
  if (!(await fs.stat(roteiro).then((s) => s.isFile(), () => false))) throw new PlanNotFoundError(slug)
  const dir = await resolvePlanPath(projectCwd, slug, '_handoff')
  await fs.mkdir(dir, { recursive: true })
  const day = today(now)
  const re = new RegExp(`^${day}-(\\d{2,})\\.md$`)
  for (let attempt = 0; attempt < 5; attempt++) {
    let max = 0
    for (const name of await fs.readdir(dir)) {
      const m = re.exec(name)
      if (m) max = Math.max(max, Number(m[1]))
    }
    const name = `${day}-${String(max + 1).padStart(2, '0')}.md`
    const file = await resolvePlanPath(projectCwd, slug, '_handoff', name)
    try {
      await fs.writeFile(file, String(conteudo ?? ''), { encoding: 'utf8', flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      continue
    }
    if (etapas?.length) {
      try {
        const meta = await resolvePlanPath(projectCwd, slug, '_handoff', handoffMetaName(name))
        await atomicWrite(meta, `${JSON.stringify({ etapas: [...etapas] }, null, 2)}\n`)
      } catch (err) {
        await fs.rm(file, { force: true })
        throw err
      }
    }
    return file
  }
  throw new Error('não foi possível numerar o handoff')
}

/** As etapas declaradas no .meta.json do prompt `name`; sem o arquivo, ou ilegível, undefined. */
export async function readHandoffEtapas(projectCwd: string, slug: string, name: string): Promise<string[] | undefined> {
  try {
    const file = await resolvePlanPath(projectCwd, slug, '_handoff', handoffMetaName(name))
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size > MAX_META_BYTES) return undefined
    const parsed = HandoffMeta.safeParse(JSON.parse(await fs.readFile(file, 'utf8')))
    return parsed.success ? parsed.data.etapas : undefined
  } catch {
    // Ausente, JSON quebrado ou caminho recusado: o prompt só não declara etapas.
    return undefined
  }
}

const HANDOFF_NAME = /^(\d{4}-\d{2}-\d{2})-(\d+)\.md$/

/** Ordem dos handoffs: pelo nome AAAA-MM-DD-NN (NN numérico, pode passar de 99);
 *  nome fora do formato vai pela data de criação e, empatando, pelo nome. */
function compareHandoffs(a: HandoffFile, b: HandoffFile): number {
  const ma = HANDOFF_NAME.exec(a.name)
  const mb = HANDOFF_NAME.exec(b.name)
  if (ma && mb) {
    if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1
    return Number(ma[2]) - Number(mb[2])
  }
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Os prompts gravados em _handoff/ (só arquivos .md comuns — symlink e pasta
 * ficam de fora), na ordem em que foram gravados, com as etapas de cada um.
 * Sem a pasta, lista vazia.
 */
export async function listHandoffs(projectCwd: string, slug: string): Promise<HandoffFile[]> {
  const dir = await resolvePlanPath(projectCwd, slug, '_handoff')
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: HandoffFile[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue
    const file = await resolvePlanPath(projectCwd, slug, '_handoff', e.name)
    try {
      const [stat, content] = await Promise.all([fs.stat(file), fs.readFile(file, 'utf8')])
      const born = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
      const etapas = await readHandoffEtapas(projectCwd, slug, e.name)
      out.push({ name: e.name, createdAt: Math.round(born), content, ...(etapas ? { etapas } : {}) })
    } catch (err) {
      // Apagado entre o readdir e a leitura: não entra na lista.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return out.sort(compareHandoffs)
}
