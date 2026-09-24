import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  assertValidName,
  parseCard,
  parseRoteiro,
  serializeCard,
  serializeRoteiro,
  validateCard,
  PlanningValidationError,
  type PlanCard,
  type Roteiro
} from './planningModel'
import {
  ensureMigrated,
  legacySpecRoot,
  planDirPath,
  planningRootFor,
  PlanningPathError,
  planSandboxDirPath
} from './planningRoot'
import { forgetOwnWrite, recordOwnWrite } from './planningWrites'

// A raiz (pasta de dados ou docs/spec) mora em planningRoot; quem já importava
// daqui continua importando.
export {
  planDirPath,
  planningDataDir,
  planningRootFor,
  PlanningPathError,
  PLANNING_DATA_SUBDIR,
  planSandboxDirPath,
  setPlanningDataRoot
} from './planningRoot'

/**
 * Armazenamento em disco da Tela de Planejamento, por projeto:
 *   <raiz>/<slug>/_roteiro.md, _canvas.json, cards/<id>.md e
 *   _handoff/AAAA-MM-DD-NN.md.
 *
 * A raiz é a da pasta de dados do app (<dataDir>/planning/<projectKey>/, ver
 * setPlanningDataRoot): o plano acompanha o usuário entre PCs como as
 * conversas e as memórias. Sem resolvedor configurado (testes, ferramentas),
 * vale a raiz legada <cwd>/docs/spec/ (planningRoot). Os planos que ainda estão
 * na legada são copiados para a nova na listagem/abertura (planningMigration).
 *
 * O _sandbox/ (código descartável do Agent Manager) continua no projeto, em
 * <cwd>/docs/spec/<slug>/_sandbox/ (gitignorado): é local de cada PC.
 *
 * Todo caminho passa por resolvePlanPath, que recusa nomes fora de [a-z0-9-]
 * e qualquer destino (inclusive via symlink) fora da pasta do planejamento.
 * Gravações são atômicas (tmp + rename); cards e roteiro usam rev otimista.
 */

export const SANDBOX_GITIGNORE_LINE = 'docs/spec/*/_sandbox/'

export interface CanvasLayout {
  positions: Record<string, { x: number; y: number }>
  viewport?: { x: number; y: number; zoom: number }
}

/** Arquivo do planejamento que não pôde ser lido; `file` é relativo à pasta dele. */
export interface InvalidPlanFile {
  file: string
  error: string
}

export interface OpenedPlan {
  slug: string
  /** Pasta ABSOLUTA do planejamento (roteiro, cards, _handoff). */
  dir: string
  /** Pasta ABSOLUTA do _sandbox do Agent Manager, no projeto. */
  sandboxDir: string
  roteiro: Roteiro
  cards: PlanCard[]
  layout: CanvasLayout
  /** Cards que falharam ao carregar (frontmatter quebrado, nome inválido…).
   *  Não derrubam o planejamento: os válidos seguem em `cards`. */
  invalid: InvalidPlanFile[]
}

/** O planejamento pedido não existe (sem _roteiro.md). */
export class PlanNotFoundError extends PlanningPathError {
  constructor(slug: string) {
    super(`planejamento não encontrado: ${slug}`)
    this.name = 'PlanNotFoundError'
  }
}

/** rev desatualizado: `current` é o card como está em disco (null se não existe). */
export class RevConflictError extends Error {
  constructor(
    readonly current: PlanCard | null,
    readonly expectedRev: number
  ) {
    super(`rev desatualizado: esperado ${expectedRev}, atual ${current ? current.rev : 'inexistente'}`)
    this.name = 'RevConflictError'
  }
}

/** rev do roteiro desatualizado: `current` é o _roteiro.md como está em disco. */
export class RoteiroConflictError extends Error {
  constructor(
    readonly current: Roteiro,
    readonly expectedRev: number
  ) {
    super(`rev do roteiro desatualizado: esperado ${expectedRev}, atual ${current.rev}`)
    this.name = 'RoteiroConflictError'
  }
}

/** O que quem grava manda: o rev novo é sempre o do disco + 1. */
export type RoteiroDraft = Pick<Roteiro, 'titulo' | 'etapas'>

