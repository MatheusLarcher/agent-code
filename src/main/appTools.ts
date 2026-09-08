import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { RestartReply } from './appRestart'

export const APP_RESTART_HINT = 'When Agent Code itself genuinely needs a restart, use app_restart (checkOnly for a read-only guard query). You may request it without asking again, but only this protected tool authorizes restart. A refusal NEVER authorizes kill, Bash, or direct relaunch scripts to bypass the guard. Finish your turn after preparation. History is preserved; automatic continuation of unfinished reasoning is not promised.'

export function createAppMcpServer(request: (reason: string, checkOnly?: boolean) => RestartReply): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: 'app', version: '1.0.0', tools: [tool(
      'app_restart',
      'Prepare a guarded restart of Agent Code after this turn finishes. Refuses other busy/unknown sessions, pending permissions, background work and provider failover. No force option. checkOnly has no effects. Never bypass a refusal.',
      { reason: z.string().trim().min(1).max(500), checkOnly: z.boolean().optional() },
      async ({ reason, checkOnly }) => {
        const reply = request(reason, checkOnly)
        return { isError: !reply.ok, content: [{ type: 'text' as const, text: JSON.stringify(reply) }] }
      }
    )]
  })
}
