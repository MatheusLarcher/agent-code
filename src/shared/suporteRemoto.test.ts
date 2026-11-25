import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SUPORTE_CABECALHO_CHAVE,
  SUPORTE_CAMINHOS,
  SUPORTE_DOWNLOAD_URL,
  SUPORTE_LIMITES,
  SUPORTE_PREFIXO_FERRAMENTA,
  SUPORTE_PROTOCOLO,
  SUPORTE_PROTOCOLO_MINIMO,
  SUPORTE_RECURSOS,
  SUPORTE_RECURSOS_BASICOS,
  SUPORTE_RECURSOS_EXTRAS,
  codigoSuporteValido,
  ehRecursoSuporte,
  formatarCodigoSuporte,
  normalizarCodigoSuporte
} from './suporteRemoto'

const raiz = resolve(__dirname, '../..')
const csharp = readFileSync(resolve(raiz, 'src/suporte/Contrato.cs'), 'utf8')
const relayPath = resolve(raiz, 'broker/src/suporte.js')

/** `32 * 1024 * 1024`, `120_000`… → número. Só dígitos, `_` e `*`. */
function avaliar(expressao: string): number {
  const limpa = expressao.replace(/[_\s]/g, '')
  if (!/^\d+(\*\d+)*$/.test(limpa)) throw new Error(`expressão fora do combinado: ${expressao}`)
  return limpa.split('*').reduce((total, parte) => total * Number(parte), 1)
}

function constanteCs(nome: string): string {
  const achado = new RegExp(`public const (?:int|string) ${nome} = ([^;]+);`).exec(csharp)
  if (!achado) throw new Error(`Contrato.cs não tem a constante ${nome}`)
  return achado[1].trim()
}

const textoCs = (nome: string): string => JSON.parse(constanteCs(nome)) as string
const pascal = (nome: string): string => nome[0].toUpperCase() + nome.slice(1)
const gritado = (nome: string): string => nome.replace(/([A-Z])/g, '_$1').toUpperCase()

function listaCs(nome: string): string[] {
  const achado = new RegExp(`${nome} =\\s*\\[([^\\]]+)\\]`).exec(csharp)
  if (!achado) throw new Error(`Contrato.cs não tem a lista ${nome}`)
  return achado[1].split(',').map((item) => textoCs(item.trim()))
}

describe('suporteRemoto — contrato igual no TypeScript e no C#', () => {
  it('versão do protocolo', () => {
    expect(avaliar(constanteCs('Protocolo'))).toBe(SUPORTE_PROTOCOLO)
    expect(avaliar(constanteCs('ProtocoloMinimo'))).toBe(SUPORTE_PROTOCOLO_MINIMO)
    expect(SUPORTE_PROTOCOLO_MINIMO).toBeLessThanOrEqual(SUPORTE_PROTOCOLO)
  })

  it.each(Object.entries(SUPORTE_LIMITES))('limite %s', (nome, valor) => {
    expect(avaliar(constanteCs(pascal(nome)))).toBe(valor)
  })

  it.each(Object.entries(SUPORTE_CAMINHOS))('caminho %s', (nome, valor) => {
    expect(textoCs(`Caminho${pascal(nome)}`)).toBe(valor)
  })

  it('endereços, cabeçalho e prefixo', () => {
    expect(textoCs('DownloadUrl')).toBe(SUPORTE_DOWNLOAD_URL)
    expect(textoCs('CabecalhoChave')).toBe(SUPORTE_CABECALHO_CHAVE)
    expect(textoCs('PrefixoFerramenta')).toBe(SUPORTE_PREFIXO_FERRAMENTA)
  })

  it('recursos na mesma ordem, básicos e extras', () => {
    expect(listaCs('Recursos')).toEqual([...SUPORTE_RECURSOS])
    expect(listaCs('RecursosBasicos')).toEqual([...SUPORTE_RECURSOS_BASICOS])
    expect(listaCs('RecursosExtras')).toEqual([...SUPORTE_RECURSOS_EXTRAS])
    expect([...SUPORTE_RECURSOS_BASICOS, ...SUPORTE_RECURSOS_EXTRAS]).toEqual([...SUPORTE_RECURSOS])
  })

  it('o exe só aceita relay de teste na própria máquina', () => {
    expect(csharp).toContain('uri.Host is "127.0.0.1" or "localhost"')
    expect(textoCs('RelayPadrao')).toBe('wss://agent-code.larchertech.com')
  })
})

// O relay é publicado sozinho na VPS (pasta broker/), então repete os números.
describe.skipIf(!existsSync(relayPath))('suporteRemoto — contrato igual no relay', () => {
  const relay = existsSync(relayPath) ? readFileSync(relayPath, 'utf8') : ''
  const constanteJs = (nome: string): string => {
    const achado = new RegExp(`export const ${nome} = ([^\\n]+)`).exec(relay)
    if (!achado) throw new Error(`broker/src/suporte.js não tem a constante ${nome}`)
    return achado[1].trim()
  }

  it('versão mínima e endereço do download', () => {
    expect(avaliar(constanteJs('PROTOCOLO_MINIMO'))).toBe(SUPORTE_PROTOCOLO_MINIMO)
    expect(constanteJs('DOWNLOAD_URL').replace(/^'|'$/g, '')).toBe(SUPORTE_DOWNLOAD_URL)
    expect(constanteJs('CABECALHO_CHAVE').replace(/^'|'$/g, '')).toBe(SUPORTE_CABECALHO_CHAVE)
  })

  const usadosNoRelay = [
    'chamadaBytes', 'mortoMs', 'semTecnicoMs', 'pedidoAcessoMs', 'codigoDigitos',
    'tentativasPorMinuto', 'bloqueioMs', 'maximoExes'
  ] as const
  it.each(usadosNoRelay)('limite %s', (nome) => {
    expect(avaliar(constanteJs(gritado(nome)))).toBe(SUPORTE_LIMITES[nome])
  })

  it.each(Object.entries(SUPORTE_CAMINHOS))('caminho %s aparece no relay', (_nome, valor) => {
    expect(relay).toContain(`'${valor}`)
  })
})

describe('suporteRemoto — código', () => {
  it('formata em três grupos e normaliza o que o técnico digita', () => {
    expect(formatarCodigoSuporte('482917305')).toBe('482 917 305')
    expect(normalizarCodigoSuporte(' 482-917.305 ')).toBe('482917305')
    expect(formatarCodigoSuporte('482 917 305')).toBe('482 917 305')
  })

  it('valida tamanho e dígitos', () => {
    expect(codigoSuporteValido('482 917 305')).toBe(true)
    expect(codigoSuporteValido('48291730')).toBe(false)
    expect(codigoSuporteValido('4829173055')).toBe(false)
    expect(codigoSuporteValido('48291730a')).toBe(false)
    expect(codigoSuporteValido('')).toBe(false)
  })

  it('reconhece recurso', () => {
    expect(ehRecursoSuporte('tela')).toBe(true)
    expect(ehRecursoSuporte('root')).toBe(false)
    expect(ehRecursoSuporte(3)).toBe(false)
  })
})
