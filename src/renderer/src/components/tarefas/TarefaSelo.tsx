import type { TarefaResumoConversa } from '@shared/tarefas'
import { IconAlarm, IconBell, IconPause, IconTask } from '../Icons'
import { dicaDoResumo, iconeDoResumo } from './tarefasTexto'
import './tarefas.css'

/**
 * O selo de tarefas na lista de conversas (PC e celular): ícone + número; ponto
 * pulsando enquanto checa; sino verde quando bateu e ainda não foi visto.
 */
export function TarefaSelo({ resumo }: { resumo: TarefaResumoConversa | null | undefined }): JSX.Element | null {
  if (!resumo) return null
  const icone = iconeDoResumo(resumo)
  const cls = ['tselo', resumo.estado === 'bateu' ? 'hit' : '', resumo.estado === 'lembrete' ? 'rem' : '', resumo.estado === 'pausado' ? 'paused' : '']
  return (
    <span className={cls.filter(Boolean).join(' ')} data-tip={dicaDoResumo(resumo)} aria-label={dicaDoResumo(resumo)}>
      {icone === 'bell' ? <IconBell size={12} /> : icone === 'alarm' ? <IconAlarm size={12} /> : icone === 'pause' ? <IconPause size={12} /> : <IconTask size={12} />}
      {resumo.total}
      {resumo.rodando && <span className="live" />}
    </span>
  )
}
