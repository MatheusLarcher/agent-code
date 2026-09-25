import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ImageAttachment } from '../shared/ipc'

/**
 * vision_fallback_router — lets a text-only model (most Ollama Cloud models)
 * "see" an attached image without ever receiving the image itself. A one-off,
 * tool-free query to a multimodal Claude model extracts a structured technical
 * description; that description (not the image) is what reaches the main
 * model's context. Transparent to the user — same conversation, same reply.
 */

/** Multimodal model used to interpret images on behalf of a text-only model.
 *  Fixed to a high-quality Claude model — this is an interpreter, not the
 *  model answering the user, so cost/latency here should stay small (one
 *  short turn, no tools). */
const VISION_MODEL = 'claude-sonnet-5'

const VISION_PROMPT = `Analise a(s) imagem(ns) anexada(s) e devolva uma descrição TÉCNICA e ESTRUTURADA, em português, cobrindo exatamente estas seções (omita uma seção só se genuinamente não se aplicar, mas mantenha o título):

Texto visível (OCR completo):
Erros encontrados:
Elementos de interface (botões, inputs, tabelas, labels):
Layout visual:
Contexto técnico:
Logs ou stack traces:
Componentes relevantes:
Possíveis problemas identificados:

Seja literal e completo no OCR (transcreva o texto exatamente como aparece). Não responda à pergunta do usuário — apenas descreva o que está na imagem; quem vai responder é outro modelo, que só tem o seu texto para "ver" a imagem.`

/** Runs a single, tool-free query against the vision model and returns its
 *  final text answer (concatenated across any text blocks). Throws on the
 *  underlying SDK/network failure — the caller decides how to degrade. */
export async function describeImages(
  images: ImageAttachment[],
  userText: string,
  /** Env da conta Claude da conversa; ausente = login da máquina. */
  env?: NodeJS.ProcessEnv
): Promise<string> {
  const blocks: unknown[] = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data }
  }))
  const prompt = userText
    ? `${VISION_PROMPT}\n\nContexto da mensagem original do usuário (só para foco, não responda a ela): ${userText}`
    : VISION_PROMPT
  blocks.push({ type: 'text', text: prompt })

  async function* single(): AsyncIterable<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null } as SDKUserMessage
  }

  const options: Options = {
    model: VISION_MODEL,
    executable: 'node',
    tools: [], // pure interpreter — no tool calls, just the analysis text
    maxTurns: 1,
    includePartialMessages: false,
    permissionMode: 'bypassPermissions',
    // Sem a auto-memória do CLI: a única pasta de memória é a de Configurações.
    settings: { autoMemoryEnabled: false },
    ...(env ? { env } : {})
  }

  const q = query({ prompt: single(), options })
  let text = ''
  for await (const message of q) {
    if (message.type === 'assistant') {
      const content = (message.message as { content?: Array<{ type: string; text?: string }> }).content ?? []
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') text += block.text
      }
    }
  }
  return text.trim()
}

/** Wraps the analysis in the [VISUAL_CONTEXT] block injected into the main
 *  model's prompt. */
export function buildVisualContextBlock(analysis: string): string {
  return `[VISUAL_CONTEXT]\n${analysis}\n[/VISUAL_CONTEXT]`
}

/** Builds the final text sent to the main (text-only) model: the user's
 *  original message plus the extracted visual context, per the format the
 *  main model is expected to read. */
export function mergeUserTextWithVisualContext(userText: string, analysis: string): string {
  const block = buildVisualContextBlock(analysis)
  const original = userText || '(sem texto — apenas a(s) imagem(ns) anexada(s))'
  return `Mensagem original do usuário:\n${original}\n\nContexto visual extraído:\n${block}\n\nAgora responda considerando a análise visual acima.`
}
