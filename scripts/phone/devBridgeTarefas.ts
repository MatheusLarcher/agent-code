/**
 * Tarefas de exemplo da ponte de teste do celular (ver devBridge.ts): os mesmos
 * casos do mockup (monitor que bateu, monitor checando, lembrete) na conversa c1,
 * e o handler de `tarefasAcao` que o celular chama pelo POST /api/ipc.
 */
import { AppIpcBridge } from '../../src/main/remote/appIpcBridge'
import { Channels } from '../../src/shared/ipc'
import { tarefaVisivel, validarTarefaAcao, type TarefaRodada, type TarefaVista } from '../../src/shared/tarefas'

const MIN = 60_000

function rodada(tarefaId: string, atrasMin: number, over: Partial<TarefaRodada>): TarefaRodada {
  const inicio = new Date(Date.now() - atrasMin * MIN).toISOString()
  return { id: `${tarefaId}-${atrasMin}`, tarefaId, inicio, fim: inicio, resultado: 'nao-bateu', valor: null, resumo: null, fonte: null, falha: null, instalacao: 'dev', ...over }
}

function base(over: Partial<TarefaVista> & Pick<TarefaVista, 'id' | 'tipo' | 'titulo' | 'agenda'>): TarefaVista {
  const agora = new Date().toISOString()
  return {
    mensagem: null, convId: 'c1', cwd: 'C:/dev', estado: 'ativa', modelo: 'claude-haiku-5-5', condicao: null, combinado: null,
    criadaPor: 'dev', criadaEm: agora, atualizadaEm: agora, proximaEm: null, ultimaEm: null, ultimoResultado: null, ultimoValor: null,
    avisadoValor: null, falhasSeguidas: 0, bateuNaoVistoEm: null, rodando: false, rodadas: [], ...over
  }
}

export function tarefasDeExemplo(): TarefaVista[] {
  const agora = Date.now()
  return [
    base({
      id: 't-passagem', tipo: 'monitor', titulo: 'Passagem RJ → Lisboa < R$ 3.000', agenda: { tipo: 'intervalo', intervaloMin: 10 },
      condicao: 'ida e volta em março abaixo de R$ 3.000', combinado: 'só pesquisa na web; avisa de novo só se cair mais',
      proximaEm: new Date(agora + 10 * MIN).toISOString(), ultimaEm: new Date(agora - 5 * MIN).toISOString(),
      ultimoResultado: 'bateu', ultimoValor: 'R$ 2.890', avisadoValor: 'R$ 2.890', bateuNaoVistoEm: new Date(agora - 5 * MIN).toISOString(),
      rodadas: [
        rodada('t-passagem', 5, { resultado: 'bateu', valor: 'R$ 2.890', resumo: 'GIG → LIS, TAP, 1 parada', fonte: 'https://www.google.com/travel/flights' }),
        rodada('t-passagem', 15, { valor: 'R$ 3.180' }),
        rodada('t-passagem', 25, { valor: 'R$ 3.240' }),
        rodada('t-passagem', 35, { resultado: 'falha', falha: 'captcha no Skyscanner' })
      ]
    }),
    base({
      id: 't-hotel', tipo: 'monitor', titulo: 'Hotel em Lisboa < R$ 400/noite', agenda: { tipo: 'diario', hora: '09:00' },
      condicao: 'diária abaixo de R$ 400', rodando: true, ultimoResultado: 'nao-bateu', ultimoValor: 'R$ 455',
      proximaEm: new Date(agora + 20 * 60 * MIN).toISOString()
    }),
    base({
      id: 't-passaporte', tipo: 'lembrete', titulo: 'Lembrete: renovar o passaporte', mensagem: 'Renovar o passaporte',
      agenda: { tipo: 'uma-vez', quando: new Date(agora + (18 * 60 + 40) * MIN).toISOString() }, modelo: null,
      proximaEm: new Date(agora + (18 * 60 + 40) * MIN).toISOString()
    })
  ]
}

/** As tarefas da ponte e o handler das ações (pausar/retomar/cancelar/visto). */
export function tarefasDaPonte(note: (kind: string, data: unknown) => void, publicar: () => void): {
  lista: () => TarefaVista[]
  semear: () => void
  limpar: () => void
  appIpc: AppIpcBridge
} {
  let tarefas = tarefasDeExemplo()
  const appIpc = new AppIpcBridge(() => undefined)
  appIpc.handle(Channels.tarefasAcao, (_e, raw) => {
    note('tarefa-acao', raw)
    const p = validarTarefaAcao(raw)
    if (!p.ok) return p
    const t = tarefas.find((x) => x.id === p.valor.id)
    if (!t) return { ok: false, erro: `não existe tarefa ativa ou pausada com id ${p.valor.id}` }
    const agora = new Date().toISOString()
    if (p.valor.acao === 'visto') t.bateuNaoVistoEm = null
    else if (p.valor.acao === 'pausar') Object.assign(t, { estado: 'pausada', rodando: false, atualizadaEm: agora })
    else if (p.valor.acao === 'retomar') Object.assign(t, { estado: 'ativa', atualizadaEm: agora })
    else Object.assign(t, { estado: 'cancelada', rodando: false, proximaEm: null, atualizadaEm: agora })
    tarefas = tarefas.filter(tarefaVisivel).map((x) => ({ ...x }))
    publicar()
    return { ok: true, valor: tarefas.find((x) => x.id === p.valor.id) ?? null }
  })
  return {
    lista: () => tarefas,
    semear: () => (tarefas = tarefasDeExemplo()),
    limpar: () => (tarefas = []),
    appIpc
  }
}