/** Um prompt de handoff gravado em _handoff/ (`createdAt` em ms desde a época). */
export interface HandoffFile {
  name: string
  createdAt: number
  content: string
}

/**
 * Fila por arquivo: ler-conferir-gravar de um arquivo do planejamento (roteiro,
 * card) não se intercala dentro do processo — a tela, via IPC, e o Manager, via
 * plan_*, vivem no mesmo main. Arquivos diferentes seguem em paralelo.
 */
const fileQueues = new Map<string, Promise<unknown>>()

async function inFileQueue<T>(file: string, work: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? file.toLowerCase() : file
  const run = (fileQueues.get(key) ?? Promise.resolve()).then(work)
  const tail = run.catch(() => undefined)
  fileQueues.set(key, tail)
  try {
    return await run
  } finally {
    if (fileQueues.get(key) === tail) fileQueues.delete(key)
  }
}

const EMPTY_LAYOUT: CanvasLayout = { positions: {} }

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function realOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return p
  }
}

/**
 * Caminho de um arquivo do planejamento. `parts` são segmentos fixos do
 * formato ('cards', '_handoff', ...) mais nomes já validados. Confere também
 * o caminho real: um symlink que aponte para fora da pasta é recusado.
 */
async function resolvePlanPath(projectCwd: string, slug: string, ...parts: string[]): Promise<string> {
  assertValidName(slug, 'slug')
  const root = planningRootFor(projectCwd)
  const planDir = path.join(root, slug)
  const target = path.join(planDir, ...parts)
  if (!isInside(planDir, target)) throw new PlanningPathError('caminho fora da pasta do planejamento')
  const realRoot = await realOrSelf(root)
  const realPlan = await fs.realpath(planDir).catch(() => path.join(realRoot, slug))
  if (!isInside(realRoot, realPlan) || path.relative(realRoot, realPlan) !== slug) {
    throw new PlanningPathError('pasta do planejamento escapa da raiz dos planejamentos')
  }
  // Confere cada ancestral existente do alvo (o alvo pode ainda não existir).
  let probe = target
  while (probe !== planDir) {
    try {
      const real = await fs.realpath(probe)
      if (!isInside(realPlan, real)) throw new PlanningPathError('symlink escapa da pasta do planejamento')
      break
    } catch (err) {
      if (err instanceof PlanningPathError) throw err
      probe = path.dirname(probe)
    }
  }
  return target
}

/**
 * Toda gravação do app passa aqui, e é aqui que ela vira "própria": o hash é
 * anotado ANTES do rename, então o vigia nunca vê o arquivo novo sem o
 * registro correspondente (ver planningWrites).
 */
