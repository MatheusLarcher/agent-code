// A cola do suporte remoto no processo principal: os canais que a tela usa (ajustes,
// estado, conectar, encerrar) e as duas regras da config — a chave da equipe nunca vai à
// tela, e os ajustes do suporte só mudam por aqui, validados.
import type { IpcMain } from 'electron'
import { Channels, type AppConfig } from '../../shared/ipc'
import {
  SUPORTE_AJUSTES_LIMITES,
  chaveSuporteValida,
  type SuporteAjustes,
  type SuporteAjustesPatch
} from '../../shared/suporteRemoto'
import { ajustesDoSuporte, suporteRemoto } from './runtime'

const CAMPOS = ['suporteRemotoEnabled', 'suporteRemotoTecnico', 'suporteRemotoChave'] as const

/** A config como a tela recebe: sem a chave da equipe. */
export function configParaATela(config: AppConfig): AppConfig {
  return config.suporteRemotoChave ? { ...config, suporteRemotoChave: '' } : config
}

/** Patch genérico vindo da tela (`config:set`): os campos do suporte são ignorados. */
export function patchSemSuporte<T>(patch: T): T {
  if (!patch || typeof patch !== 'object') return patch
  const limpo = { ...patch } as Record<string, unknown>
  for (const campo of CAMPOS) delete limpo[campo]
  return limpo as T
}

export type ResultadoPatch = { ok: true; patch: Partial<AppConfig> } | { ok: false; mensagem: string }

/** Valida o que a tela mandou e monta o patch de config. Nada entra sem passar aqui. */
export function patchDosAjustes(atual: SuporteAjustes, bruto: unknown): ResultadoPatch {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return { ok: false, mensagem: 'Ajustes inválidos.' }
  const pedido = bruto as SuporteAjustesPatch
  const patch: Partial<AppConfig> = {}
  let temChave = atual.temChave

  if (pedido.tecnico !== undefined) {
    if (typeof pedido.tecnico !== 'string') return { ok: false, mensagem: 'Nome inválido.' }
    // Vai à janela do cliente: só texto visível, sem quebra de linha nem caractere de controle.
    const nome = pedido.tecnico.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    if (nome.length > SUPORTE_AJUSTES_LIMITES.tecnicoMax) {
      return { ok: false, mensagem: `O nome tem no máximo ${SUPORTE_AJUSTES_LIMITES.tecnicoMax} caracteres.` }
    }
    patch.suporteRemotoTecnico = nome
  }

  if (pedido.chave !== undefined) {
    if (typeof pedido.chave !== 'string') return { ok: false, mensagem: 'Chave inválida.' }
    const chave = pedido.chave.trim()
    if (chave && !chaveSuporteValida(chave)) {
      return {
        ok: false,
        mensagem: `A chave da equipe tem de ${SUPORTE_AJUSTES_LIMITES.chaveMin} a ${SUPORTE_AJUSTES_LIMITES.chaveMax} caracteres, sem espaços. Copie a chave inteira.`
      }
    }
    patch.suporteRemotoChave = chave
    temChave = Boolean(chave)
    // Sem chave não há suporte: apagar a chave desliga o recurso.
    if (!chave) patch.suporteRemotoEnabled = false
  }

  if (pedido.ativado !== undefined) {
    if (typeof pedido.ativado !== 'boolean') return { ok: false, mensagem: 'Ajustes inválidos.' }
    if (pedido.ativado && !temChave) return { ok: false, mensagem: 'Cole a chave da equipe antes de ativar o suporte remoto.' }
    patch.suporteRemotoEnabled = pedido.ativado
  }

  if (Object.keys(patch).length === 0) return { ok: false, mensagem: 'Nada para salvar.' }
  return { ok: true, patch }
}

export interface CanaisDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Manda um aviso à janela (`send` do main). */
  enviar: (canal: string, dados: unknown) => void
  /** Grava a config (o `updateAppConfig` do main). */
  salvar: (patch: Partial<AppConfig>) => Promise<unknown>
  /** Espera a config terminar de carregar (o `ensureConfigLoaded` do main). */
  carregar: () => Promise<void>
}

export interface CanaisDoSuporte {
  /** A conversa dona da sessão foi apagada: a sessão acaba junto. */
  conversaApagada(convId: string): void
  /** O app está fechando: o cliente vê "encerrado" em vez de esperar o tempo esgotar. */
  fechar(): void
}

const texto = (valor: unknown, max: number): string | null => (typeof valor === 'string' && valor.length > 0 && valor.length <= max ? valor : null)

export function registrarCanaisDoSuporte(deps: CanaisDeps): CanaisDoSuporte {
  const servico = suporteRemoto()
  servico.onChange((status) => deps.enviar(Channels.suporteStatusMudou, status))

  deps.ipcMain.handle(Channels.suporteAjustes, async () => {
    await deps.carregar()
    return ajustesDoSuporte()
  })

  deps.ipcMain.handle(Channels.suporteSalvarAjustes, async (_e, bruto: unknown) => {
    await deps.carregar()
    const resultado = patchDosAjustes(ajustesDoSuporte(), bruto)
    if (!resultado.ok) return { ok: false, mensagem: resultado.mensagem }
    await deps.salvar(resultado.patch)
    const ajustes = ajustesDoSuporte()
    deps.enviar(Channels.suporteAjustesMudou, ajustes)
    // Desligou (ou ficou sem chave): a sessão aberta acaba e as conversas perdem as ferramentas.
    await servico.ajustesMudaram()
    return { ok: true, ajustes }
  })

  deps.ipcMain.handle(Channels.suporteStatus, () => servico.status())

  deps.ipcMain.handle(Channels.suporteConectar, async (_e, convId: unknown, codigo: unknown) => {
    const conversa = texto(convId, 200)
    const digitado = texto(codigo, 40)
    if (!conversa || !digitado) return { ok: false, mensagem: 'Digite o código de 9 dígitos que o cliente leu.' }
    await deps.carregar()
    const resultado = await servico.conectar(conversa, digitado)
    if (resultado.ok) return { ok: true }
    // O cliente recusou: isso já virou aviso do estado, e a tela mostra em toast.
    const aviso = servico.status().aviso
    const avisado = aviso?.tipo === 'recusado' && aviso.texto === resultado.mensagem
    return { ok: false, mensagem: resultado.mensagem, ...(avisado ? { avisado: true } : {}) }
  })

  deps.ipcMain.handle(Channels.suporteDesconectar, async () => {
    await servico.desconectar()
    return true
  })

  return {
    conversaApagada: (convId) => {
      if (servico.status().convId === convId) void servico.desconectar()
    },
    fechar: () => void servico.desconectar()
  }
}
