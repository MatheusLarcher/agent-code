/**
 * O seletor de modelo e de esforço de uma conversa: o ModelSelect do modelo e,
 * quando o modelo tem níveis, o EffortPicker ao lado. Quem monta põe dentro da
 * `.composer-bar`. Usado pelo campo de digitar da tela do monitor no Escritório
 * (para a conversa do agente focado); as regras de troca ficam com o App.
 */
import { EffortPicker } from './EffortPicker'
import { ModelSelect } from './ModelSelect'

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
      <ModelSelect
        models={props.models}
        value={props.model}
        locked={props.modelLocked}
        tip={
          props.modelLocked
            ? 'Selecione uma conversa para trocar o modelo.'
            : props.busy
              ? 'Muda a partir da próxima mensagem da fila (a tarefa atual continua no modelo atual).'
              : 'Modelo usado nesta conversa'
        }
        onChange={props.onModelChange}
        onLockedClick={props.onModelLockedClick}
      />
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
