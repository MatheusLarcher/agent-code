/**
 * O iframe do HTML do agente, o mesmo na TV e na Prévia do monitor: os
 * atributos exatos (só scripts, sem allow-same-origin, sem referrer, protocolo
 * agent-mockup), "Abrindo…"/o motivo e a recarga pela `reloadKey`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { MockupUrlResult } from '@shared/officeMockup'
import { MockupFrame, type MockupFrameProps } from './MockupFrame'

const URL_OK: MockupUrlResult = { ok: true, url: 'agent-mockup://tok/web/pagina.html' }
const base: MockupFrameProps = { cwd: 'C:\\proj', path: 'C:\\proj\\web\\pagina.html', rel: 'pagina.html', frameClass: 'f', emptyClass: 'e', testId: 'frame' }

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('MockupFrame', () => {
  it('"Abrindo…" até o endereço chegar; o iframe só com scripts (sem allow-same-origin), sem referrer, no protocolo agent-mockup', async () => {
    const mockupUrl = vi.fn(async () => URL_OK)
    render(<MockupFrame {...base} mockupUrl={mockupUrl} />)
    expect(screen.getByText('Abrindo pagina.html…')).toBeTruthy()
    const frame = await screen.findByTestId('frame')
    expect(mockupUrl).toHaveBeenCalledWith({ cwd: 'C:\\proj', path: 'C:\\proj\\web\\pagina.html' })
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.getAttribute('src')).toBe('agent-mockup://tok/web/pagina.html')
    expect([frame.getAttribute('title'), frame.className]).toEqual(['pagina.html', 'f'])
  })

  it('sem endereço: o motivo (recusa do main, erro do pedido ou fora do app)', async () => {
    const view = render(<MockupFrame {...base} mockupUrl={async () => ({ ok: false, error: 'fora da pasta da conversa' })} />)
    expect(await screen.findByText('Não deu para abrir pagina.html: fora da pasta da conversa')).toBeTruthy()
    view.unmount()
    const view2 = render(<MockupFrame {...base} mockupUrl={() => Promise.reject(new Error('ipc caiu'))} />)
    expect(await screen.findByText('Não deu para abrir pagina.html: ipc caiu')).toBeTruthy()
    view2.unmount()
    // Sem window.api (fora do app): o padrão diz por quê.
    render(<MockupFrame {...base} />)
    expect(await screen.findByText('Não deu para abrir pagina.html: fora do app')).toBeTruthy()
  })

  it('reloadKey nova: o iframe é outro (a página recarrega) e o endereço é pedido de novo — o arquivo que ainda não existia passa a abrir', async () => {
    const mockupUrl = vi.fn<(r: { cwd: string; path: string }) => Promise<MockupUrlResult>>(async () => ({ ok: false, error: 'o arquivo não existe dentro da pasta da conversa' }))
    const view = render(<MockupFrame {...base} mockupUrl={mockupUrl} reloadKey="w0" />)
    expect(await screen.findByText(/não existe/)).toBeTruthy()
    mockupUrl.mockImplementation(async () => URL_OK)
    view.rerender(<MockupFrame {...base} mockupUrl={mockupUrl} reloadKey="w1" />)
    const first = await screen.findByTestId('frame')
    expect(first.dataset.reload).toBe('w1')
    view.rerender(<MockupFrame {...base} mockupUrl={mockupUrl} reloadKey="w2" />)
    const second = screen.getByTestId('frame')
    expect(second).not.toBe(first)
    expect(second.dataset.reload).toBe('w2')
    expect(mockupUrl).toHaveBeenCalledTimes(3)
    // Desmontar solta o iframe.
    view.unmount()
    expect(screen.queryByTestId('frame')).toBeNull()
  })
})
