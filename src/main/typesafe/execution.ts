import type { AutoPrompt } from '../../shared/ipc'
import { autoModelLabel, AUTO_EFFORT_LABELS } from './autoCatalog'
import {
  autoExecutionUnprompted,
  chooseAutoExecution,
  type AutoExecution,
  type AutoExecutionOptions,
  type AutoExecutionSource,
  type AutoLiveDefaults,
  type AutoPair
} from './autoDecision'

/**
 * O modo Automático visto de um `agentStart`: o que fazer com a sessão, o que
 * guardar como par vivo e o que contar ao usuário. O vocabulário mora em
 * `autoCatalog.ts` e a decisão por dimensão em `autoDecision.ts`; este módulo
 * reexporta os dois para quem já importava daqui.
 */
export * from './autoCatalog'
export * from './autoDecision'

/**
 * O par no ar MAIS, por dimensão, se alguém de fato o escolheu.
 *
 * A sessão roda no par que estiver aqui, venha ele de onde vier — a mensagem
 * tem de sair. Mas só uma dimensão DECIDIDA pode se defender no turno seguinte
 * (histerese e recuo por confiança baixa). Sem essa distinção, uma queda do
 * TypeSafe num turno fixava o padrão (o modelo mais caro) e todos os turnos
 * seguintes passavam a protegê-lo. É por dimensão porque o fallback também é:
 * um esforço que caiu no padrão não pode virar histerese do esforço só porque
 * o modelo do mesmo turno foi decidido.
 */
export interface AutoLivePair extends AutoPair {
  decided: { model: boolean; effort: boolean }
}

/** O que a conversa em Automático sabe quando vai (re)abrir a sessão. */
export interface AutoStartInput {
  /** O turno que está saindo. Ausente quando ninguém está enviando nada — o
   *  botão Conectar, a reconexão depois de trocar a configuração, a
   *  recuperação de uma sessão perdida. */
  autoPrompt?: AutoPrompt
  /** O par em que a sessão viva desta conversa foi montada, se houver. */
  live?: AutoLivePair
  /** Se a conversa tem sessão viva agora. */
  hasSession: boolean
}

/** O que fazer com a sessão desta conversa, e o que contar ao usuário. */
export interface AutoStartDecision {
  execution: AutoExecution
  /** `true` = a sessão que já está no ar serve para este turno. Só o caminho
   *  COM turno pode reaproveitar: quem religa sem turno está pedindo uma sessão
   *  nova (config trocada, sessão perdida). */
  reuse: boolean
  /** A nota de sistema a mostrar, ou `null` quando não há nada a anunciar. */
  note: string | null
  /** O par a guardar como vivo desta conversa depois deste turno. */
  live: AutoLivePair
}

/** Uma dimensão foi decidida neste turno? `typesafe` sim; `fallback` não — roda
 *  mas não vira histerese. `unprompted` não julgou nada, então PROPAGA o que a
 *  dimensão já era; dimensão fixa (sem origem) não é decisão de ninguém. */
function decidedNow(source: AutoExecutionSource | undefined, previous: boolean | undefined): boolean {
  return source === 'unprompted' ? previous === true : source === 'typesafe'
}

function nextLivePair(execution: AutoExecution, previous?: AutoLivePair): AutoLivePair {
  return {
    model: execution.model,
    ...(execution.effort ? { effort: execution.effort } : {}),
    decided: {
      model: decidedNow(execution.source.model, previous?.decided.model),
      effort: decidedNow(execution.source.effort, previous?.decided.effort)
    }
  }
}

/** O que do par vivo pode se defender: só as dimensões decididas. */
function defendedLive(live?: AutoLivePair): AutoLiveDefaults {
  if (!live) return {}
  return {
    ...(live.decided.model ? { model: live.model } : {}),
    ...(live.decided.effort && live.effort ? { effort: live.effort } : {})
  }
}

/**
 * A decisão inteira de um `agentStart` com alguma dimensão em Automático, sem
 * tocar em Electron — o handler que a usa só faz o IO.
 */
export async function resolveAutoStart(
  input: AutoStartInput,
  options: AutoExecutionOptions = {}
): Promise<AutoStartDecision> {
  const prompt = input.autoPrompt
  if (!prompt?.message.trim()) {
    // Nada foi perguntado, então nada foi decidido e nada é anunciado.
    const execution = autoExecutionUnprompted(input.live, options.models, options.selection)
    return { execution, reuse: false, note: null, live: nextLivePair(execution, input.live) }
  }
  const execution = await chooseAutoExecution(prompt, { ...options, live: defendedLive(input.live) })
  // O reaproveitamento olha o par REAL da sessão viva, decidido ou não: o que se
  // pergunta aqui é se a sessão que existe serve, não de onde ela veio.
  const reuse =
    input.hasSession && input.live?.model === execution.model && input.live.effort === execution.effort
  return { execution, reuse, note: autoExecutionNote(execution), live: nextLivePair(execution, input.live) }
}

/**
 * A frase que a UI mostra, ou `null` quando não há nada a anunciar. Vai num
 * evento `provider-switch`, que o chat e o cliente do celular já renderizam
 * como nota de sistema.
 *
 * Diz o valor de cada dimensão AUTOMÁTICA — e só delas: a fixa foi o usuário
 * quem escolheu. `unprompted` não entra: não houve turno, e dizer "o TypeSafe
 * não respondeu" ali seria afirmar que um serviço no ar está fora.
 */
export function autoExecutionNote(execution: AutoExecution): string | null {
  const announced = (source?: AutoExecutionSource): boolean => source === 'typesafe' || source === 'fallback'
  const showModel = announced(execution.source.model)
  const effort = execution.effort
  const showEffort = announced(execution.source.effort) && effort !== undefined
  if (!showModel && !showEffort) return null

  const parts: string[] = []
  if (showModel) parts.push(autoModelLabel(execution.model))
  if (showEffort && effort) parts.push(`esforço ${AUTO_EFFORT_LABELS[effort]}`)
  const base = `Automático: ${parts.join(', ')}.`

  const modelFallback = showModel && execution.source.model === 'fallback'
  const effortFallback = showEffort && execution.source.effort === 'fallback'
  const which =
    modelFallback && effortFallback
      ? 'par padrão'
      : modelFallback
        ? 'modelo padrão'
        : effortFallback
          ? 'esforço padrão'
          : null
  return which ? `${base} (${which} — o TypeSafe não respondeu a tempo ou está desligado.)` : base
}
