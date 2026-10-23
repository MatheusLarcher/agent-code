import { describe, expect, it, vi } from 'vitest'
import { parseStopTaskBody, stopBackgroundTask, validStopId } from './backgroundTaskStop'

describe('validStopId', () => {
  it('texto de 1 a 200 caracteres; o resto não', () => {
    expect(validStopId('b3k9x2')).toBe(true)
    expect(validStopId('x'.repeat(200))).toBe(true)
    expect(validStopId('x'.repeat(201))).toBe(false)
    expect(validStopId('')).toBe(false)
    expect(validStopId('   ')).toBe(false)
    expect(validStopId(42)).toBe(false)
    expect(validStopId(undefined)).toBe(false)
  })
})

describe('parseStopTaskBody', () => {
  it('os dois ids válidos; JSON quebrado ou campo faltando, null', () => {
    expect(parseStopTaskBody(JSON.stringify({ convId: 'c1', taskId: 't1' }))).toEqual({ convId: 'c1', taskId: 't1' })
    expect(parseStopTaskBody(JSON.stringify({ convId: 'c1' }))).toBeNull()
    expect(parseStopTaskBody(JSON.stringify({ convId: 'c1', taskId: 'x'.repeat(201) }))).toBeNull()
    expect(parseStopTaskBody('{')).toBeNull()
    expect(parseStopTaskBody('null')).toBeNull()
    expect(parseStopTaskBody(null)).toBeNull()
  })
})

describe('stopBackgroundTask', () => {
  it('vai à sessão com o id; sem sessão, id inválido ou erro da sessão → false', async () => {
    const stopTask = vi.fn(async () => true)
    expect(await stopBackgroundTask({ stopTask }, 'c1', 't1')).toBe(true)
    expect(stopTask).toHaveBeenCalledWith('t1')
    expect(await stopBackgroundTask(undefined, 'c1', 't1')).toBe(false)
    expect(await stopBackgroundTask({ stopTask }, 'c1', '')).toBe(false)
    expect(await stopBackgroundTask({ stopTask: async () => { throw new Error('x') } }, 'c1', 't1')).toBe(false)
    expect(stopTask).toHaveBeenCalledTimes(1)
  })
})
