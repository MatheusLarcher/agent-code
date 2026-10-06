/**
 * O HTML do agente num iframe isolado — o do foco da TV e o da Prévia do
 * monitor, com a mesma regra nos dois: protocolo agent-mockup (origem opaca; a
 * página só alcança a pasta da conversa), sandbox SÓ com scripts — sem
 * allow-same-origin, que junto deixaria a página tirar o próprio sandbox, e sem
 * popup, formulário ou navegar o app — e sem referrer. Pede o endereço ao main
 * (`mockupUrl`); até ele chegar, ou se não der, mostra "Abrindo…" ou o motivo.
 *
 * `reloadKey` mudou: o iframe é remontado (a página recarrega; o protocolo
 * responde com no-store) e o endereço é pedido de novo — o arquivo que ainda
 * não existia passa a abrir. Desmontar solta o iframe.
 */
import { useEffect, useState } from 'react'
import type { MockupUrlResult } from '@shared/officeMockup'

export type MockupUrlFn = (req: { cwd: string; path: string }) => Promise<MockupUrlResult>

/** O endereço pelo app (window.api); fora do app, o motivo. */
export function defaultMockupUrl(req: { cwd: string; path: string }): Promise<MockupUrlResult> {
  const api = (window as { api?: { officeMockupUrl?: MockupUrlFn } }).api
  return api?.officeMockupUrl ? api.officeMockupUrl(req) : Promise.resolve({ ok: false, error: 'fora do app' })
}

export interface MockupFrameProps {
  cwd: string
  /** Caminho absoluto do .html. */
  path: string
  /** O nome à vista: o título do iframe e as mensagens. */
  rel: string
  /** O endereço no protocolo (window.api; injetável nos testes). */
  mockupUrl?: MockupUrlFn
  /** Muda para recarregar a página (a escrita nova do arquivo, o botão de recarregar). */
  reloadKey?: string
  /** O CSS de quem usa (a TV e o monitor têm o próprio). */
  frameClass: string
  emptyClass: string
  testId: string
}

export function MockupFrame({ cwd, path, rel, mockupUrl = defaultMockupUrl, reloadKey, frameClass, emptyClass, testId }: MockupFrameProps): JSX.Element {
  const [url, setUrl] = useState<MockupUrlResult | null>(null)
  useEffect(() => {
    let live = true
    void mockupUrl({ cwd, path }).then(
      (r) => live && setUrl(r),
      (e: unknown) => live && setUrl({ ok: false, error: e instanceof Error ? e.message : String(e) })
    )
    return () => {
      live = false
    }
  }, [cwd, path, mockupUrl, reloadKey])
  return url?.ok ? (
    <iframe key={reloadKey} className={frameClass} sandbox="allow-scripts" referrerPolicy="no-referrer" src={url.url} title={rel} data-testid={testId} data-reload={reloadKey} />
  ) : (
    <div className={emptyClass}>{url ? `Não deu para abrir ${rel}: ${url.error}` : `Abrindo ${rel}…`}</div>
  )
}
