import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeVerdict, clearVerdict, ERROR_TTL_MS, rememberVerdict, VERDICT_FILE } from './gpuVerdict'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gpu-verdict-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('veredito da GPU do Parakeet', () => {
  it('sem arquivo: tenta a GPU', () => {
    expect(activeVerdict(dir, 'dml', '1.21.0')).toBeUndefined()
  })

  it('erro lembrado pula a GPU nos próximos lançamentos', () => {
    rememberVerdict(dir, 'dml', 'error', 'sessão falhou', '1.21.0', 1000)
    expect(activeVerdict(dir, 'dml', '1.21.0', 1000 + 60_000)).toBe('sessão falhou')
  })

  it('erro antigo expira: a GPU é testada de novo (driver pode ter sido atualizado)', () => {
    rememberVerdict(dir, 'dml', 'error', 'sessão falhou', '1.21.0', 1000)
    expect(activeVerdict(dir, 'dml', '1.21.0', 1000 + ERROR_TTL_MS + 1)).toBeUndefined()
  })

  it('lentidão não expira com o tempo', () => {
    rememberVerdict(dir, 'dml', 'slow', 'lenta', '1.21.0', 1000)
    expect(activeVerdict(dir, 'dml', '1.21.0', 1000 + 10 * ERROR_TTL_MS)).toBe('lenta')
  })

  it('outra versão do onnxruntime invalida qualquer veredito', () => {
    rememberVerdict(dir, 'dml', 'slow', 'lenta', '1.21.0')
    expect(activeVerdict(dir, 'dml', '1.22.0')).toBeUndefined()
  })

  it('vale por dispositivo e some quando a GPU volta a funcionar', () => {
    rememberVerdict(dir, 'dml', 'error', 'x', '1.21.0')
    expect(activeVerdict(dir, 'cuda', '1.21.0')).toBeUndefined()
    clearVerdict(dir, 'dml')
    expect(activeVerdict(dir, 'dml', '1.21.0')).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, VERDICT_FILE), 'utf8'))).toEqual({})
  })

  it('arquivo antigo (texto puro) ou corrompido não trava: tenta a GPU', () => {
    writeFileSync(join(dir, VERDICT_FILE), JSON.stringify({ dml: 'aquecimento lento' }))
    expect(activeVerdict(dir, 'dml', '1.21.0')).toBeUndefined()
    writeFileSync(join(dir, VERDICT_FILE), '{quebrado')
    expect(activeVerdict(dir, 'dml', '1.21.0')).toBeUndefined()
  })
})
