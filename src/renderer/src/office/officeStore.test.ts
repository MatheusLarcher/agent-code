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
})
