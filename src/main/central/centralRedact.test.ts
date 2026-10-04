// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { maskDeep, maskSecrets, SECRET_MASK } from './centralRedact'

// Valores de mentira, montados em partes para nenhum scanner de segredo do repositório disparar.
const HEX32 = ['a8f5f167', 'f44f4964', 'e6c998de', 'e827110c'].join('')
const B64 = ['dGhpcyBpcyBh', 'IHNlY3JldCBr', 'ZXkgZm9yIHRl', 'c3Rpbmc='].join('')
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLWZha2UtMTIz'].join('.')
// O segredo de exemplo da AWS (40 caracteres, 2 barras): os pedaços entre `/` têm 13, 7 e 18, nenhum com 20+.
const AWS_SECRET = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/')
// Base64url gerado (32 bytes = 43 caracteres, 3 separadores; 24 bytes = 32 caracteres, 2 separadores): a regra
// antiga só olhava pedaços entre `-`/`_` e deixava estes passarem.
const B64URL_43 = ['dR3s7ZFem0', 'xTi-I4xSBc', 'iVlh-pD4-e', 'CgarJxvDyX', 'Ijm'].join('')
const B64URL_32 = ['5TQBqWPkp_', 'UN6BevANZH', 'gUmw_nAo2M', '8w'].join('')

/** Gerador determinístico (mulberry32): a mesma sequência em toda rodada, sem Math.random. */
function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LETTERS_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const KEY_ALPHABETS = {
  base64: `${LETTERS_DIGITS}+/`,
  base64url: `${LETTERS_DIGITS}-_`,
  hex: '0123456789abcdef'
}

describe('maskSecrets — o que é segredo vira [segredo]', () => {
  it.each([
    ['chave da OpenAI/Anthropic', `use ${['sk', 'proj', 'Ab12Cd34Ef56Gh78Ij90Kl12'].join('-')} aqui`, `use ${SECRET_MASK} aqui`],
    ['chave do TypeSafe (apikey_…)', `a chave é ${['apikey', '9f8e7d6c5b4a3f2e1d0c'].join('_')}`, `a chave é ${SECRET_MASK}`],
    // Cortado (o resumo corta em 200 caracteres): curto demais para a regra da corrida longa.
    ['token do GitHub', `token ${['ghp', 'aB3dE5fG7hJ9kL1mN3pQ5rS7'].join('_')} ok`, `token ${SECRET_MASK} ok`],
    ['token do Slack', `${['xoxb', '1234567890', 'abcdefghij'].join('-')}`, SECRET_MASK],
    ['chave da AWS', `id ${['AKIA', 'IOSFODNN7EXAMPLE'].join('')} fim`, `id ${SECRET_MASK} fim`],
    ['JWT inteiro', `cookie=${JWT};`, `cookie=${SECRET_MASK};`],
    ['começo de JWT cortado', `${JWT.slice(0, 30)}…`, `${SECRET_MASK}…`],
    ['Bearer', `Authorization: Bearer ${['abcDEF123', 'ghiJKL456', 'mnoPQR'].join('')}`, `Authorization: Bearer ${SECRET_MASK}`],
    ['password=', 'password=hunter22 depois', `password=${SECRET_MASK} depois`],
    ['senha:', 'minha senha: Abacaxi#2024', `minha senha: ${SECRET_MASK}`],
    ['DB_PASSWORD= (com _ na frente)', 'DB_PASSWORD=s3gr3d0!', `DB_PASSWORD=${SECRET_MASK}`],
    ['"api_key": "…" (JSON)', '{"api_key": "abc123xyz"}', `{"api_key": "${SECRET_MASK}"}`],
    ['senha na URL', 'postgres://admin:Sup3rS3nha@db.local/app', `postgres://admin:${SECRET_MASK}@db.local/app`],
    ['hex longo', `chave ${HEX32}`, `chave ${SECRET_MASK}`],
    ['base64 longo', `valor ${B64} fim`, `valor ${SECRET_MASK} fim`],
    // Corrida de alta entropia com separadores: nenhum pedaço chega a 20 caracteres, a corrida inteira é aleatória.
    ['segredo de exemplo da AWS (barras)', `chave ${AWS_SECRET} fim`, `chave ${SECRET_MASK} fim`],
    ['base64url de 32 bytes (3 separadores)', `valor ${B64URL_43}.`, `valor ${SECRET_MASK}.`],
    ['base64url de 24 bytes (2 separadores)', `(${B64URL_32})`, `(${SECRET_MASK})`],
    ['segredo da AWS no meio de um caminho', `/etc/segredos/${AWS_SECRET}`, SECRET_MASK]
  ])('%s', (_name, input, expected) => {
    expect(maskSecrets(input)).toBe(expected)
  })

  it('chave privada PEM inteira', () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu', '-----END RSA PRIVATE KEY-----'].join('\n')
    expect(maskSecrets(`antes\n${pem}\ndepois`)).toBe(`antes\n${SECRET_MASK}\ndepois`)
  })

  it('vários segredos no mesmo texto', () => {
    const text = `senha: Abacaxi#2024 e ${['sk', 'ant', 'Zz99Yy88Xx77Ww66Vv55Uu44'].join('-')}`
    expect(maskSecrets(text)).toBe(`senha: ${SECRET_MASK} e ${SECRET_MASK}`)
  })
})

