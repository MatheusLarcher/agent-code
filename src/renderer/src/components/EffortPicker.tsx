import { useEffect, useRef, useState } from 'react'
import { AUTO_EFFORT, DEFAULT_EFFORT, EFFORT_LEVELS, isAutoEffort, type EffortLevel } from '@shared/ipc'
import { isEffortLevel } from '@shared/autoEffort'
import { AUTO_EFFORT_LABEL, EFFORT_LABELS, type EffortOption } from '../effortOptions'
import { IconChevronDown, IconHelp } from './Icons'

/** O texto exato da posição Automático (requisito do planejamento). */
export const AUTO_EFFORT_HINT =
  'Automático: o decisor escolhe o esforço a cada mensagem, pela dificuldade do pedido. Mais esforço pensa mais, demora mais e custa mais.'

/** As posições do controle: Automático na ponta esquerda (quando oferecido),
 *  depois os níveis do modelo, do mais rápido ao mais profundo. */
export function effortPositions(levels: readonly EffortOption[], withAuto: boolean): EffortOption[] {
  return withAuto ? [{ value: AUTO_EFFORT, label: AUTO_EFFORT_LABEL }, ...levels] : [...levels]
}

/** O texto curto do botão: "Auto", "Auto · Alto" (o que o decisor escolheu no
 *  último turno) ou o nível fixo. */
export function effortShortLabel(position: EffortOption | undefined, running?: string): string {
  if (!position) return ''
  if (!isAutoEffort(position.value)) return position.label
  return running ? `Auto · ${EFFORT_LABELS[running] ?? running}` : 'Auto'
}

/** A posição de um valor que não está na lista (nível que o modelo não tem):
 *  o mesmo recorte de `clampEffortToModel` no main — o nível mais profundo da
 *  lista que não passa do pedido; texto que nem é nível conta como o padrão.
 *  Nunca o Automático: ele só aparece quando é a escolha. */
export function clampedPosition(positions: readonly EffortOption[], value: string): number {
  const wanted = EFFORT_LEVELS.indexOf(isEffortLevel(value) ? value : DEFAULT_EFFORT)
  let best = -1
  positions.forEach((p, i) => {
    if (isAutoEffort(p.value)) return
    const rank = EFFORT_LEVELS.indexOf(p.value as EffortLevel)
    if (best < 0 || (rank >= 0 && rank <= wanted)) best = i
  })
  return best
}

interface Props {
  /** Níveis concretos do modelo (vazio = o chamador nem renderiza o controle). */
  levels: EffortOption[]
  value: string
  /** TypeSafe configurado: oferece a posição Automático. Sem ele a posição só
   *  aparece se já for o valor gravado — nada troca a escolha salva sozinho. */
  autoAvailable: boolean
  /** O esforço que o decisor escolheu no último turno, com o valor em Automático. */
  running?: string
  locked: boolean
  busy?: boolean
  onChange: (value: string) => void
  onLockedClick?: () => void
}

/**
 * Esforço de raciocínio: um botão compacto ("Esforço Alto" / "Esforço Auto")
 * que abre um painel com um `<input type="range">` nativo — teclado (setas) e
 * leitor de tela de graça; `aria-valuetext` leva o rótulo, não o índice.
 * O mesmo componente serve o chat principal e o Agent Manager.
 */
export function EffortPicker(props: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const sliderRef = useRef<HTMLInputElement>(null)
  const positions = effortPositions(props.levels, props.autoAvailable || isAutoEffort(props.value))
  const found = positions.findIndex((p) => p.value === props.value)
  // Valor fora da lista: recortado ao teto do modelo, como no main.
  const idx = found >= 0 ? found : clampedPosition(positions, props.value)
  const current = positions[Math.max(0, idx)]
  const auto = !!current && isAutoEffort(current.value)
  const shortLabel = effortShortLabel(current, props.running)

  useEffect(() => {
    if (!open) return
    // Abrir leva o foco ao slider: as setas já mexem nele e o Escape fecha.
    sliderRef.current?.focus()
    const close = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div
      className="effort-picker"
      ref={rootRef}
      // Escape fecha com o foco no botão ou no painel e devolve o foco ao botão
      // (o slider some com o painel; sem isso o foco cairia no body).
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return
        e.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`effort-trigger${props.locked ? ' locked' : ''}`}
        // Nome acessível sempre completo, qualquer que seja a largura.
        aria-label={`Esforço: ${shortLabel}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          props.locked
            ? 'Selecione uma conversa para trocar o esforço.'
            : props.busy
              ? 'Muda a partir da próxima mensagem da fila (a tarefa atual continua no esforço atual).'
              : 'Esforço de raciocínio — quanto maior, mais profundo (e mais lento/caro)'
        }
        onClick={() => {
          if (props.locked) {
            props.onLockedClick?.()
            return
          }
          setOpen((v) => !v)
        }}
      >
        <span className="effort-trigger-label">
          <span className="effort-trigger-prefix">Esforço </span>
          {shortLabel}
        </span>
        <IconChevronDown size={12} className="effort-trigger-chevron" />
      </button>
      {open && (
        <div className="effort-popover" role="dialog" aria-label="Esforço de raciocínio">
          <div className="effort-popover-head">
            <span>
              Esforço <strong>{current?.label ?? ''}</strong>
              {auto && props.running && (
                <span className="effort-running"> · em uso: {EFFORT_LABELS[props.running] ?? props.running}</span>
              )}
            </span>
            <span
              className="effort-help"
              title="Controla o quanto o modelo 'pensa' antes de responder: mais esforço tende a ser mais preciso, porém mais lento e mais caro."
            >
              <IconHelp size={14} />
            </span>
          </div>
          <div className="effort-slider-labels">
            <span>Mais rápido</span>
            <span>Mais inteligente</span>
          </div>
          <input
            ref={sliderRef}
            type="range"
            className="effort-slider"
            aria-label="Esforço"
            aria-valuetext={current?.label ?? ''}
            min={0}
            max={Math.max(0, positions.length - 1)}
            step={1}
            value={Math.max(0, idx)}
            onChange={(e) => {
              const next = positions[Number(e.target.value)]
              if (next && next.value !== props.value) props.onChange(next.value)
            }}
          />
          {auto && (
            <p className="effort-auto-hint" role="note">
              {AUTO_EFFORT_HINT}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
