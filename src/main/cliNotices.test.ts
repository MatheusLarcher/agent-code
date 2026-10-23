import { describe, expect, it } from 'vitest'
import { apiRetryFrom, informationalText, notificationText, permissionDeniedText } from './cliNotices'

const NOW = 1_700_000_000_000

describe('apiRetryFrom', () => {
  it('lê o contrato do SDK e calcula o retryAt', () => {
    const msg = { type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10, retry_delay_ms: 12_000, error_status: 529, error: 'overloaded' }
    expect(apiRetryFrom(msg, NOW)).toEqual({ attempt: 3, maxRetries: 10, retryAt: NOW + 12_000, status: 529, error: 'overloaded' })
  })

  it('sem resposta HTTP: status null; espera negativa não volta no tempo', () => {
    const msg = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: -5, error_status: null, error: 'unknown' }
    expect(apiRetryFrom(msg, NOW)).toMatchObject({ status: null, retryAt: NOW })
  })

  it('malformada ou de outro subtipo: null', () => {
    expect(apiRetryFrom({ type: 'system', subtype: 'api_retry', attempt: '3' }, NOW)).toBeNull()
    expect(apiRetryFrom({ type: 'system', subtype: 'status' }, NOW)).toBeNull()
    expect(apiRetryFrom(null, NOW)).toBeNull()
  })
})

describe('permissionDeniedText', () => {
  // O formato real do probe ao vivo (E): sem `decision_reason`, motivo em `message`.
  const probeE = {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Bash',
    tool_use_id: 'toolu_1',
    decision_reason_type: 'rule',
    message: 'Permission to use Bash with command echo probe-negado has been denied.'
  }

  it('regra: rótulo, ferramenta e o motivo do `message`', () => {
    expect(permissionDeniedText(probeE)).toBe(
      'Negado sem perguntar (regra de permissão): Bash — Permission to use Bash with command echo probe-negado has been denied.'
    )
  })

  it('o `decision_reason` vence o `message`', () => {
    expect(permissionDeniedText({ ...probeE, decision_reason_type: 'classifier', decision_reason: 'Ação arriscada' })).toBe(
      'Negado sem perguntar (classificador do modo auto): Bash — Ação arriscada'
    )
  })

  it('rótulos por tipo; tipo desconhecido sem rótulo', () => {
    expect(permissionDeniedText({ ...probeE, decision_reason_type: 'mode' })).toMatch(/^Negado sem perguntar \(modo de permissão\): Bash/)
    expect(permissionDeniedText({ ...probeE, decision_reason_type: 'asyncAgent' })).toMatch(/\(subagente em segundo plano\)/)
    expect(permissionDeniedText({ ...probeE, decision_reason_type: 'outro' })).toMatch(/^Negado sem perguntar: Bash — /)
    expect(permissionDeniedText({ ...probeE, decision_reason_type: undefined })).toMatch(/^Negado sem perguntar: Bash — /)
  })

  it('hook (o PreToolUse do próprio app) não aparece', () => {
    expect(permissionDeniedText({ ...probeE, decision_reason_type: 'hook' })).toBeNull()
  })

  it('sem motivo nenhum: só a ferramenta', () => {
    expect(permissionDeniedText({ type: 'system', subtype: 'permission_denied', tool_name: 'Write', decision_reason_type: 'rule' })).toBe(
      'Negado sem perguntar (regra de permissão): Write'
    )
  })
})

describe('informationalText / notificationText', () => {
  it("informational: 'info' fica fora; notice, suggestion e warning aparecem", () => {
    const info = (level: string) => ({ type: 'system', subtype: 'informational', content: ' Hook bloqueou o envio. ', level })
    expect(informationalText(info('info'))).toBeNull()
    expect(informationalText(info('notice'))).toBe('Hook bloqueou o envio.')
    expect(informationalText(info('suggestion'))).toBe('Hook bloqueou o envio.')
    expect(informationalText(info('warning'))).toBe('Hook bloqueou o envio.')
    expect(informationalText({ type: 'system', subtype: 'informational', content: '   ', level: 'warning' })).toBeNull()
  })

  it('notification: low e medium ficam fora; high e immediate aparecem', () => {
    const note = (priority: string) => ({ type: 'system', subtype: 'notification', key: 'k', text: 'Contexto quase cheio', priority })
    expect(notificationText(note('low'))).toBeNull()
    expect(notificationText(note('medium'))).toBeNull()
    expect(notificationText(note('high'))).toBe('Contexto quase cheio')
    expect(notificationText(note('immediate'))).toBe('Contexto quase cheio')
  })

  it('texto longo é cortado', () => {
    const long = 'x'.repeat(1000)
    const out = notificationText({ type: 'system', subtype: 'notification', text: long, priority: 'high' })!
    expect(out.length).toBe(400)
    expect(out.endsWith('…')).toBe(true)
  })
})
