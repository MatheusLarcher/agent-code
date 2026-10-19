import type { ChatEvent } from '../../../shared/ipc'
import { IconBell } from './Icons'
import './tarefas/tarefas.css'

type TarefaAviso = Extract<ChatEvent, { kind: 'tarefa-aviso' }>

const isUrl = (s: string | null): s is string => !!s && /^https?:\/\//i.test(s)

/** A linha compacta que entra na conversa quando um monitor agendado bate (main/tarefas). */
export function TarefaAvisoNote({ m }: { m: TarefaAviso }): JSX.Element {
  return (
    <div className="msg system-note chat-chips tarefa-aviso">
      <span className="chat-chip tarefa-aviso-chip" role="status" title={m.resumo ?? undefined}>
        <IconBell size={13} />
        <b>
          {m.titulo} · bateu às {m.hora}
        </b>
        {m.valor && <span className="tarefa-aviso-valor">{m.valor}</span>}
        {isUrl(m.fonte) && (
          <a href={m.fonte} target="_blank" rel="noreferrer">
            fonte
          </a>
        )}
      </span>
    </div>
  )
}
