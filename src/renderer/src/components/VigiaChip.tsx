import { useRef, useState, useEffect } from 'react'

/**
 * A dúvida do vigia, entre o histórico e o composer.
 *
 * O fluxo é: ele pergunta **para o usuário**, o usuário responde **aqui**, e a
 * resposta segue para o agente pelo caminho normal de envio — com o turno em
 * andamento, ela entra na fila e é entregue na próxima chamada ao modelo. Nada
 * é interrompido, e o agente não decide nada sobre isso.
 *
 * Responder tem dois caminhos, como no `AskUserQuestion` do agente: clicar uma
 * das respostas prováveis, ou digitar a sua. O texto é o caminho que sempre
 * existe — perguntas de resposta aberta (uma medida, um nome) chegam sem opção
 * nenhuma de propósito, porque ali uma lista inventada enviesaria a resposta.
 *
 * Nasce **aberto**, com o campo focado: é uma pergunta ao usuário, não um
 * aviso que ele precisa ir buscar. Mas não é modal — dá para ignorar e seguir
 * digitando no composer normalmente.
 */
/** A dúvida pendente de uma conversa, do jeito que a tela precisa dela. */
export interface VigiaDoubt {
  question: string
  /** Respostas prováveis (2–4). Vazio = só o campo de texto. */
  options: string[]
}

export function VigiaChip(props: {
  question: string
  /** Respostas prováveis (2–4). Vazio = só o campo de texto. */
  options?: string[]
  onDismiss: () => void
  onAnswer: (answer: string) => void
}): JSX.Element {
  const [answer, setAnswer] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const options = props.options ?? []

  // Foca uma vez, quando a dúvida chega. A dependência é a pergunta (e não o
  // montar), para uma dúvida nova reaproveitando o componente também focar —
  // e é ela que zera a escolha anterior, que não vale para a pergunta nova.
  useEffect(() => {
    setAnswer('')
    setPicked(null)
    ref.current?.focus()
  }, [props.question])

  // Uma resposta só: digitar abandona a opção escolhida, e escolher abandona o
  // que estava digitado. Sem isso, "Responder" teria duas respostas e nenhuma
  // regra óbvia sobre qual vale.
  const resolved = picked ?? answer.trim()

  const send = (text: string): void => {
    if (!text) return
    props.onAnswer(text)
  }

  return (
    <div className="vigia-card" role="status">
      <div className="vigia-card-head">
        <span className="vigia-mark" aria-hidden="true">?</span>
        <span className="vigia-card-title">O vigia tem uma dúvida</span>
      </div>
      <p className="vigia-card-text">{props.question}</p>
      {options.length > 0 && (
        <div className="vigia-options" role="group" aria-label="Respostas prováveis">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className={`vigia-option${picked === option ? ' picked' : ''}`}
              aria-pressed={picked === option}
              onClick={() => {
                setPicked((cur) => (cur === option ? null : option))
                setAnswer('')
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        className="vigia-answer"
        rows={2}
        value={answer}
        placeholder={
          options.length > 0
            ? 'Ou digite outra resposta — vai para o agente sem interromper o trabalho'
            : 'Responda aqui — vai para o agente sem interromper o que ele está fazendo'
        }
        onChange={(e) => {
          setAnswer(e.target.value)
          if (e.target.value) setPicked(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send(resolved)
          }
        }}
      />
      <div className="vigia-card-actions">
        <button type="button" className="vigia-btn" onClick={props.onDismiss}>
          Dispensar
        </button>
        <button
          type="button"
          className="vigia-btn primary"
          onClick={() => send(resolved)}
          disabled={!resolved}
        >
          Responder
        </button>
      </div>
    </div>
  )
}
