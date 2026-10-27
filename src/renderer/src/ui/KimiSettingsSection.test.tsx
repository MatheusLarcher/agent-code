import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { DEFAULT_CONFIG, type AppConfig, type KimiConnectionResult } from '@shared/ipc'
import { KimiSettingsSection } from './KimiSettingsSection'

afterEach(cleanup)

let latest: AppConfig = DEFAULT_CONFIG

function Harness({ test, initial }: { test: (k: string) => Promise<KimiConnectionResult>; initial?: Partial<AppConfig['kimi']> }) {
  const [cfg, setCfg] = useState<AppConfig>({ ...DEFAULT_CONFIG, kimi: { ...DEFAULT_CONFIG.kimi, ...initial } })
  latest = cfg
  return <KimiSettingsSection cfg={cfg} setCfg={(u) => setCfg((c) => u(c))} loaded testConnection={test} />
}

describe('KimiSettingsSection', () => {
  it('testar conexão aplica região, janela e modelos e liga o Kimi', async () => {
    const test = vi.fn(async () => ({ ok: true, message: 'Conectado: K3.1 Pro, janela de 256K.', region: 'intl' as const, contextWindow: 262_144, models: ['k3.1-pro'] }))
    render(<Harness test={test} initial={{ apiKey: 'sk-kimi-a' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Testar conexão' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Conectado'))
    expect(test).toHaveBeenCalledWith('sk-kimi-a')
    expect(latest.kimi).toMatchObject({ enabled: true, region: 'intl', contextWindow: 262_144, models: ['k3.1-pro'] })
  })

  it('erro do teste aparece e não liga o Kimi', async () => {
    const test = vi.fn(async () => ({ ok: false, message: 'Chave do Kimi inválida ou expirada.' }))
    render(<Harness test={test} initial={{ apiKey: 'sk-kimi-ruim' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Testar conexão' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('inválida'))
    expect(latest.kimi.enabled).toBe(false)
    expect(latest.kimi.models).toEqual([])
  })

  it('sem chave o botão fica desabilitado; trocar a chave zera o plano testado', () => {
    render(<Harness test={vi.fn()} initial={{ apiKey: '', models: [] }} />)
    expect((screen.getByRole('button', { name: 'Testar conexão' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    render(<Harness test={vi.fn()} initial={{ apiKey: 'sk-kimi-a', models: ['k3.1-pro'] }} />)
    fireEvent.change(screen.getByLabelText('Chave do Kimi Code'), { target: { value: 'sk-kimi-b' } })
    expect(latest.kimi).toMatchObject({ apiKey: 'sk-kimi-b', models: [] })
  })

  it('instruções da organização vão para a config', () => {
    render(<Harness test={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Instruções da organização para modelos não Claude'), { target: { value: 'Responda em português.' } })
    expect(latest.externalOrgInstructions).toBe('Responda em português.')
  })
})
