import { promises as fs } from 'node:fs'
import { z } from 'zod'
import type { PlanningHandoffSentDto, PlanningHandoffSentMark } from '../../shared/ipc'
import { atomicWrite, inFileQueue, PlanNotFoundError, resolvePlanPath } from './planningStore'

/**
 * _handoff/enviados.json: o que já saiu de "a enviar" — uma entrada por prompt
 * (por nome de arquivo), enviada a uma conversa, substituída por um arquivo
 * editado ou marcada à mão. Mora com os prompts, na pasta do plano: o disco é
 * a fonte da verdade e sobrevive a reinícios (e acompanha o plano entre PCs).
 *
 * Sem o arquivo (planos antigos), nada foi registrado: tudo está pendente.
 * Arquivo ilegível vale como ausente; quem grava por cima guarda o ilegível
 * ao lado (enviados.json.ilegivel-<ms>) para não apagar o que o usuário tinha.
 */

export const HANDOFF_SENT_FILE = 'enviados.json'

/** Nome de um prompt de _handoff/: qualquer .md que o listHandoffs lista (até
 *  "Prompt final.md"), mas só o nome — sem separador de caminho nem "..". */
export const HandoffFileName = z
  .string()
  .max(255)
  .regex(/^(?!\.)[^\\/:*?"<>|\u0000-\u001f]+\.md$/i, 'nome de prompt inválido (arquivo .md de _handoff/)')

const Title = z.string().min(1).max(500)
const ConvId = z.string().min(1).max(200)

export const HandoffSentMarkSchema = z.union([
  z.strictObject({ nome: HandoffFileName, conversaId: ConvId, conversaTitulo: Title }),
  z.strictObject({ nome: HandoffFileName, substituidoPor: HandoffFileName }),
  z.strictObject({ nome: HandoffFileName, marcadoManualmente: z.literal(true) })
])

const StoredEntry = z.object({
  nome: HandoffFileName,
  enviadoEm: z.string().max(64),
  conversaId: ConvId.optional(),
  conversaTitulo: z.string().max(500).optional(),
  substituidoPor: HandoffFileName.optional(),
  marcadoManualmente: z.literal(true).optional()
})
const StoredFile = z.array(StoredEntry).max(10_000)

export interface HandoffSentRead {
  entries: PlanningHandoffSentDto[]
  /** O arquivo existe mas não é um enviados.json válido (vale como ausente). */
  error?: string
}

async function sentPath(projectCwd: string, slug: string): Promise<string> {
  return resolvePlanPath(projectCwd, slug, '_handoff', HANDOFF_SENT_FILE)
}

async function readRaw(file: string): Promise<HandoffSentRead> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] }
    throw err
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    return { entries: [], error: `${HANDOFF_SENT_FILE} não é JSON válido (${(err as Error).message})` }
  }
  const parsed = StoredFile.safeParse(json)
  if (!parsed.success) return { entries: [], error: `${HANDOFF_SENT_FILE} tem formato inválido` }
  return { entries: parsed.data.map(clean) }
}

/** Só os campos conhecidos, sem `undefined` (o JSON gravado fica limpo). */
function clean(e: z.infer<typeof StoredEntry>): PlanningHandoffSentDto {
  const out: PlanningHandoffSentDto = { nome: e.nome, enviadoEm: e.enviadoEm }
  if (e.conversaId) out.conversaId = e.conversaId
  if (e.conversaTitulo) out.conversaTitulo = e.conversaTitulo
  if (e.substituidoPor) out.substituidoPor = e.substituidoPor
  if (e.marcadoManualmente) out.marcadoManualmente = true
  return out
}

/** Os registros de enviados.json do plano. Nunca lança por conteúdo ruim (ver `error`). */
export async function readHandoffsSent(projectCwd: string, slug: string): Promise<HandoffSentRead> {
  return readRaw(await sentPath(projectCwd, slug))
}

/**
 * Registra `marks` (um por nome; o registro novo substitui o anterior do mesmo
 * nome) e devolve todos os registros. Ler-mesclar-gravar vai na fila do
 * arquivo (dois envios seguidos não se sobrescrevem) e a gravação é atômica.
 * Só num plano que existe: sem isso criaria uma pasta de plano solta.
 */
export async function markHandoffsSent(
  projectCwd: string,
  slug: string,
  marks: readonly PlanningHandoffSentMark[],
  now: Date = new Date()
): Promise<PlanningHandoffSentDto[]> {
  const roteiro = await resolvePlanPath(projectCwd, slug, '_roteiro.md')
  if (!(await fs.stat(roteiro).then((s) => s.isFile(), () => false))) throw new PlanNotFoundError(slug)
  const file = await sentPath(projectCwd, slug)
  return inFileQueue(file, async () => {
    const current = await readRaw(file)
    if (current.error) await fs.rename(file, `${file}.ilegivel-${now.getTime()}`).catch(() => undefined)
    const enviadoEm = now.toISOString()
    const byName = new Map(current.entries.map((e) => [e.nome, e]))
    for (const m of marks) {
      byName.delete(m.nome) // o registro novo vai para o fim, na ordem do pedido
      byName.set(m.nome, clean({ ...m, enviadoEm }))
    }
    const entries = [...byName.values()]
    await atomicWrite(file, `${JSON.stringify(entries, null, 2)}\n`)
    return entries
  })
}
