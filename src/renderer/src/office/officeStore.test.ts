import { describe, expect, it, vi } from 'vitest'
import { feed } from './adapter/testFeed'
import { OfficeStore } from './officeStore'

describe('OfficeStore', () => {
  it('publica para quem assina e guarda o último', () => {
    const s = new OfficeStore()
    const cb = vi.fn()
    const off = s.subscribe(cb)
    const f = feed({ activeId: 'a' })
    s.publish(f)
    expect(cb).toHaveBeenCalledWith(f)
    expect(s.getSnapshot()).toBe(f)
    off()
    s.publish(feed())
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('override esconde o real até ser desligado', () => {
    const s = new OfficeStore()
    const real = feed({ activeId: 'r' })
    const fake = feed({ activeId: 'f' })
    s.publish(real)
    s.setOverride(fake)
    const cb = vi.fn()
    s.subscribe(cb)
    s.publish(feed({ activeId: 'r2' }))
    expect(cb).not.toHaveBeenCalled()
    expect(s.getSnapshot()).toBe(fake)
    s.setOverride(null)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(s.getSnapshot()?.activeId).toBe('r2')
  })

  it('as cores dos projetos entram no feed (mesma referência enquanto nada muda); feed com cores próprias fica com as dele', () => {
    const s = new OfficeStore()
    const cb = vi.fn()
    s.subscribe(cb)
    const real = feed({ activeId: 'a' })
    s.publish(real)
    expect(s.getSnapshot()).toBe(real)
    const colors = { 'C:\\proj\\alpha': { hex: '#3c9add', source: 'logo' as const } }
    s.setProjectColors(colors)
    expect(cb).toHaveBeenCalledTimes(2)
    const snap = s.getSnapshot()!
    expect(snap.projectColors).toBe(colors)
    expect(snap.activeId).toBe('a')
    expect(s.getSnapshot()).toBe(snap)
    s.setProjectColors(colors)
    expect(cb).toHaveBeenCalledTimes(2)
    const own = feed({ projectColors: {} })
    s.publish(own)
    expect(s.getSnapshot()).toBe(own)
  })
})
