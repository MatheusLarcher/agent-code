import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { RestartReply } from './appRestart'
import { OFFICE_CALL_MESSAGE_MAX } from '../shared/officeCall'
import { checkMockupFile } from './officeMockup/mockupFiles'
import { PRINT_CAPTION_MAX } from './board/boardPrints'

export const APP_RESTART_HINT = 'When Agent Code itself genuinely needs a restart, use app_restart (checkOnly for a read-only guard query). You may request it without asking again, but only this protected tool authorizes restart. A refusal NEVER authorizes kill, Bash, or direct relaunch scripts to bypass the guard. Finish your turn after preparation. History is preserved; automatic continuation of unfinished reasoning is not promised.'

export const APP_CALL_HINT = 'When you want the user to look at an HTML page or mockup you created, call app_chamar_usuario with the .html/.htm file (inside this conversation\'s folder) and an optional short message. It does not wait for an answer: keep working; the user replies in the chat.'

export const APP_PRINT_HINT = 'When you finish a task that changed something VISIBLE (screen, page, component, 3D scene) and you tested it, attach 1-2 screenshots of the result to its board card with app_anexar_print. Only the window or page under test, never the whole computer screen; skip any print that shows a password, token or other sensitive data. Tasks without visuals (backend, tests, refactor, config): do not attach.'

/** O que o handler do `app_anexar_print` devolve (o main valida, comprime e grava). */
export interface AppPrintReply {
  ok: boolean
  message: string
}

/** O chamado aceito pela ferramenta: o id da chamada (se se sabe), o caminho absoluto do HTML e a mensagem. */
export interface AppCall {
  id: string | null
  path: string
  mensagem: string | null
}

export interface AppMcpOptions {
  /** O reinício protegido (só quando o coordenador existe). */
  restart?: (reason: string, checkOnly?: boolean) => RestartReply
  /** A pasta da conversa: o HTML do chamado tem de estar dentro dela. */
  cwd: string
  /** O id da chamada da ferramenta, anotado no PreToolUse (retirado mesmo se a chamada for recusada). */
  callId?: (arquivo: string) => string | null
  /** Chamado aceito (o main avisa o Windows e a ponte); não bloqueia a ferramenta. */
  onCall?: (call: AppCall) => void
  /** O print da tarefa visual no cartão (fora do Agent Manager). */
  attachPrint?: (input: { arquivo: string; tarefa?: string; legenda?: string }) => Promise<AppPrintReply>
}

const text = (t: string, isError = false) => ({ isError, content: [{ type: 'text' as const, text: t }] })

export function createAppMcpServer(opts: AppMcpOptions): ReturnType<typeof createSdkMcpServer> {
  const restart = opts.restart
  const attach = opts.attachPrint
  return createSdkMcpServer({
    name: 'app', version: '1.0.0', tools: [
      ...(attach ? [tool(
        'app_anexar_print',
        'Attach a screenshot of what you just tested to its board card, so the user sees the result. Only for a task with a VISIBLE result (screen, page, component, 3D scene) that you tested: 1-2 prints of the window or page under test. NEVER the whole computer screen (refused), and never a print showing a password, token or other sensitive data. PNG, JPEG or WebP up to 10 MB; the app compresses it and keeps the 4 newest per card.',
        {
          arquivo: z.string().trim().min(1).max(4096).describe('Image file you generated while testing (absolute, or relative to this conversation\'s folder).'),
          tarefa: z.string().trim().max(500).optional().describe('Which card: the TodoWrite task id, its exact title or its "[step-id]" prefix. Omit only when exactly one task is in progress.'),
          legenda: z.string().trim().max(PRINT_CAPTION_MAX).optional().describe('Short caption, e.g. "new login screen, with the wrong-password error".')
        },
        async ({ arquivo, tarefa, legenda }) => {
          const reply = await attach({ arquivo, tarefa, legenda }).catch((err: unknown) => ({ ok: false, message: `Recusado: ${String(err)}` }))
          return text(reply.message, !reply.ok)
        }
      )] : []),
      ...(restart ? [tool(
        'app_restart',
        'Prepare a guarded restart of Agent Code after this turn finishes. Refuses other busy/unknown sessions, pending permissions, background work and provider failover. No force option. checkOnly has no effects. Never bypass a refusal.',
        { reason: z.string().trim().min(1).max(500), checkOnly: z.boolean().optional() },
        async ({ reason, checkOnly }) => {
          const reply = restart(reason, checkOnly)
          return text(JSON.stringify(reply), !reply.ok)
        }
      )] : []),
      tool(
        'app_chamar_usuario',
        'Call the user to look at an HTML page/mockup you created: your character walks to the office TV and waves, and the user gets a notification. Returns "ok" immediately — it does not wait for an answer; keep working. The user replies in the chat.',
        {
          arquivo: z.string().trim().min(1).max(4096).refine((p) => /\.html?$/i.test(p), 'arquivo must be a .html/.htm file')
            .describe('Path of the .html/.htm file, inside this conversation\'s folder (absolute or relative to it).'),
          mensagem: z.string().trim().max(OFFICE_CALL_MESSAGE_MAX).optional().describe('Optional short message for the user.')
        },
        async ({ arquivo, mensagem }) => {
          const id = opts.callId?.(arquivo) ?? null
          const path = isAbsolute(arquivo) ? arquivo : join(opts.cwd, arquivo)
          const error = await checkMockupFile(opts.cwd, path)
          if (error) return text(`Recusado: ${error} (${arquivo}). The file must be an existing .html/.htm inside ${opts.cwd}.`, true)
          try {
            opts.onCall?.({ id, path, mensagem: mensagem || null })
          } catch {
            /* o aviso falhou; o chamado segue nas mensagens */
          }
          return text('ok')
        }
      )
    ]
  })
}
