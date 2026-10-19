import { dataHoraTexto, frequenciaTexto, type TarefaResumoConversa, type TarefaRodada, type TarefaVista } from '@shared/tarefas'

/** A cara de cada tarefa na lista (o quadradinho do ícone). */
export type TarefaVisual = 'paused' | 'run' | 'hit' | 'rem' | 'task'

export function visualDaTarefa(t: TarefaVista): TarefaVisual {
  if (t.estado === 'pausada') return 'paused'
  if (t.rodando) return 'run'
  if (t.ultimoResultado === 'bateu') return 'hit'
  if (t.tipo === 'lembrete') return 'rem'
  return 'task'
}

/** O ícone da bolinha e do selo pelo estado da conversa. */
export type IconeResumo = 'bell' | 'alarm' | 'pause' | 'task'

export function iconeDoResumo(r: TarefaResumoConversa): IconeResumo {
  if (r.estado === 'bateu') return 'bell'
  if (r.estado === 'lembrete') return 'alarm'
  if (r.estado === 'pausado') return 'pause'
  return 'task'
}

/** As classes da bolinha: coral (esperando), arco girando, verde, âmbar, cinza. */
export function classesDaBolinha(r: TarefaResumoConversa): string {
  const c = ['tdot']
  if (r.estado === 'bateu') c.push('hit')
  if (r.rodando) c.push('run')
  if (r.estado === 'lembrete') c.push('rem')
  if (r.estado === 'pausado') c.push('paused')
  return c.join(' ')
}

export function dicaDoResumo(r: TarefaResumoConversa): string {
  const partes = [r.total === 1 ? '1 tarefa' : `${r.total} tarefas`]
  if (r.bateuNaoVisto) partes.push('bateu')
  if (r.rodando) partes.push('checando agora')
  else if (r.estado === 'pausado') partes.push('tudo pausado')
  else if (r.estado === 'lembrete') partes.push('só lembrete')
  return partes.join(' · ')
}

/** "em 5 min", "em 18 h 40 min", "em 3 dias". */
export function faltaTexto(ms: number, agora: number): string {
  const min = Math.round((ms - agora) / 60_000)
  if (min <= 0) return 'agora'
  if (min < 60) return `em ${min} min`
  if (min < 24 * 60) {
    const h = Math.floor(min / 60)
    const m = min % 60
    return m ? `em ${h} h ${m} min` : `em ${h} h`
  }
  const d = Math.round(min / (24 * 60))
  return d === 1 ? 'em 1 dia' : `em ${d} dias`
}

function msOf(iso: string | null): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** "Haiku", "Sonnet", "Opus" ou o id cru. */
export function nomeDoModelo(modelo: string | null): string {
  if (!modelo) return 'Haiku'
  for (const nome of ['haiku', 'sonnet', 'opus', 'fable']) {
    if (modelo.toLowerCase().includes(nome)) return nome[0].toUpperCase() + nome.slice(1)
  }
  return modelo
}

/** A linha de baixo do título: o que aconteceu por último e de quanto em quanto. */
export interface MetaPartes {
  /** Trecho destacado em verde (bateu). */
  ok?: string
  texto: string
  /** Valor em destaque no fim ("último R$ 455"). */
  valor?: string
}

export function metaDaTarefa(t: TarefaVista, agora: number): MetaPartes {
  const freq = frequenciaTexto(t.agenda)
  const proxima = msOf(t.proximaEm)
  if (t.estado === 'pausada') return { texto: `pausada · ${freq}` }
  if (t.tipo === 'lembrete') {
    if (proxima === null) return { texto: freq }
    const quando = dataHoraTexto(proxima, agora)
    return { texto: t.agenda.tipo === 'uma-vez' ? `${quando} · ${faltaTexto(proxima, agora)}` : `${freq} · próxima ${quando}` }
  }
  if (t.rodando) return t.ultimoValor ? { texto: `checando agora · ${freq} · último `, valor: t.ultimoValor } : { texto: `checando agora · ${freq}` }
  const ultima = msOf(t.ultimaEm)
  if (t.ultimoResultado === 'bateu') {
    const hora = ultima === null ? '' : ` às ${dataHoraTexto(ultima, agora)}`
    return { ok: `Bateu${t.ultimoValor ? `: ${t.ultimoValor}` : ''}${hora}`, texto: ` · ${freq}` }
  }
  if (t.ultimoResultado === 'precisa-de-voce') return { texto: `precisa de você · ${freq}` }
  if (t.ultimoResultado === 'falha') return { texto: `falhou ${t.falhasSeguidas}x · ${freq}` }
  const prox = proxima === null ? '' : ` · próxima ${dataHoraTexto(proxima, agora)}`
  if (t.ultimoValor) return { texto: `${freq}${prox} · último `, valor: t.ultimoValor }
  return { texto: `${freq}${prox}` }
}

/** A bolinha de status de cada rodada: ok (verde), no (vazada), err (vermelha). */
export function statusDaRodada(r: TarefaRodada): 'ok' | 'no' | 'err' {
  if (r.resultado === 'bateu' || r.resultado === 'disparado') return 'ok'
  if (r.resultado === 'falha' || r.resultado === 'precisa-de-voce') return 'err'
  return 'no'
}

export function textoDaRodada(r: TarefaRodada): string {
  const detalhe = [r.valor, r.resumo].filter((s): s is string => !!s?.trim()).join(' — ')
  switch (r.resultado) {
    case 'bateu':
      return detalhe ? `${detalhe} — bateu` : 'bateu'
    case 'falha':
      return `falhou: ${r.falha ?? 'sem detalhe'}`
    case 'pulada':
      return `pulada: ${r.falha ?? 'a anterior ainda rodava'}`
    case 'precisa-de-voce':
      return `precisa de você${detalhe ? `: ${detalhe}` : ''}`
    case 'disparado':
      return 'lembrete disparado'
    default:
      return detalhe || 'não bateu'
  }
}

/** A hora em que a checagem terminou (a mesma do "Bateu às"); sem fim, a do início. */
export function horaDaRodada(r: TarefaRodada, agora: number): string {
  const ms = msOf(r.fim) ?? msOf(r.inicio)
  return ms === null ? '' : dataHoraTexto(ms, agora)
}

/** "Próxima 14:20 · modelo Haiku · combinado: …". */
export function comboDaTarefa(t: TarefaVista, agora: number): string {
  const partes: string[] = []
  const proxima = msOf(t.proximaEm)
  if (t.estado === 'pausada') partes.push('Pausada')
  else if (proxima !== null) partes.push(`Próxima ${dataHoraTexto(proxima, agora)}`)
  partes.push(`modelo ${nomeDoModelo(t.modelo)}`)
  partes.push(`combinado: ${t.combinado?.trim() || 'só pesquisar e ler (o padrão)'}`)
  return partes.join(' · ')
}
