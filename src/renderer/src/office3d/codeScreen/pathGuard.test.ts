import { describe, expect, it } from 'vitest'
import { diskReadVerdict, isInside, isSensitivePath, normalizePath, relativePath } from './pathGuard'

describe('pathGuard', () => {
  it('normaliza separadores, ponto e ponto-ponto; minúsculo só em caminho Windows', () => {
    expect(normalizePath('C:\\Proj\\Src\\..\\A.ts')).toBe('c:/proj/a.ts')
    expect(normalizePath('C:/GitHub/agent-code/src\\x.ts')).toBe('c:/github/agent-code/src/x.ts')
    expect(normalizePath('/home/U/proj/./src//a.ts')).toBe('/home/U/proj/src/a.ts')
    expect(normalizePath('src\\a.ts')).toBe('src/a.ts')
  })

  it('dentro do cwd: só caminho absoluto abaixo da pasta (caixa e barras do Windows não importam)', () => {
    const cwd = 'C:\\GitHub\\agent-code'
    expect(isInside('C:\\GitHub\\agent-code\\src\\a.ts', 'c:/github/Agent-Code')).toBe(true)
    expect(isInside('C:/GitHub/agent-code/src\\a.ts', 'C:\\GitHub\\agent-code\\')).toBe(true)
    // Prefixo de nome não é pasta; ponto-ponto não escapa; outro disco; relativo; a própria pasta.
    expect(isInside('C:\\GitHub\\agent-code-2\\a.ts', cwd)).toBe(false)
    expect(isInside('C:\\GitHub\\agent-code\\..\\segredo\\a.ts', cwd)).toBe(false)
    expect(isInside('D:\\GitHub\\agent-code\\a.ts', cwd)).toBe(false)
    expect(isInside('src\\a.ts', cwd)).toBe(false)
    expect(isInside('C:\\GitHub\\agent-code', cwd)).toBe(false)
    // POSIX diferencia caixa.
    expect(isInside('/home/u/proj/a.ts', '/home/u/proj')).toBe(true)
    expect(isInside('/home/u/Proj/a.ts', '/home/u/proj')).toBe(false)
    // UNC (\\servidor\pasta) só dentro do mesmo compartilhamento.
    expect(isInside('\\\\nas\\obra\\src\\a.ts', '\\\\NAS\\obra')).toBe(true)
    expect(isInside('\\\\nas\\outra\\a.ts', '\\\\nas\\obra')).toBe(false)
  })

  it('nomes sensíveis nunca são lidos do disco', () => {
    const yes = [
      'C:\\p\\.env', 'C:\\p\\.env.local', 'C:\\p\\.env-backup', 'C:\\p\\.env_old', 'C:\\p\\prod.env', 'C:\\p\\.envrc', 'C:\\p\\certs\\server.pem', 'C:\\p\\tls.key',
      'C:\\Users\\m\\.ssh\\config', 'C:\\p\\id_rsa', 'C:\\p\\id_ed25519.pub', 'C:\\p\\config\\credentials.json',
      'C:\\p\\client_secret.json', 'C:\\p\\.npmrc', 'C:\\p\\.aws\\config', 'C:\\p\\loja.pfx', '/srv/app/.git-credentials'
    ]
    for (const p of yes) expect(isSensitivePath(p), p).toBe(true)
    const no = ['C:\\p\\src\\envelope.ts', 'C:\\p\\src\\keyboard.ts', 'C:\\p\\README.md', 'C:\\p\\src\\tokens.ts', 'C:\\p\\environment.ts']
    for (const p of no) expect(isSensitivePath(p), p).toBe(false)
  })

  it('veredito da leitura do disco: ok só para absoluto, dentro do cwd e sem nome sensível', () => {
    const cwd = 'C:\\proj\\loja'
    expect(diskReadVerdict('C:\\proj\\loja\\src\\a.ts', cwd)).toBe('ok')
    expect(diskReadVerdict('C:\\proj\\outro\\a.ts', cwd)).toBe('outside')
    expect(diskReadVerdict('src\\a.ts', cwd)).toBe('relative')
    expect(diskReadVerdict('C:\\proj\\loja\\.env', cwd)).toBe('sensitive')
    expect(diskReadVerdict('C:\\proj\\loja\\src\\a.ts', '')).toBe('outside')
  })

  it('caminho relativo ao cwd, com a caixa original (relativo dado fica como veio)', () => {
    expect(relativePath('C:\\Proj\\Loja\\src\\Cart.tsx', 'c:\\proj\\loja')).toBe('src/Cart.tsx')
    expect(relativePath('C:\\outro\\a.ts', 'c:\\proj\\loja')).toBeNull()
    expect(relativePath('src\\a.ts', 'c:\\proj\\loja')).toBe('src/a.ts')
  })
})
