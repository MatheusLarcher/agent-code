// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { maskDeep, maskSecrets, SECRET_MASK } from './centralRedact'

// Valores de mentira, montados em partes para nenhum scanner de segredo do repositório disparar.
const HEX32 = ['a8f5f167', 'f44f4964', 'e6c998de', 'e827110c'].join('')
const B64 = ['dGhpcyBpcyBh', 'IHNlY3JldCBr', 'ZXkgZm9yIHRl', 'c3Rpbmc='].join('')
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLWZha2UtMTIz'].join('.')

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
    ['base64 longo', `valor ${B64} fim`, `valor ${SECRET_MASK} fim`]
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
    'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1x'
  ])('%s', (text) => {
    expect(maskSecrets(text)).toBe(text)
  })

  it('texto vazio e não-texto', () => {
    expect(maskSecrets('')).toBe('')
    expect(maskSecrets(undefined as unknown as string)).toBe('')
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
