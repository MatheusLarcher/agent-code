/**
 * Uma resposta do agente no celular, no chat resumido (o mesmo agrupamento do PC:
 * @renderer/components/chatSteps): o texto (MessageItem de sempre) e, embaixo, a
 * linha-resumo das ferramentas daquela resposta, recolhida — o toque abre ali uma
 * linha por ação (ToolLine) e o pensamento. `ActLine` também serve aos passos da
 * Central (com spinner e "agora: …"; no chat isso fica na linha ao vivo do trilho).
 */
import { memo, useMemo, type ReactNode } from 'react'
import type { CentralActivity } from '@shared/central'
import { sameStep, stepActivity, stepFallback, stepHasLine, type ChatStep } from '@renderer/components/chatSteps'
import type { CardRefResolver } from '@renderer/components/Markdown'
import { useStepOpen } from '@renderer/components/useStepOpen'
import type { ChatMsg } from '../core/types'
import { Icon } from '../ui/icons'
import { MessageItem } from './MessageItem'
import { CountUp } from './motion'
import { ToolLine } from './ToolLine'

export interface ActLineProps {
  activity: Partial<CentralActivity> | undefined
  running: boolean
  open: boolean
  onToggle: () => void
  /** O texto quando o resumo vem vazio (só bastidor ou só pensamento). */
  fallback?: string
  /** Conteúdo novo (não histórico): a contagem conta até o valor (CountUp). */
  animate?: boolean
  /**
   * No chat o "o que faz agora" fica só na linha ao vivo do trilho: sem spinner nem
   * "agora: …" aqui, o chevron de sempre. A Central (padrão) mantém os dois.
   */
  quiet?: boolean
}

/** Terminada: ▸ + resumo + contagem. Rodando: spinner (na cor `--c`), o resumo até ali e "agora: …" (fora do modo `quiet`). */
export function ActLine({ activity: a, running, open, onToggle, fallback = '', animate = false, quiet = false }: ActLineProps): JSX.Element {
  const nodes: ReactNode[] = (Array.isArray(a?.segments) ? a.segments : []).map((s, i) => {
    if (s?.tone === 'strong') return <b key={i}>{s.text}</b>
    const tone = s?.tone
    const cls = tone === 'add' || tone === 'ok' ? 'c-ok' : tone === 'rem' || tone === 'bad' ? 'c-bad' : ''
    return <span key={i} className={cls}>{s?.text}</span>
  })
  if (running && a?.now && !quiet) nodes.push(<span key="now">{(nodes.length ? ' · ' : '') + 'agora: ' + a.now}</span>)
  const count = a?.count || 0
  const spin = running && !quiet
  return (
    <button type="button" className={`c-act${open ? ' open' : ''}${running ? ' running' : ''}`} title={a?.text} aria-expanded={open} onClick={onToggle}>
      {spin ? <span className="c-spin" /> : <Icon name="chevron" size={12} className="c-chev" />}
      <span className="c-sum">{nodes.length ? nodes : fallback || (spin ? 'trabalhando…' : `${count} ${count === 1 ? 'ação' : 'ações'}`)}</span>
      {count > 0 && !(quiet && !nodes.length && fallback) && <span className="c-count">{animate ? <CountUp value={count} /> : count}</span>}
    </button>
  )
}

interface StepItemProps {
  step: ChatStep<ChatMsg>
  flash: string | null
  voiceReady: boolean
  speakingId: string | null
  onSpeak: (id: string, text: string) => void
  /** [[Nome]] de card na cor do tipo (só o chat do Agent Manager). */
  resolveRef?: CardRefResolver | null
  /** Chegou agora (não é histórico): texto palavra a palavra, contagem que conta. */
  fresh?: boolean
}

function StepLine({ step, voiceReady, speakingId, onSpeak, resolveRef, fresh }: StepItemProps): JSX.Element {
  const [open, toggle] = useStepOpen(step.id)
  const activity = useMemo(() => stepActivity(step), [step])
  // Sem o "agora" (ele fica na linha ao vivo): rodando sem nada pronto, "usou 1 ferramenta".
  const fallback = stepFallback({ segments: activity.segments, now: undefined }, step.tools.length, step.items.length - step.tools.length)
  return (
    <>
      <ActLine activity={activity} running={step.running} open={open} onToggle={toggle} fallback={fallback} animate={fresh} quiet />
      {open && (
        <div className="c-tools">
          {step.items.map((m, i) =>
            m.kind === 'tool-use' ? (
              <ToolLine key={m.id ?? `i${i}`} m={m} />
            ) : (
              <MessageItem key={m.id ?? `i${i}`} m={m} flash={false} voiceReady={voiceReady} speakingId={speakingId} onSpeak={onSpeak} resolveRef={resolveRef} />
            )
          )}
        </div>
      )}
    </>
  )
}

export const StepItem = memo(
  function StepItem(props: StepItemProps): JSX.Element {
    const { step, flash, voiceReady, speakingId, onSpeak, resolveRef, fresh } = props
    const text = step.text
    return (
      <div className={`chat-step${step.final ? ' final' : ''}`}>
        {text && (
          <MessageItem m={text} flash={flash !== null && text.id === flash} voiceReady={voiceReady} speakingId={speakingId} onSpeak={onSpeak} resolveRef={resolveRef} fresh={fresh} />
        )}
        {stepHasLine(step) && <StepLine {...props} />}
      </div>
    )
  },
  (a, b) =>
    sameStep(a.step, b.step) &&
    a.voiceReady === b.voiceReady &&
    a.speakingId === b.speakingId &&
    a.onSpeak === b.onSpeak &&
    a.flash === b.flash &&
    a.resolveRef === b.resolveRef &&
    a.fresh === b.fresh
)
