import { askObserver } from '../observerQuery'
import type { ChatEvent, VigiaAlertMsg, VigiaConfig } from '../../shared/ipc'
import { getCacheInfo } from '../store'
import { buildProjectOutline } from '../projectOutline'
import { buildDynamicMemoryContext } from '../memoryIndex'
import {
  alertFingerprint,
  buildVigiaPrompt,
  parseVigiaVerdict,
  summarizeCall,
  VIGIA_CALL_TRIGGER,
  VIGIA_COOLDOWN_MS,
  VIGIA_MAX_CALLS,
  VIGIA_MAX_HISTORY_TURNS,
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
  /** A chamada ao modelo. Injetável para o teste não subir o SDK. O
   *  `convId` faz o vigia rodar na mesma conta Claude da conversa. */
  ask?(prompt: string, model: string, convId: string): Promise<string>
  now?(): number
  /**
   * Memórias do usuário e docs do projeto relevantes ao pedido do turno.
   * Sem injeção (produção), chama `buildProjectOutline`/`buildDynamicMemoryContext`
   * — os mesmos construtores do agente principal. Nunca lança: sem `cwd`, sem
   * dado, ou com a busca falhando, devolve tudo vazio — o vigia só perde a
   * seção extra do digest, nunca quebra por causa disso.
   */
  projectContext?(cwd: string, query: string): Promise<{ memory: string; docs: string }>
}

interface ConvState {
  /** null = nenhum turno do usuário em aberto; sem isso o vigia não roda. */
  userText: string | null
  cwd: string
  calls: VigiaCall[]
  /** Uma análise por turno: marcado ANTES da chamada (que é assíncrona). */
  fired: boolean
  lastRunAt: number
  seen: Set<string>
  /** Um resumo de uma linha por turno anterior, do mais antigo ao mais
   *  recente — a memória de curto prazo do próprio vigia, sem store externo. */
  history: string[]
  /** Se a análise do turno atual já emitiu um alerta — usado só para compor
   *  o resumo desse turno quando o próximo `noteUserMessage` o arquivar. */
  alertedThisTurn: boolean
}

export class Vigia {
  private readonly state = new Map<string, ConvState>()
  private seq = 0

  constructor(private readonly deps: VigiaDeps) {}

  /** Um turno começou. Só a partir daqui há algo para julgar — retomada de
   *  sessão e turno de recuperação não passam por aqui, e é o que se quer. */
  noteUserMessage(convId: string, cwd: string, text: string): void {
    // O cooldown e o dedupe são da CONVERSA, não do turno: precisam sobreviver
    // ao turno novo, senão o mesmo alerta voltaria a cada mensagem.
    const conv = this.conv(convId)
    // Arquiva o turno anterior no histórico ANTES de sobrescrevê-lo — é assim
    // que o vigia acumula contexto turno a turno, sem ler um histórico externo.
    if (conv.userText !== null) {
      conv.history.push(summarizeTurn(conv.userText, conv.alertedThisTurn))
      if (conv.history.length > VIGIA_MAX_HISTORY_TURNS) conv.history.shift()
    }
    conv.userText = text
    conv.cwd = cwd
    conv.calls = []
    conv.fired = false
    conv.alertedThisTurn = false
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
      conv = {
        userText: null,
        cwd: '',
        calls: [],
        fired: false,
        lastRunAt: 0,
        seen: new Set(),
        history: [],
        alertedThisTurn: false
      }
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

    // Tolerância a falha da MESMA injeção, não só do fallback: uma dependência
    // injetada que rejeita não pode derrubar a análise, igual ao `listConvTasks`
    // do PO — o vigia só perde a seção extra do digest.
    let memory = ''
    let docs = ''
    try {
      ;({ memory, docs } = await (this.deps.projectContext ?? defaultProjectContext)(conv.cwd, conv.userText))
    } catch {
      // segue sem contexto extra
    }
    const prompt = buildVigiaPrompt({
      userText: conv.userText,
      calls: conv.calls,
      history: conv.history,
      memory,
      docs
    })
    let raw: string
    try {
      raw = await (this.deps.ask ?? askVigia)(prompt, cfg.model, convId)
    } catch {
      return // degrada em silêncio: o vigia nunca atrapalha a conversa
    }

    const verdict = parseVigiaVerdict(raw)
    if (!verdict) return
    // O dedupe é da PERGUNTA, não das opções: a mesma premissa não resolvida
    // não pode voltar a cada turno só porque os atalhos saíram diferentes.
    const fingerprint = alertFingerprint(verdict.question)
    if (conv.seen.has(fingerprint)) return
    conv.seen.add(fingerprint)
    conv.alertedThisTurn = true

    this.deps.emit({
      convId,
      id: `vigia-${now}-${++this.seq}`,
      text: verdict.question,
      options: verdict.options,
      at: now
    })
  }
}

/** A chamada real é a mesma de todo observador do app (ver observerQuery.ts). */
export const askVigia = askObserver

/** Resumo de uma linha do turno para o histórico interno do vigia. */
function summarizeTurn(userText: string, alerted: boolean): string {
  const pedido = userText.trim().replace(/\s+/g, ' ').slice(0, 200) || '(sem texto)'
  return `"${pedido}"${alerted ? ' (o vigia alertou)' : ''}`
}

/** Fallback de produção: os mesmos construtores que o agente principal usa
 *  para docs/memória (ver `agentSession.ts`), tolerante a falha e sem `cwd`. */
async function defaultProjectContext(
  cwd: string,
  query: string
): Promise<{ memory: string; docs: string }> {
  if (!cwd) return { memory: '', docs: '' }
  try {
    const docsPromise = buildProjectOutline(cwd)
    const memory = buildDynamicMemoryContext(getCacheInfo().memoriesDir, query, false)
    const docs = await docsPromise
    return { memory, docs }
  } catch {
    return { memory: '', docs: '' }
  }
}
