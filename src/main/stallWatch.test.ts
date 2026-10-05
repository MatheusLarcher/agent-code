import { describe, it, expect } from 'vitest'
import {
  isStalled,
  stallAbortText,
  stallVerdict,
  STALL_ABORT_MS,
  STALL_ABORT_TOOL_MS,
  STALL_THRESHOLD_MS,
  STALL_THRESHOLD_TOOL_MS
} from './stallWatch'

describe('stallVerdict — aviso e travamento definitivo', () => {
  it('limiares em ordem: aviso antes do encerramento, com e sem ferramenta', () => {
    expect(STALL_THRESHOLD_MS).toBeLessThan(STALL_ABORT_MS)
    expect(STALL_THRESHOLD_TOOL_MS).toBeLessThan(STALL_ABORT_TOOL_MS)
    expect(STALL_ABORT_MS).toBe(10 * 60_000)
    expect(STALL_ABORT_TOOL_MS).toBe(30 * 60_000)
  })

  it('sem ferramenta: ok → warn → abort (limiares exclusivos)', () => {
    expect(stallVerdict(STALL_THRESHOLD_MS, 0, false)).toBe('ok')
    expect(stallVerdict(STALL_THRESHOLD_MS + 1, 0, false)).toBe('warn')
    expect(stallVerdict(STALL_ABORT_MS, 0, false)).toBe('warn')
    expect(stallVerdict(STALL_ABORT_MS + 1, 0, false)).toBe('abort')
  })

  it('com ferramenta em voo: 10 min só avisa; encerra depois de 30 min', () => {
    expect(stallVerdict(STALL_ABORT_MS + 1, 0, true)).toBe('warn')
    expect(stallVerdict(STALL_ABORT_TOOL_MS, 0, true)).toBe('warn')
    expect(stallVerdict(STALL_ABORT_TOOL_MS + 1, 0, true)).toBe('abort')
  })

  it('texto em minutos inteiros, mínimo 1', () => {
    expect(stallAbortText(10 * 60_000 + 4_000)).toBe('Sessão travada: sem resposta há 10 min — retomando de onde parou.')
    expect(stallAbortText(1_000)).toMatch(/há 1 min/)
  })
})

describe('isStalled — sem ferramenta em voo (limiar curto)', () => {
  it('atividade recente: não travado', () => {
    expect(isStalled(1000, 900, false)).toBe(false)
  })

  it('exatamente no limiar: ainda não travado (usa ">")', () => {
    expect(isStalled(STALL_THRESHOLD_MS, 0, false)).toBe(false)
  })

  it('passou do limiar sem ferramenta: travado', () => {
    expect(isStalled(STALL_THRESHOLD_MS + 1, 0, false)).toBe(true)
  })
})

describe('isStalled — COM ferramenta em voo (limiar longo, builds/downloads demoram)', () => {
  it('passou do limiar CURTO mas com ferramenta em voo: ainda NÃO travado', () => {
    expect(isStalled(STALL_THRESHOLD_MS + 1, 0, true)).toBe(false)
  })

  it('passou do limiar longo mesmo com ferramenta em voo: travado', () => {
    expect(isStalled(STALL_THRESHOLD_TOOL_MS + 1, 0, true)).toBe(true)
  })

  it('exatamente no limiar longo: ainda não travado', () => {
    expect(isStalled(STALL_THRESHOLD_TOOL_MS, 0, true)).toBe(false)
  })
})
