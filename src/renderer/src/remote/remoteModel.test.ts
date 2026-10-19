import { describe, expect, it, vi } from 'vitest'
import { AUTO_EFFORT, AUTO_MODEL, PLANNING_MODELS } from '@shared/ipc'
import { applyRemoteModelChange, REMOTE_AUTO_NEEDS_TYPESAFE, remoteModelFields, type RemoteModelControls } from './remoteModel'

const MANAGER = { model: 'claude-opus-5-5', effort: 'high', mode: 'planning' as const, planningSlug: 'site' }
const CONV = { model: 'claude-sonnet-5-5', effort: 'medium' }

function controls(over: Partial<RemoteModelControls> = {}): RemoteModelControls & { onModelChange: ReturnType<typeof vi.fn>; onEffortChange: ReturnType<typeof vi.fn> } {
  return { model: 'claude-sonnet-5-5', effort: 'medium', onModelChange: vi.fn(), onEffortChange: vi.fn(), ...over } as never
}

describe('remoteModelFields — o que o celular mostra', () => {
  it('no Agent Manager: a config dele (não o placeholder da conversa), a lista PLANNING_MODELS e o "Auto · X"', () => {
    const f = remoteModelFields({ ...MANAGER, autoEffort: 'xhigh' }, { model: 'claude-sonnet-5-5', effort: AUTO_EFFORT }, true)
    expect(f.model).toBe('claude-sonnet-5-5')
    expect(f.effort).toBe(AUTO_EFFORT)
    expect(f.runningEffort).toBe('xhigh')
    expect(f.models?.map((m) => m.id)).toEqual(PLANNING_MODELS.map((m) => m.id))
  })

  it('no Agent Manager sem TypeSafe: o Automático só fica na lista se já for o valor gravado', () => {
    expect(remoteModelFields(MANAGER, { model: 'claude-opus-5-5', effort: 'high' }, false).models?.some((m) => m.id === AUTO_MODEL)).toBe(false)
    expect(remoteModelFields(MANAGER, { model: AUTO_MODEL, effort: 'high' }, false).models?.[0].id).toBe(AUTO_MODEL)
  })

  it('na conversa comum: o modelo/esforço dela, sem lista própria; "Auto · X" só com o esforço em Automático', () => {
    expect(remoteModelFields(CONV, { model: 'x', effort: 'low' }, true)).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(remoteModelFields({ model: 'm', effort: AUTO_EFFORT, autoEffort: 'high' }, { model: 'x', effort: 'low' }, true).runningEffort).toBe('high')
    expect(remoteModelFields({ model: 'm' }, { model: 'x', effort: 'low' }, true).effort).toBe('high')
  })
})

describe('applyRemoteModelChange — a troca pelas regras do seletor do PC', () => {
  it('chama o onModelChange/onEffortChange do modelControls (o do Manager vai para a config dele) — mesmo com a conversa ocupada', () => {
    const c = controls()
    expect(applyRemoteModelChange({ effort: 'max' }, c, false)).toEqual({ changed: true })
    expect(c.onEffortChange).toHaveBeenCalledWith('max')
    applyRemoteModelChange({ model: 'claude-opus-5-5' }, c, false)
    expect(c.onModelChange).toHaveBeenCalledWith('claude-opus-5-5')
  })

  it('o mesmo valor não troca nada', () => {
    const c = controls()
    expect(applyRemoteModelChange({ model: 'claude-sonnet-5-5', effort: 'medium' }, c, true)).toEqual({ changed: false })
    expect(c.onModelChange).not.toHaveBeenCalled()
    expect(c.onEffortChange).not.toHaveBeenCalled()
  })

  it('Automático sem TypeSafe é recusado (modelo e esforço), como no PC; com TypeSafe, troca', () => {
    const c = controls()
    expect(applyRemoteModelChange({ model: AUTO_MODEL }, c, false)).toEqual({ changed: false, refused: REMOTE_AUTO_NEEDS_TYPESAFE })
    expect(applyRemoteModelChange({ effort: AUTO_EFFORT }, c, false).refused).toBe(REMOTE_AUTO_NEEDS_TYPESAFE)
    expect(c.onModelChange).not.toHaveBeenCalled()
    expect(c.onEffortChange).not.toHaveBeenCalled()
    applyRemoteModelChange({ model: AUTO_MODEL }, c, true)
    expect(c.onModelChange).toHaveBeenCalledWith(AUTO_MODEL)
  })

  it('o Automático já gravado não é "trocado" de novo (sem recusa)', () => {
    const c = controls({ model: AUTO_MODEL })
    expect(applyRemoteModelChange({ model: AUTO_MODEL }, c, false)).toEqual({ changed: false })
  })
})
