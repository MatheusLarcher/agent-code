import { describe, expect, it } from 'vitest'
import { translateKimiError } from './kimiErrors'

const err = (message: string, type = 'invalid_request_error'): string => JSON.stringify({ type: 'error', error: { type, message } })

describe('erros do Kimi para o CLI', () => {
  it('estouro de tokens vira "prompt is too long: N tokens > M maximum" (o CLI compacta)', () => {
    const r = translateKimiError(400, err('Your request exceeded model token limit: 262144'), 262_144, 2_000_000)
    expect(r?.status).toBe(400)
    const message = (JSON.parse(r!.body) as { error: { message: string } }).error.message
    const [, n, m] = /prompt is too long: (\d+) tokens > (\d+) maximum/.exec(message)!
    expect(Number(m)).toBe(262_144)
    expect(Number(n)).toBeGreaterThan(Number(m))
  })

  it('estouro de tamanho usa a janela da config', () => {
    const r = translateKimiError(400, err('total message size 2300000 exceeds limit 2097152'), 1_048_576, 10)
    expect(r!.body).toMatch(/tokens > 1048576 maximum/)
  })

  it('401 e 403 de acesso viram mensagens claras; sem nova tentativa', () => {
    expect(translateKimiError(401, err('Invalid Authentication', 'invalid_authentication_error'), 262_144, 1)!.body).toMatch(/Chave do Kimi inválida/)
    expect(translateKimiError(403, err('Kimi For Coding is currently only available for Coding Agents', 'access_terminated_error'), 262_144, 1)!.body).toMatch(/recusou a chave/)
  })

  it('429 (cota ou transitório) e outros 400 passam intactos', () => {
    expect(translateKimiError(429, err("You've reached your 5-hour usage limit", 'rate_limit_error'), 262_144, 1)).toBeNull()
    expect(translateKimiError(429, err('too many requests', 'rate_limit_error'), 262_144, 1)).toBeNull()
    expect(translateKimiError(400, err('unsupported image url'), 262_144, 1)).toBeNull()
    expect(translateKimiError(403, err('Your current subscription does not have access to k3.1-pro-highspeed', 'permission_error'), 262_144, 1)).toBeNull()
  })
})
