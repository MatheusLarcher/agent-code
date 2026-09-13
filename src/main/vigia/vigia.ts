import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent, VigiaAlertMsg, VigiaConfig } from '../../shared/ipc'
import {
  alertFingerprint,
  buildVigiaPrompt,
  parseVigiaVerdict,
  summarizeCall,
  VIGIA_CALL_TRIGGER,
  VIGIA_COOLDOWN_MS,
  VIGIA_MAX_CALLS,
  type VigiaCall
} from './vigiaPrompt'

/**
 * O vigia: uma segunda sessão, barata, que assiste ao trabalho e pergunta uma
 * coisa só — alguma premissa aqui depende de algo que só o usuário sabe?
 *
 * Três invariantes que definem o recurso:
 *
 * 1. **Não fala com o agente principal.** A saída vai para a UI por um canal
 *    próprio; nunca vira `ChatEvent`, nunca entra no histórico que o modelo
 *    relê. Um segundo dono da decisão é exatamente o que não se quer.
 * 2. **Não interrompe nada.** Nenhum caminho daqui cancela turno, e falha de
 *    rede/SDK degrada em silêncio — o observador não pode derrubar o observado.
 * 3. **Fala pouco.** Uma análise por turno, cooldown por conversa, digest
 *    capado e dedupe por conteúdo. Aviso que aparece demais deixa de ser lido.
 *
 * Ver docs/superpowers/specs/2026-09-12-vigia-questionador-paralelo-design.md.
 */

export interface VigiaDeps {
  /** Lido a cada análise: desligar na tela vale na hora, sem reiniciar sessão. */
  config(): VigiaConfig
  /** Entrega do alerta ao renderer (canal `vigia:alert`). */
  emit(alert: VigiaAlertMsg): void
  /** A chamada ao modelo. Injetável para o teste não subir o SDK. */
  ask?(prompt: string, model: string): Promise<string>
  now?(): number
}

interface ConvState {
  /** null = nenhum turno do usuário em aberto; sem isso o vigia não roda. */
  userText: string | null
  calls: VigiaCall[]
  /** Uma análise por turno: marcado ANTES da chamada (que é assíncrona). */
  fired: boolean
  lastRunAt: number
  seen: Set<string>
}

export class Vigia {
  private readonly state = new Map<string, ConvState>()
  private seq = 0

  constructor(private readonly deps: VigiaDeps) {}

  /** Um turno começou. Só a partir daqui há algo para julgar — retomada de
   *  sessão e turno de recuperação não passam por aqui, e é o que se quer. */
  noteUserMessage(convId: string, text: string): void {
    // O cooldown e o dedupe são da CONVERSA, não do turno: precisam sobreviver
    // ao turno novo, senão o mesmo alerta voltaria a cada mensagem.
    const conv = this.conv(convId)
    conv.userText = text
    conv.calls = []
    conv.fired = false
  }

  /** Alimentado pelo tee de eventos do main. Nunca lança. */
  observe(convId: string, event: ChatEvent): void {
    const conv = this.conv(convId)
    if (conv.userText === null || conv.fired) return
    if (event.kind === 'tool-use') {
      if (conv.calls.length < VIGIA_MAX_CALLS) {
        conv.calls.push({ tool: event.name, detail: summarizeCall(event.name, event.input) })
      }
      if (conv.calls.length >= VIGIA_CALL_TRIGGER) void this.run(convId)
      return
    }
    // Turno curto: a análise ainda vale (refazer costuma ser barato), então
    // roda no fim em vez de perder a janela.
    if (event.kind === 'result') {
      void this.run(convId)
      return
    }
    // Turno que morreu não é premissa errada — é falha. Fecha sem analisar.
    if (event.kind === 'error') conv.userText = null
  }

  /** Conversa excluída/encerrada: some com o estado dela. */
  dispose(convId: string): void {
    this.state.delete(convId)
  }

  private conv(convId: string): ConvState {
    let conv = this.state.get(convId)
    if (!conv) {
      conv = { userText: null, calls: [], fired: false, lastRunAt: 0, seen: new Set() }
      this.state.set(convId, conv)
    }
    return conv
  }

  private async run(convId: string): Promise<void> {
    const conv = this.conv(convId)
    if (conv.userText === null || conv.fired) return
    conv.fired = true

    const cfg = this.deps.config()
    if (!cfg.enabled) return
    const now = this.deps.now?.() ?? Date.now()
    if (now - conv.lastRunAt < VIGIA_COOLDOWN_MS) return
    conv.lastRunAt = now

    const prompt = buildVigiaPrompt({ userText: conv.userText, calls: conv.calls })
    let raw: string
    try {
      raw = await (this.deps.ask ?? askVigia)(prompt, cfg.model)
    } catch {
      return // degrada em silêncio: o vigia nunca atrapalha a conversa
    }

    const alert = parseVigiaVerdict(raw)
    if (!alert) return
    const fingerprint = alertFingerprint(alert)
    if (conv.seen.has(fingerprint)) return
    conv.seen.add(fingerprint)

    this.deps.emit({ convId, id: `vigia-${now}-${++this.seq}`, text: alert, at: now })
  }
}

/** A chamada real: um `query()` avulso, sem ferramentas e de um turno só — o
 *  vigia é um leitor, não um agente do projeto (mesmo molde do visionRelay). */
export async function askVigia(prompt: string, model: string): Promise<string> {
  async function* single(): AsyncIterable<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      parent_tool_use_id: null
    } as SDKUserMessage
  }

  const options: Options = {
    model,
    executable: 'node',
    tools: [],
    maxTurns: 1,
    includePartialMessages: false,
    permissionMode: 'bypassPermissions'
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
