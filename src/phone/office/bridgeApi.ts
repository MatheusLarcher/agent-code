/**
 * O pedaço do `window.api` (preload do PC) que o escritório compartilhado usa,
 * no celular servido pela ponte. O código do PC confere cada função antes de
 * chamar; o que não está aqui fica sem (o painel que depende dele some ou cai no
 * que já tem):
 *
 *   officeAgentFile  modelos/animações do motor (`/api/office-agent`)
 *   downloadFile     "Baixar" do cartão de ferramenta e do chat (`/api/file`,
 *                    o mesmo download dos arquivos entregues do chat do celular)
 *
 * Sem `readFile`: o `/api/file` só entrega arquivos criados pelo agente (APK,
 * PDF…), recusa código — o editor do monitor mostra os trechos das ferramentas.
 * Sem `projectDir`: "Todos os arquivos" some do Explorador.
 */
import type { AgentCodeApi } from '@shared/api'
import type { RemoteClient } from '../core/client'
import { triggerDownload } from '../core/download'
import { basename } from '../core/format'

type BridgeApi = Pick<AgentCodeApi, 'officeAgentFile' | 'downloadFile'>

export function bridgeApi(client: Pick<RemoteClient, 'url' | 'fileUrl'>): BridgeApi {
  return {
    officeAgentFile: async (name) => {
      try {
        const res = await fetch(client.url(`/api/office-agent?name=${encodeURIComponent(name)}`))
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null
      } catch {
        return null
      }
    },
    downloadFile: async (path) => {
      if (!path) return { ok: false, message: 'Arquivo sem caminho.' }
      triggerDownload(client.fileUrl(path), path)
      return { ok: true, message: `Baixando ${basename(path)}…` }
    }
  }
}

/** Liga a ponte no `window.api` sem apagar o que já houver (o que existe vence). */
export function installBridgeApi(client: Pick<RemoteClient, 'url' | 'fileUrl'>): void {
  const w = window as unknown as { api?: Partial<AgentCodeApi> }
  w.api = { ...bridgeApi(client), ...(w.api ?? {}) }
}
