import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { describeError, text, type ToolText } from './planningToolText'

/**
 * Peças comuns às ferramentas plan_* (planningTools.ts e planningRoteiroTools.ts):
 * os campos de entrada repetidos, o guard que mantém a falha na conversa e o
 * apagamento de tipo que o SDK pede na lista de ferramentas.
 */

export const Name = z.string().regex(/^[a-z0-9-]{1,64}$/, 'use [a-z0-9-], de 1 a 64 caracteres')
export const Title = z.string().min(1).max(1000)
export const Body = z.string().max(1_000_000)

/** Mantém a falha dentro da conversa: o modelo corrige o input e tenta de novo. */
export async function guard(label: string, work: () => Promise<ToolText>): Promise<ToolText> {
  try {
    return await work()
  } catch (error) {
    return text(`${label} falhou: ${describeError(error)}`)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- como o próprio SDK tipa a lista de ferramentas.
export type AnyTool = SdkMcpToolDefinition<any>
export const erase = (definition: unknown): AnyTool => definition as AnyTool
