/**
 * O seletor de modelo e de esforço de uma conversa: o `<select>` do modelo e,
 * quando o modelo tem níveis, o EffortPicker ao lado. Quem monta põe dentro da
 * `.composer-bar`. Usado pelo campo de digitar da tela do monitor no Escritório
 * (para a conversa do agente focado); as regras de troca ficam com o App.
 */
import { EffortPicker } from './EffortPicker'

export interface ModelPickerProps {
  models: { id: string; label: string }[]
  model: string
  /** Sem conversa: o seletor fica clicável só para explicar (onModelLockedClick). */
  modelLocked: boolean
  onModelChange: (id: string) => void
  onModelLockedClick: () => void
  /** Os níveis concretos do modelo; vazio (Ollama) esconde o esforço. */
  effortLevels: { value: string; label: string }[]
  effort: string
  effortAutoAvailable?: boolean
  runningEffort?: string
  effortLocked: boolean
  onEffortChange: (level: string) => void
  /** A conversa está trabalhando: a troca vale a partir da próxima mensagem. */
  busy?: boolean
}

export function ModelPicker(props: ModelPickerProps): JSX.Element {
  return (
    <>
      <select
        className={`model-select${props.modelLocked ? ' locked' : ''}`}
        value={props.model}
        aria-label="Modelo"
        aria-disabled={props.modelLocked}
        title={
          props.modelLocked
            ? 'Selecione uma conversa para trocar o modelo.'
            : props.busy
              ? 'Muda a partir da próxima mensagem da fila (a tarefa atual continua no modelo atual).'
              : 'Modelo usado nesta conversa'
        }
        onMouseDown={(e) => {
          if (props.modelLocked) {
            e.preventDefault()
            e.currentTarget.blur()
            props.onModelLockedClick()
          }
        }}
        onKeyDown={(e) => {
          if (props.modelLocked) {
            e.preventDefault()
            props.onModelLockedClick()
          }
        }}
        onChange={(e) => {
          if (!props.modelLocked) props.onModelChange(e.target.value)
        }}
      >
        {props.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      {props.effortLevels.length > 0 && (
        <EffortPicker
          levels={props.effortLevels}
          value={props.effort}
          autoAvailable={props.effortAutoAvailable === true}
          running={props.runningEffort}
          locked={props.effortLocked}
          busy={props.busy}
          onChange={props.onEffortChange}
        />
      )}
    </>
  )
}
