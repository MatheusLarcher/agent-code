import type { TarefaVista } from '@shared/tarefas'
import { IconAlarm, IconBell, IconChevronDown, IconClose, IconPause, IconPlay, IconTask, IconTrash } from '../Icons'
import { comboDaTarefa, horaDaRodada, metaDaTarefa, statusDaRodada, textoDaRodada, visualDaTarefa, type TarefaVisual } from './tarefasTexto'

function IconeDaTarefa({ visual }: { visual: TarefaVisual }): JSX.Element {
  if (visual === 'hit') return <IconBell />
  if (visual === 'rem') return <IconAlarm />
  if (visual === 'paused') return <IconPause />
  return <IconTask />
}

/**
 * Uma tarefa no popover da bolinha. Monitor: abre para mostrar as últimas
 * rodadas, o combinado, Pausar/Retomar e Cancelar. Lembrete: só o X de cancelar.
 */
export function TarefaItem({
  t,
  aberta,
  ocupada,
  agora,
  onAlternar,
  onPausar,
  onCancelar
}: {
  t: TarefaVista
  aberta: boolean
  /** Uma ação desta tarefa em curso: os botões ficam desligados. */
  ocupada: boolean
  agora: number
  onAlternar: () => void
  onPausar: () => void
  onCancelar: () => void
}): JSX.Element {
  const visual = visualDaTarefa(t)
  const meta = metaDaTarefa(t, agora)
  const lembrete = t.tipo === 'lembrete'
  const dica = t.condicao ? `${t.titulo} — ${t.condicao}` : t.titulo
  const linha = (
    <>
      <span className={`tico ${visual}`}>
        <IconeDaTarefa visual={visual} />
      </span>
      <span className="tcopy">
        <span className="ttitle" data-tip={dica}>{t.titulo}</span>
        <span className="tmeta">
          {meta.ok && <span className="ok">{meta.ok}</span>}
          {meta.texto}
          {meta.valor && <span className="val">{meta.valor}</span>}
        </span>
      </span>
    </>
  )
  if (lembrete) {
    return (
      <div className="titem">
        <div className="trow">
          {linha}
          <button type="button" className="tbtn" data-tip="Cancelar lembrete" aria-label="Cancelar lembrete" disabled={ocupada} onClick={onCancelar}>
            <IconClose size={13} />
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className={`titem${aberta ? ' open' : ''}`}>
      <button type="button" className="trow" aria-expanded={aberta} onClick={onAlternar}>
        {linha}
        <IconChevronDown className="chev" />
      </button>
      {aberta && (
        <div className="tbody">
          {t.rodadas.length ? (
            <ul className="runs">
              {t.rodadas.map((r) => (
                <li key={r.id}>
                  <span className="h">{horaDaRodada(r, agora)}</span>
                  <span className={`st ${statusDaRodada(r)}`} />
                  <span className="rtxt">
                    {textoDaRodada(r)}
                    {r.fonte && /^https?:\/\//i.test(r.fonte) && (
                      <>
                        {' '}
                        <a href={r.fonte} target="_blank" rel="noreferrer">fonte</a>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="runs-vazio">Ainda não checou.</div>
          )}
          <div className="combo">{comboDaTarefa(t, agora)}</div>
          <div className="acts">
            <button type="button" className="tbtn" disabled={ocupada} onClick={onPausar}>
              {t.estado === 'pausada' ? <IconPlay size={13} /> : <IconPause size={13} />}
              {t.estado === 'pausada' ? 'Retomar' : 'Pausar'}
            </button>
            <button type="button" className="tbtn danger" disabled={ocupada} onClick={onCancelar}>
              <IconTrash size={13} />
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
