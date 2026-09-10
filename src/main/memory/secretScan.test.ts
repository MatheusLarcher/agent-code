// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { derivedSecretName, redactSecrets, scanSecrets, secretPlaceholder } from './secretScan'

const values = (text: string): string[] => scanSecrets(text).map((match) => match.value)

describe('scanSecrets', () => {
  it('acha credenciais com formato conhecido', () => {
    const cases: Array<[string, string]> = [
      ['sk-proj-abcdefghijklmnopqrstuvwxyz0123', 'openai-key'],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github-token'],
      ['xoxb-1234567890-abcdefghij', 'slack-token'],
      ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
      ['AIzaSyA1234567890abcdefghijklmnopqrstuv', 'google-key'],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g', 'jwt']
    ]
    for (const [value, kind] of cases) {
      expect(scanSecrets(`o valor é ${value} aqui`)).toEqual([{ value, kind }])
    }
  })

  it('pega senha em atribuição, URL de conexão e chave privada', () => {
    expect(values('DB_PASSWORD=Tr0v0ada!2026')).toEqual(['Tr0v0ada!2026'])
    expect(values('senha: "mUit0-secreta"')).toEqual(['mUit0-secreta'])
    expect(values('postgres://app:pg-Secreta-99@host:5432/db')).toEqual(['pg-Secreta-99'])
    expect(values('Authorization: Bearer abcdefghijklmnopqrstuvwx')).toEqual(['abcdefghijklmnopqrstuvwx'])
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----'
    expect(values(`chave:\n${key}\nfim`)).toEqual([key])
  })

  it('ignora texto comum, placeholders e valores já cofrados', () => {
    expect(scanSecrets('a senha do banco está no cofre da empresa')).toEqual([])
    expect(scanSecrets('use o token do painel para autenticar o robô')).toEqual([])
    expect(scanSecrets('password=<preencha aqui>')).toEqual([])
    expect(scanSecrets('senha: xxxxxxxx')).toEqual([])
    expect(scanSecrets('DB_PASSWORD=${DB_PASSWORD}')).toEqual([])
    expect(scanSecrets(`senha: ${secretPlaceholder('banco.1')}`)).toEqual([])
    expect(scanSecrets('')).toEqual([])
  })

  it('reporta cada valor uma vez e não sobrepõe regras', () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz01'
    // A regra específica vence a genérica; o valor repetido não duplica.
    expect(scanSecrets(`api_key=${key}\noutra vez ${key}`)).toEqual([{ value: key, kind: 'openai-key' }])
  })

  it('não guarda estado do regex global entre chamadas', () => {
    const text = 'token=abcdef123456 e password=zxcvbn987654'
    expect(values(text)).toEqual(values(text))
    expect(values(text)).toHaveLength(2)
  })
})

describe('redactSecrets', () => {
  it('substitui todas as ocorrências e prefere o valor mais longo', () => {
    const body = 'chave sk-abcdefghijklmnopqrstuvwxyz01 e de novo sk-abcdefghijklmnopqrstuvwxyz01'
    const out = redactSecrets(body, new Map([['sk-abcdefghijklmnopqrstuvwxyz01', 'nota.1']]))
    expect(out).toBe('chave {{secret:nota.1}} e de novo {{secret:nota.1}}')
    expect(out).not.toContain('sk-')

    const nested = redactSecrets('abc123456 e abc123', new Map([['abc123', 'curto'], ['abc123456', 'longo']]))
    expect(nested).toBe('{{secret:longo}} e {{secret:curto}}')
  })
})

describe('derivedSecretName', () => {
  it('deriva um nome válido do caminho da memória', () => {
    expect(derivedSecretName('2D/banco-dw.md', 1)).toBe('2D.banco-dw.1')
    expect(derivedSecretName('nota.md', 2)).toBe('nota.2')
    expect(derivedSecretName('...md', 1)).toBe('memoria.1')
  })
})
