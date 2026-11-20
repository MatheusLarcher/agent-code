// Incrementa o patch da versao em package.json e imprime a versao nova.
// Usado pelo scripts/build-installer.bat antes de gerar o instalador.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const caminho = join(raiz, 'package.json')

const bruto = readFileSync(caminho, 'utf8')
const pacote = JSON.parse(bruto)

const partes = String(pacote.version ?? '').split('.')
if (partes.length !== 3 || partes.some((p) => !/^\d+$/.test(p))) {
  console.error(`[bump-version] versao invalida em package.json: "${pacote.version}"`)
  process.exit(1)
}

const anterior = partes.join('.')
partes[2] = String(Number(partes[2]) + 1)
const nova = partes.join('.')

// Troca so o valor da chave "version" para preservar formatacao e ordem do arquivo.
const atualizado = bruto.replace(/("version"\s*:\s*")[^"]*(")/, (_m, abre, fecha) => `${abre}${nova}${fecha}`)
if (atualizado === bruto) {
  console.error('[bump-version] nao foi possivel localizar a chave "version" em package.json.')
  process.exit(1)
}

writeFileSync(caminho, atualizado)
console.error(`[bump-version] ${anterior} -> ${nova}`)

// Novidades: os itens de "proxima" viram a nota da versao nova (mostrada em
// Configuracoes > Novidades). Sem itens, so avisa: o build nao para por isso.
const caminhoNotas = join(raiz, 'src', 'shared', 'novidades.json')
const notas = JSON.parse(readFileSync(caminhoNotas, 'utf8'))
const itens = Array.isArray(notas.proxima) ? notas.proxima.filter((s) => typeof s === 'string' && s.trim()) : []
if (itens.length === 0) {
  console.error('[bump-version] AVISO: src/shared/novidades.json sem itens em "proxima"; a versao sai sem nota.')
} else {
  const hoje = new Date()
  const data = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`
  const versoes = (Array.isArray(notas.versoes) ? notas.versoes : []).filter((v) => v.versao !== nova)
  notas.versoes = [{ versao: nova, data, itens }, ...versoes]
  notas.proxima = []
  writeFileSync(caminhoNotas, JSON.stringify(notas, null, 2) + '\n')
  console.error(`[bump-version] novidades da ${nova}: ${itens.length} item(ns).`)
}
// stdout recebe apenas a versao nova: o .bat le daqui.
console.log(nova)
