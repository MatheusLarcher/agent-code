import { z } from 'zod'
import type { CentralCorrection, CentralRouteRequest } from '../../shared/central'

/**
 * Fronteira do IPC da Central: o que chega da tela passa por aqui antes de
 * tocar o decisor ou o disco. Inválido = Error (o IPC rejeita; a tela cai na
 * heurística dela). Campos desconhecidos são descartados.
 */

export const CENTRAL_TEXT_MAX_CHARS = 20_000
const MAX_ATTACHMENTS = 20
const ATTACHMENT_NAME_MAX = 200
const MAX_RECENTS = 5
const CONV_ID_MAX = 100
const RECENT_TEXT_MAX = 2_000
/** Pasta, título e nome de projeto: folgados (a tela manda o que tem), mas com teto. */
const PATH_MAX = 2_000
const LABEL_MAX = 2_000

const convId = z.string().min(1).max(CONV_ID_MAX)
const path = z.string().min(1).max(PATH_MAX)

const TargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('conversation'),
    convId,
    cwd: path,
    project: z.string().max(LABEL_MAX),
    title: z.string().max(LABEL_MAX),
    sandbox: z.boolean()
  }),
  z.object({ kind: z.literal('new-conversation'), cwd: path, project: z.string().max(LABEL_MAX) }),
  z.object({ kind: z.literal('new-sandbox') })
])

const text = z.string().trim().min(1).max(CENTRAL_TEXT_MAX_CHARS)
const attachments = z.array(z.string().max(ATTACHMENT_NAME_MAX)).max(MAX_ATTACHMENTS)

const RouteRequestSchema = z.object({
  text,
  attachments,
  recent: z
    .array(
      z.object({
        convId,
        request: z.string().max(RECENT_TEXT_MAX),
        replyStart: z.string().max(RECENT_TEXT_MAX),
        cwd: z.string().max(PATH_MAX).optional(),
        title: z.string().max(LABEL_MAX).optional()
      })
    )
    .max(MAX_RECENTS),
  forceAsk: z.boolean().optional(),
  exclude: TargetSchema.optional()
})

const CorrectionSchema = z.object({
  ts: z.number().nonnegative(),
  text,
  attachments,
  from: TargetSchema,
  fromRule: z.enum(['continua', 'conversa-antiga', 'nova', 'sandbox']).optional(),
  fromConfidence: z.number().min(0).max(1).optional(),
  to: TargetSchema
})

/** O primeiro problema, pelo caminho do campo (nunca o valor: pode ser conteúdo do usuário). */
function describe(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'formato inválido'
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
}

export function parseRouteRequest(payload: unknown): CentralRouteRequest {
  const parsed = RouteRequestSchema.safeParse(payload)
  if (!parsed.success) throw new Error(`Pedido de rota da Central inválido (${describe(parsed.error)}).`)
  return parsed.data
}

export function parseCorrection(payload: unknown): CentralCorrection {
  const parsed = CorrectionSchema.safeParse(payload)
  if (!parsed.success) throw new Error(`Correção da Central inválida (${describe(parsed.error)}).`)
  return parsed.data
}
