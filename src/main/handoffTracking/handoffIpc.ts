import path from 'node:path'
import { z } from 'zod'
import type { HandoffCorrectEntregaResult, HandoffListResult, HandoffRegisterResult } from '../../shared/api'
import { Channels } from '../../shared/ipc'
import { resolveProjectIdentity } from '../persistence/projectIdentity'
import { HandoffFileName } from '../planning/handoffSent'
import { isValidName } from '../planning/planningModel'
import { HANDOFF_LIST_MAX_LIMIT } from './handoffModel'
import { registerHandoffEnvios, type HandoffRegisterDeps } from './handoffRegister'
import type { HandoffTracker } from './handoffTracker'

/**
 * Os handlers handoff:* do processo main (o registro dos envios de handoff no
 * banco, a leitura e a correção manual). O index.ts só chama
 * registerHandoffIpc com o ipcMain, o getter do repositório e o tracker.
 *
 * Fronteira: todo payload passa por zod antes de tocar o disco ou o banco, e
 * nenhuma exceção atravessa o IPC — a resposta é sempre `{ ok: true, ... }` ou
 * `{ ok: false, message }`. Canal novo: um schema e um `handle(...)` abaixo.
 */

export type HandoffIpcListener = (event: unknown, ...args: unknown[]) => unknown

export interface HandoffIpcDeps extends HandoffRegisterDeps {
  /** Mesmo formato de ipcMain.handle. */
  handle: (channel: string, listener: HandoffIpcListener) => void
  /** O registro; injetável nos testes. */
  register?: typeof registerHandoffEnvios
  /** O acompanhamento: sabe dos envios registrados e faz a correção manual. */
  tracker?: Pick<HandoffTracker, 'onRegistered' | 'correctEntrega'>
}

/** Teto de prompts por envio (um handoff raramente passa de 3 ou 4). */
export const MAX_HANDOFF_REGISTER_PROMPTS = 50
/** O mesmo teto do conteúdo de planningWriteHandoff. */
export const MAX_HANDOFF_PROMPT_CHARS = 1_000_000
/** Teto do motivo da correção manual. */
export const MAX_HANDOFF_CORRECTION_CHARS = 500

const Name = z.string().refine(isValidName, 'use [a-z0-9-], de 1 a 64 caracteres')
const ProjectCwd = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => path.isAbsolute(p), 'projectCwd deve ser caminho absoluto')
const ConversationId = z.string().min(1).max(200)

const RegisterReq = z.strictObject({
  projectCwd: ProjectCwd,
  slug: Name,
  conversationId: ConversationId,
  conversationTitle: z.string().min(1).max(500),
  prompts: z
    .array(
      z.strictObject({
        arquivo: HandoffFileName,
        conteudo: z
          .string()
          .max(MAX_HANDOFF_PROMPT_CHARS)
          .refine((s) => s.trim() !== '', 'o prompt está vazio')
      })
    )
    .min(1)
    .max(MAX_HANDOFF_REGISTER_PROMPTS)
})

const ListReq = z.strictObject({
  conversationId: ConversationId.optional(),
  projectCwd: ProjectCwd.optional(),
  limit: z.number().int().min(1).max(HANDOFF_LIST_MAX_LIMIT).optional()
})

const CorrectReq = z.strictObject({
  entregaId: z.string().min(1).max(200),
  acao: z.enum(['concluir', 'reabrir']),
  motivo: z.string().max(MAX_HANDOFF_CORRECTION_CHARS).optional()
})

type Failure = { ok: false; message: string }

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Getter que lança (backend fora do ar no meio da troca) vale como "sem banco". */
function currentRepository(deps: HandoffIpcDeps): ReturnType<HandoffIpcDeps['repository']> {
  try {
    return deps.repository()
  } catch {
    return null
  }
}

export function registerHandoffIpc(deps: HandoffIpcDeps): void {
  const register = deps.register ?? registerHandoffEnvios
  const projectIdOf = deps.projectId ?? (async (cwd: string) => (await resolveProjectIdentity(cwd)).projectId)

  /** Valida com `schema`, roda e converte qualquer exceção em `{ ok: false }`. */
  function handle<Req, Res extends { ok: true }>(
    channel: string,
    schema: z.ZodType<Req>,
    run: (req: Req) => Promise<Res | Failure>
  ): void {
    deps.handle(channel, async (_event, payload): Promise<Res | Failure> => {
      const parsed = schema.safeParse(payload)
      if (!parsed.success) return { ok: false, message: describeIssues(parsed.error) }
      try {
        return await run(parsed.data)
      } catch (err) {
        console.warn(`[handoff] ${channel} falhou:`, errText(err))
        return { ok: false, message: errText(err) }
      }
    })
  }

  handle(
    Channels.handoffRegister,
    RegisterReq,
    async (req): Promise<Extract<HandoffRegisterResult, { ok: true }>> => {
      const envios = await register(req, deps)
      // O 1º prompt pode ter saído antes de o registro terminar: o tracker casa
      // agora o texto que já viu no agent:send.
      if (envios.length > 0) deps.tracker?.onRegistered(envios)
      return { ok: true, envios }
    }
  )

  handle(Channels.handoffList, ListReq, async (req): Promise<HandoffListResult> => {
    // Sem banco é "não consegui ler", não "nenhum envio": a lista vazia mentiria.
    const repository = currentRepository(deps)
    if (!repository) return { ok: false, message: 'O banco está indisponível agora.' }
    let projectIds: string[] | undefined
    if (req.projectCwd) {
      const projectId = await projectIdOf(req.projectCwd)
      if (!projectId) return { ok: false, message: 'Não consegui identificar o projeto (a pasta dele ainda existe?).' }
      projectIds = [projectId]
    }
    const envios = await repository.listHandoffEnvios({
      ...(req.conversationId ? { conversationId: req.conversationId } : {}),
      ...(projectIds ? { projectIds } : {}),
      ...(req.limit ? { limit: req.limit } : {})
    })
    return { ok: true, envios }
  })

  handle(Channels.handoffCorrectEntrega, CorrectReq, async (req): Promise<HandoffCorrectEntregaResult> => {
    if (!deps.tracker) return { ok: false, message: 'O acompanhamento dos envios não está ativo.' }
    const envio = await deps.tracker.correctEntrega({
      entregaId: req.entregaId,
      acao: req.acao,
      ...(req.motivo?.trim() ? { motivo: req.motivo } : {})
    })
    return { ok: true, envio }
  })
}