async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, content, 'utf8')
    recordOwnWrite(file, content)
    await fs.rename(tmp, file)
  } catch (err) {
    forgetOwnWrite(file)
    await fs.rm(tmp, { force: true })
    throw err
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function cardFile(id: string): string[] {
  assertValidName(id, 'id do card')
  return ['cards', `${id}.md`]
}

async function readCard(projectCwd: string, slug: string, id: string): Promise<PlanCard | null> {
  const text = await readIfExists(await resolvePlanPath(projectCwd, slug, ...cardFile(id)))
  return text === null ? null : parseCard(text)
}

export async function listPlans(projectCwd: string): Promise<string[]> {
  await ensureMigrated(projectCwd)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(planningRootFor(projectCwd), { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: string[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    try {
      assertValidName(e.name, 'slug')
    } catch {
      continue
    }
    const roteiro = await resolvePlanPath(projectCwd, e.name, '_roteiro.md').catch(() => null)
    if (roteiro && (await readIfExists(roteiro)) !== null) out.push(e.name)
  }
  return out.sort()
}

function parseLayout(text: string | null): CanvasLayout {
  if (text === null) return { positions: {} }
  const data = JSON.parse(text) as Partial<CanvasLayout>
  return validateLayout({ positions: data.positions ?? {}, ...(data.viewport ? { viewport: data.viewport } : {}) })
}

function validateLayout(layout: CanvasLayout): CanvasLayout {
  const finite = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n)
  if (!layout || typeof layout.positions !== 'object' || layout.positions === null) {
    throw new PlanningValidationError('layout sem positions')
  }
  for (const [id, pos] of Object.entries(layout.positions)) {
    assertValidName(id, 'id no layout')
    if (!pos || !finite(pos.x) || !finite(pos.y)) throw new PlanningValidationError(`posição inválida: ${id}`)
  }
  const v = layout.viewport
  if (v !== undefined && (!finite(v.x) || !finite(v.y) || !finite(v.zoom))) {
    throw new PlanningValidationError('viewport inválido')
  }
  return layout
}

/**
 * Abre o planejamento. Um card .md malformado (editado à mão, pelo agente ou
 * pela metade) não derruba o resto: vai para `invalid` com o motivo. Erros de
 * caminho (symlink para fora) e de disco continuam sendo exceção.
 */
export async function openPlan(projectCwd: string, slug: string): Promise<OpenedPlan> {
  assertValidName(slug, 'slug')
  await ensureMigrated(projectCwd, slug)
  const roteiroText = await readIfExists(await resolvePlanPath(projectCwd, slug, '_roteiro.md'))
  if (roteiroText === null) throw new PlanNotFoundError(slug)
  const cardsDir = await resolvePlanPath(projectCwd, slug, 'cards')
  let names: string[] = []
  try {
    names = await fs.readdir(cardsDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const cards: PlanCard[] = []
  const invalid: InvalidPlanFile[] = []
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue
    const file = `cards/${name}`
    const id = name.slice(0, -3)
    try {
      assertValidName(id, 'id do card')
      const card = await readCard(projectCwd, slug, id)
      if (!card) continue
      if (card.id !== id) {
        throw new PlanningValidationError(`id do frontmatter (${card.id}) difere do nome do arquivo (${id})`)
      }
      cards.push(card)
    } catch (err) {
      if (!(err instanceof PlanningValidationError)) throw err
      invalid.push({ file, error: err.message })
    }
  }
  const layout = parseLayout(await readIfExists(await resolvePlanPath(projectCwd, slug, '_canvas.json')))
  return { slug, ...planDirs(projectCwd, slug), roteiro: parseRoteiro(roteiroText), cards, layout, invalid }
}

function planDirs(projectCwd: string, slug: string): Pick<OpenedPlan, 'dir' | 'sandboxDir'> {
  return { dir: planDirPath(projectCwd, slug), sandboxDir: planSandboxDirPath(projectCwd, slug) }
}

/** Garante SANDBOX_GITIGNORE_LINE no .gitignore da raiz, sem duplicar nem mexer no resto. */
export async function ensureSandboxGitignore(projectCwd: string): Promise<void> {
  legacySpecRoot(projectCwd)
  const file = path.join(path.resolve(projectCwd), '.gitignore')
  const current = await readIfExists(file)
  if (current === null) {
    await atomicWrite(file, `${SANDBOX_GITIGNORE_LINE}\n`)
    return
  }
  const lines = current.split(/\r?\n/).map((l) => l.trim())
  if (lines.includes(SANDBOX_GITIGNORE_LINE)) return
  const eol = current.includes('\r\n') ? '\r\n' : '\n'
  const sep = current === '' || current.endsWith('\n') ? '' : eol
  await atomicWrite(file, `${current}${sep}${SANDBOX_GITIGNORE_LINE}${eol}`)
}

export async function createPlan(projectCwd: string, slug: string, titulo: string): Promise<OpenedPlan> {
  assertValidName(slug, 'slug')
  // Um plano legado com este slug vem antes para a raiz nova: assim a colisão
  // é conferida contra ele, e o novo nunca o esconde.
  await ensureMigrated(projectCwd, slug)
  const roteiroPath = await resolvePlanPath(projectCwd, slug, '_roteiro.md')
  if ((await readIfExists(roteiroPath)) !== null) {
    throw new PlanningValidationError(`planejamento já existe: ${slug}`)
  }
  const roteiro: Roteiro = { titulo: String(titulo ?? '').trim() || slug, rev: 1, etapas: [] }
  await atomicWrite(roteiroPath, serializeRoteiro(roteiro))
  await atomicWrite(await resolvePlanPath(projectCwd, slug, '_canvas.json'), JSON.stringify(EMPTY_LAYOUT, null, 2) + '\n')
  await fs.mkdir(await resolvePlanPath(projectCwd, slug, 'cards'), { recursive: true })
  // O _sandbox fica no projeto (código descartável, local deste PC), gitignorado.
  await fs.mkdir(planSandboxDirPath(projectCwd, slug), { recursive: true })
  await ensureSandboxGitignore(projectCwd)
  return { slug, ...planDirs(projectCwd, slug), roteiro, cards: [], layout: { positions: {} }, invalid: [] }
}

/**
 * Grava o card se `expectedRev` bate com o rev em disco (0 para card novo).
 * Devolve o card gravado com rev = expectedRev + 1.
 */
export async function saveCard(
  projectCwd: string,
  slug: string,
  card: PlanCard,
  expectedRev: number
): Promise<PlanCard> {
  const file = await resolvePlanPath(projectCwd, slug, ...cardFile(card.id))
  return inFileQueue(file, async () => {
    const current = await readCard(projectCwd, slug, card.id)
    const currentRev = current ? current.rev : 0
    if (expectedRev !== currentRev) throw new RevConflictError(current, expectedRev)
    const next = validateCard({ ...card, rev: currentRev + 1 })
    await atomicWrite(file, serializeCard(next))
    return next
  })
}

export async function deleteCard(projectCwd: string, slug: string, id: string, expectedRev: number): Promise<void> {
  const file = await resolvePlanPath(projectCwd, slug, ...cardFile(id))
  await inFileQueue(file, async () => {
    const current = await readCard(projectCwd, slug, id)
    if (!current || current.rev !== expectedRev) throw new RevConflictError(current, expectedRev)
    recordOwnWrite(file, null)
    try {
      await fs.rm(file)
    } catch (err) {
      forgetOwnWrite(file)
      throw err
    }
  })
}

/**
 * Grava o roteiro se `expectedRev` bate com o rev em disco (0 para roteiro sem
 * rev, gravado antes dele existir); senão lança RoteiroConflictError com o
 * atual. Devolve o roteiro como ficou em disco, com rev = expectedRev + 1.
 */
export async function saveRoteiro(
  projectCwd: string,
  slug: string,
  roteiro: RoteiroDraft,
  expectedRev: number
): Promise<Roteiro> {
  const file = await resolvePlanPath(projectCwd, slug, '_roteiro.md')
  return inFileQueue(file, async () => {
    const text = await readIfExists(file)
    if (text === null) throw new PlanNotFoundError(slug)
    const current = parseRoteiro(text)
    if (expectedRev !== current.rev) throw new RoteiroConflictError(current, expectedRev)
    const content = serializeRoteiro({ titulo: roteiro.titulo, rev: current.rev + 1, etapas: roteiro.etapas })
    await atomicWrite(file, content)
    return parseRoteiro(content)
  })
}

export async function saveLayout(projectCwd: string, slug: string, layout: CanvasLayout): Promise<void> {
  const clean = validateLayout(layout)
  await atomicWrite(await resolvePlanPath(projectCwd, slug, '_canvas.json'), JSON.stringify(clean, null, 2) + '\n')
}

function today(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/**
 * Grava o prompt enviado ao agente principal em _handoff/AAAA-MM-DD-NN.md;
 * devolve o caminho. Só num planejamento que existe (PlanNotFoundError): sem
 * isso, gravar criaria uma pasta de planejamento solta.
 */
export async function writeHandoff(
  projectCwd: string,
  slug: string,
  conteudo: string,
  now: Date = new Date()
): Promise<string> {
  if ((await readIfExists(await resolvePlanPath(projectCwd, slug, '_roteiro.md'))) === null) {
    throw new PlanNotFoundError(slug)
  }
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
    const file = await resolvePlanPath(projectCwd, slug, '_handoff', `${day}-${String(max + 1).padStart(2, '0')}.md`)
    try {
      await fs.writeFile(file, String(conteudo ?? ''), { encoding: 'utf8', flag: 'wx' })
      return file
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error('não foi possível numerar o handoff')
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
 * ficam de fora), na ordem em que foram gravados. Sem a pasta, lista vazia.
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
      out.push({ name: e.name, createdAt: Math.round(born), content })
    } catch (err) {
      // Apagado entre o readdir e a leitura: não entra na lista.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return out.sort(compareHandoffs)
}
