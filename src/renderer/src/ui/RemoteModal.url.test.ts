import { describe, it, expect } from 'vitest'
import { buildPublicUrl } from './RemoteModal'

describe('buildPublicUrl — QR aponta para o host público (VPS)', () => {
  it('host:porta vira http://host:porta/?token=…', () => {
    expect(buildPublicUrl('191.96.251.106:8765', 'tok123')).toBe('http://191.96.251.106:8765/?token=tok123')
  })
  it('aceita URL completa http(s) e mantém o origin', () => {
    expect(buildPublicUrl('https://remoto.larchertech.com', 'tok')).toBe(
      'https://remoto.larchertech.com/?token=tok'
    )
  })
  it('ignora barra(s) no fim do host', () => {
    expect(buildPublicUrl('http://1.2.3.4:8765/', 'tok')).toBe('http://1.2.3.4:8765/?token=tok')
  })
  it('escapa o token na query', () => {
    expect(buildPublicUrl('1.2.3.4:8765', 'a b/c')).toBe('http://1.2.3.4:8765/?token=a%20b%2Fc')
  })
  it('host vazio ou token vazio → "" (cai pra URL local)', () => {
    expect(buildPublicUrl('', 'tok')).toBe('')
    expect(buildPublicUrl('1.2.3.4', '')).toBe('')
  })
  it('inclui ?lan= quando o endereço LAN é passado (fallback do celular pra rede local)', () => {
    expect(buildPublicUrl('remoto.larchertech.com', 'tok', '192.168.0.10:8765')).toBe(
      'http://remoto.larchertech.com/?token=tok&lan=192.168.0.10%3A8765'
    )
  })
  it('sem endereço LAN, não inclui ?lan=', () => {
    expect(buildPublicUrl('remoto.larchertech.com', 'tok')).toBe('http://remoto.larchertech.com/?token=tok')
  })
})
