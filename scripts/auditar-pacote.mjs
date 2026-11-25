// Auditoria do que vai ser publicado: procura, DENTRO do pacote do setup e do exe de suporte,
// por chave, token, senha, IP de servidor, caminho pessoal e e-mail. Só padrões: nenhum
// segredo de verdade está escrito aqui. Os achados saem mascarados.
// Uso: node scripts/auditar-pacote.mjs [--padroes <arquivo.json>] <pasta-ou-arquivo> [...]
//   ex.: node scripts/auditar-pacote.mjs dist/win-unpacked dist/AgentCode-Suporte.exe
// --padroes acrescenta padrões SEUS (IP dos seus servidores, seu usuário do Windows, domínio de
// e-mail), num JSON fora do repositório: [{ "tipo", "regex", "onde": "tudo"|"nosso", "visivel": true }].
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const iPadroes = args.indexOf('--padroes')
const arquivoDePadroes = iPadroes >= 0 ? args.splice(iPadroes, 2)[1] : null
const alvos = args
if (alvos.length === 0) {
  console.error('Uso: node scripts/auditar-pacote.mjs [--padroes <arquivo.json>] <pasta-ou-arquivo> [...]')
  process.exit(2)
}
const PADROES = [
  // --- chaves e tokens (formato) ---
  ['token-anthropic', /sk-ant-[A-Za-z0-9_-]{24,}/g, 'tudo'],
  ['token-openai', /sk-proj-[A-Za-z0-9_-]{24,}/g, 'tudo'],
  ['token-kimi', /sk-kimi-[A-Za-z0-9]{24,}/g, 'tudo'],
  ['chave-google', /AIza[0-9A-Za-z_-]{33,}/g, 'tudo'],
  ['oauth-google', /GOCSPX-[A-Za-z0-9_-]{20,}/g, 'tudo'],
  ['token-github', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, 'tudo'],
  ['token-typesafe', /apikey_[0-9a-f]{24,}/g, 'tudo'],
  ['token-meshy', /msy_[A-Za-z0-9]{24,}/g, 'tudo'],
  ['token-mapbox', /[ps]k\.eyJ1[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, 'tudo'],
  ['jwt', /eyJhbGciOi[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{16,}/g, 'tudo'],
  ['chave-privada', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g, 'tudo'],
  ['url-com-senha', /[a-z][a-z0-9+.-]{2,20}:\/\/[A-Za-z0-9._%-]{2,40}:[^\s'"@/<>{}$`\\]{6,80}@[A-Za-z0-9.-]{3,}/g, 'tudo'],
  // --- suporte remoto ---
  ['chave-da-equipe', /SUPORTE_KEY\s*[=:]\s*['"]?[A-Za-z0-9_\-+/=]{16,}/g, 'tudo'],
  ['cabecalho-chave', /x-suporte-chave['"]?\s*[:=]\s*['"][A-Za-z0-9_\-+/=]{16,}['"]/gi, 'tudo'],
  // --- senha escrita em código nosso ---
  ['senha-no-codigo', /(?:senha|password|passwd|pwd|secret|segredo|api[_-]?key|token)['"]?\s*[:=]\s*['"][A-Za-z0-9!@#$%^&*()_+\-=.:;,?]{10,}['"]/gi, 'nosso'],
  // --- IP de servidor ---
  ['ip-publico', /\b(?!(?:127|10|0|255|224|239)\.)(?!192\.168\.)(?!169\.254\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, 'nosso'],
  // --- caminho pessoal ---
  ['caminho-pessoal', /(?:[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!Public\b|Default\b|runner\b)[A-Za-z0-9._ -]{2,30}(?=[\\/])|[A-Za-z]:[\\/]{1,2}OneDrive[\\/])/g, 'tudo'],
  // --- e-mail ---
  // (o "não vem depois de outro caractere de e-mail" + o teto de 64 evitam custo quadrático em base64 longo)
  ['email-qualquer', /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{2,64}@(?:gmail|hotmail|outlook|yahoo)\.com(?:\.br)?/gi, 'nosso']
]
const BLOCO = 16 * 1024 * 1024
const SOBRA = 2048
const mascarar = (t) => (t.length <= 14 ? t : `${t.slice(0, 10)}…(${t.length})`)
const visivel = new Set(['ip-publico', 'caminho-pessoal', 'email-qualquer'])
if (arquivoDePadroes) {
  for (const p of JSON.parse(readFileSync(arquivoDePadroes, 'utf8'))) {
    PADROES.push([p.tipo, new RegExp(p.regex, 'gi'), p.onde === 'nosso' ? 'nosso' : 'tudo'])
    if (p.visivel) visivel.add(p.tipo)
  }
}
const achados = new Map() // tipo → Map(valor mascarado → Set(arquivos))
let arquivos = 0
let bytes = 0

function anota(tipo, valor, arquivo) {
  const chave = visivel.has(tipo) ? valor : mascarar(valor)
  if (!achados.has(tipo)) achados.set(tipo, new Map())
  const porValor = achados.get(tipo)
  if (!porValor.has(chave)) porValor.set(chave, new Set())
  porValor.get(chave).add(arquivo)
}

function varrer(arquivo, raiz) {
  const rel = path.relative(raiz, arquivo).split(path.sep).join('/') || path.basename(arquivo)
  const nosso = !/(^|\/)node_modules\//.test(rel) && !/(^|\/)(postgres|locales|7zip)\//.test(rel)
  const fd = openSync(arquivo, 'r')
  try {
    const buf = Buffer.allocUnsafe(BLOCO + SOBRA)
    let resto = 0
    for (;;) {
      const lidos = readSync(fd, buf, resto, BLOCO, null)
      if (lidos <= 0) break
      const parte = buf.subarray(0, resto + lidos)
      const ascii = parte.toString('latin1')
      // Duas leituras: como está (UTF-8/ASCII) e sem os zeros (texto UTF-16 de exe e dll).
      for (const texto of ascii.includes('\0') ? [ascii, ascii.replace(/\0/g, '')] : [ascii]) {
        for (const [tipo, re, onde] of PADROES) {
          if (onde === 'nosso' && !nosso) continue
          re.lastIndex = 0
          for (let m = re.exec(texto); m; m = re.exec(texto)) anota(tipo, m[0], rel)
        }
      }
      bytes += lidos
      resto = Math.min(SOBRA, parte.length)
      parte.copy(buf, 0, parte.length - resto)
    }
  } finally {
    closeSync(fd)
  }
  arquivos++
}

function andar(alvo, raiz) {
  const st = statSync(alvo)
  if (st.isDirectory()) for (const nome of readdirSync(alvo)) andar(path.join(alvo, nome), raiz)
  else if (st.isFile() && st.size > 0) varrer(alvo, raiz)
}

for (const alvo of alvos) {
  const antes = arquivos
  andar(path.resolve(alvo), statSync(alvo).isDirectory() ? path.resolve(alvo) : path.dirname(path.resolve(alvo)))
  console.log(`varrido: ${alvo} (${arquivos - antes} arquivos)`)
}
console.log(`total: ${arquivos} arquivos, ${(bytes / 1048576).toFixed(0)} MB\n`)
if (achados.size === 0) console.log('NENHUM ACHADO')
for (const [tipo, porValor] of achados) {
  console.log(`== ${tipo}: ${porValor.size} valor(es)`)
  for (const [valor, onde] of [...porValor].slice(0, 40)) {
    const lista = [...onde]
    console.log(`   ${valor}  ←  ${lista.slice(0, 4).join(' | ')}${lista.length > 4 ? ` (+${lista.length - 4})` : ''}`)
  }
  if (porValor.size > 40) console.log(`   … +${porValor.size - 40}`)
}