describe('maskSecrets — o que NÃO é segredo fica como está', () => {
  it.each([
    'o botão ficou torto na tela de login',
    'src/renderer/src/office3d/Office3DWorkspace.tsx',
    'src/main/persistence/conversationWriteRecovery.ts',
    'c2475f0d-a90b-43e1-b5f1-d6f7cb78fb1b',
    'plano-20261002-0906-mockup-conversa-central',
    'conversationWriteRecoveryHelperFactoryBuilder',
    'https://docs.typesafe.ai/primitives/choice.md',
    'C:\\Users\\Matheus\\AppData\\Roaming\\agent-code-desktop',
    'o token expirou de novo',
    'instala o sk-learn',
    'commit ef8b41e',
    'bearer token é um tipo de autenticação',
    // Corrida aleatória com 31 caracteres: abaixo do teto de 32 do critério.
    'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1x',
    // Longas, com dígito e variedade de caracteres, mas feitas de palavras: caixa que só troca nas palavras.
    'IncludeNativeLibrariesForSelfExtract',
    'docs/superpowers/specs/2026-09-12-vigia-questionador-paralelo-design',
    'C:/Users/mathe/AppData/Local/Temp/agent-code-bench/gemma4/src/renderer/src/components/Sidebar',
    'checkpoint/2026-10-02-central-escritorio',
    '5862d6d1-4a7e-47e3-bf81-957de58c5a20/c2475f0d-a90b-43e1-b5f1-d6f7cb78fb1b',
    // Variedade alta (13 dígitos seguidos), mas a classe quase não muda: só a troca de classe segura este.
    'cache/bench-visual-1785652696650/ArchivedCard',
    // Troca de classe alta (ids no caminho), mas pouca variedade: só a variedade segura este.
    'app/api/v2/users/8f3b2c1d/orders/57291/items'
  ])('%s', (text) => {
    expect(maskSecrets(text)).toBe(text)
  })

  it('texto vazio e não-texto', () => {
    expect(maskSecrets('')).toBe('')
    expect(maskSecrets(undefined as unknown as string)).toBe('')
  })
})

describe('maskSecrets — chaves aleatórias geradas', () => {
  // Heurística: ainda perde ~1 em 10 mil chaves de 32 caracteres (menos nas maiores). A amostra é fixa (semente)
  // e pequena, então a rodada é a mesma sempre; a regra antiga por pedaço deixava escapar de 3% a 28% delas.
  it.each([
    ['AWS: 40 caracteres de base64 (com / e +)', 'base64', 40],
    ['base64url de 24 bytes: 32 caracteres', 'base64url', 32],
    ['base64url de 32 bytes: 43 caracteres', 'base64url', 43],
    ['base64 de 33 bytes: 44 caracteres', 'base64', 44],
    ['hex de 32 caracteres', 'hex', 32],
    ['hex de 64 caracteres', 'hex', 64]
  ] as const)('%s: nenhuma das 1000 chaves escapa', (_name, alphabet, length) => {
    const next = prng(20261002)
    const chars = KEY_ALPHABETS[alphabet]
    const leaked: string[] = []
    for (let i = 0; i < 1000; i++) {
      const key = Array.from({ length }, () => chars[Math.floor(next() * chars.length)]).join('')
      if (maskSecrets(`valor ${key} fim`) !== `valor ${SECRET_MASK} fim`) leaked.push(key)
    }
    expect(leaked).toEqual([])
  })
})

describe('maskDeep', () => {
  it('mascara todo texto aninhado, mantém chaves e o resto, sem mexer no original', () => {
    const input = {
      message: { text: 'password=hunter22', attachments: [`${HEX32}.txt`] },
      list: [{ option: 'd1', title: 'ok', n: 3, flag: true, none: null }]
    }
    const copy = JSON.parse(JSON.stringify(input))
    expect(maskDeep(input)).toEqual({
      message: { text: `password=${SECRET_MASK}`, attachments: [`${SECRET_MASK}.txt`] },
      list: [{ option: 'd1', title: 'ok', n: 3, flag: true, none: null }]
    })
    expect(input).toEqual(copy)
  })
})
