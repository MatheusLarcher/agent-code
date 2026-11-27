/**
 * Ficha de cada memória para a busca nova (spec 2026-11-26, §3 e D37/D42/D43): tema,
 * nível, datas, título, gancho e texto. Os arquivos `.md` seguem sendo a memória (D43);
 * a ficha só lê o que está neles (e, quando houver, as datas do banco — D42).
 *
 * Funções puras, sem Electron: o avaliador (scripts/medicoes) e o app usam as mesmas.
 */
import { memoryFileIndex } from '../../memory/memoryFileCache'
import { isPinnedMemory, redactMemorySecrets, type MemoryFile } from '../../memoryIndex'
import type { LigacaoDeclarada } from './grafo'

export const NIVEIS = ['fast', 'curto', 'medio', 'longo', 'observacao'] as const
export type Nivel = (typeof NIVEIS)[number]
export const TEMA_GERAL = 'geral'

export interface FichaMemoria {
  /** ID interno = caminho relativo da memória (fixo enquanto o arquivo não muda de lugar). */
  id: string
  tema: string
  /** O tema veio do cabeçalho (`tema:`), e não da pasta: o memorista/bibliotecário decidiu. */
  temaDeclarado: boolean
  nivel: Nivel
  titulo: string
  gancho: string
  /** Corpo sem cabeçalho e com segredos tapados (D45): nunca o valor do cofre. */
  texto: string
  criadaEm: number | null
  modificadaEm: number | null
  ultimoUsoEm: number | null
  sempre: boolean
  /** 1–5 (D38); 3 quando a memória ainda não tem nota. */
  importancia: number
  /** Layout novo: jeitos de o usuário pedir isso, com as palavras dele (gravados pelo memorista). */
  gatilhos: string[]
  /** Layout novo: nomes próprios, números e sinônimos do assunto. */
  termos: string[]
  /** Ligações gravadas no cabeçalho pelo memorista/bibliotecário (caminhos de outras memórias). */
  contradiz: string[]
  relacionadas: string[]
  substitui: string[]
}

/** As ligações que as fichas declaram no cabeçalho, no formato do grafo. */
export function ligacoesDasFichas(fichas: readonly FichaMemoria[]): LigacaoDeclarada[] {
  const out: LigacaoDeclarada[] = []
  for (const f of fichas) {
    for (const d of f.contradiz) out.push({ origem: f.id, destino: d, tipo: 'contradiz' })
    for (const d of f.relacionadas) out.push({ origem: f.id, destino: d, tipo: 'relacionada' })
    for (const d of f.substitui) out.push({ origem: f.id, destino: d, tipo: 'substitui' })
  }
  return out
}

/** Datas que o banco já guarda (D42): valem antes das escritas no arquivo. */
export interface DatasDoBanco {
  criadaEm?: number | null
  modificadaEm?: number | null
  ultimoUsoEm?: number | null
}

const DIA_MS = 86_400_000
const FRONT = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function campo(front: string, chaves: readonly string[]): string | null {
  for (const chave of chaves) {
    const v = new RegExp(`^\\s*${chave}:\\s*["']?([^"'\\r\\n]+?)["']?\\s*$`, 'im').exec(front)?.[1]?.trim()
    if (v) return v
  }
  return null
}

/** Lista YAML em bloco (`chave:` + linhas `  - item`) ou em linha (`chave: ["a","b"]`). */
export function lista(front: string, chave: string): string[] {
  const linha = new RegExp(`^\\s*${chave}:\\s*(\\[.*\\])\\s*$`, 'm').exec(front)?.[1]
  if (linha) {
    try {
      const v = JSON.parse(linha) as unknown
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  const bloco = new RegExp(`^\\s*${chave}:\\s*\\n((?:\\s+-.*\\n?)+)`, 'm').exec(front)?.[1] ?? ''
  return bloco.split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
}

function data(front: string, chaves: readonly string[]): number | null {
  const t = Date.parse(campo(front, chaves) ?? '')
  return Number.isFinite(t) ? t : null
}

/**
 * Nível pela data mais recente (REGRAS-MEMORIA §4, fase 1): fast ≤ 1 dia, curto ≤ 7,
 * médio ≤ 60, longo o resto (e sem data). Observação não sai daqui: vem do cabeçalho.
 */
export function nivelPorData(quando: number | null, hoje: number): Exclude<Nivel, 'observacao'> {
  if (quando === null) return 'longo'
  const dias = (hoje - quando) / DIA_MS
  if (dias <= 1) return 'fast'
  if (dias <= 7) return 'curto'
  if (dias <= 60) return 'medio'
  return 'longo'
}

/** Ficha de uma memória a partir do conteúdo do arquivo. */
export function fichaDe(file: MemoryFile, conteudo: string, hoje: number, banco: DatasDoBanco = {}): FichaMemoria {
  const front = FRONT.exec(conteudo)?.[1] ?? ''
  const temaCabecalho = campo(front, ['tema', 'topic'])
  const tema = temaCabecalho ?? file.folders[0]?.trim() ?? TEMA_GERAL
  const criadaEm = banco.criadaEm ?? data(front, ['criada', 'criado', 'created'])
  const modificadaEm = banco.modificadaEm ?? data(front, ['modificada', 'modificado', 'atualizada', 'atualizado', 'updated'])
  const ultimoUsoEm = banco.ultimoUsoEm ?? null
  const observacao = /^(observacao|observação|observacoes)$/i.test(campo(front, ['nivel', 'nível']) ?? '')
  const maisRecente = Math.max(ultimoUsoEm ?? -Infinity, modificadaEm ?? -Infinity, criadaEm ?? -Infinity)
  const imp = Number(campo(front, ['importancia', 'importância']))
  return {
    id: file.relPath,
    tema: tema || TEMA_GERAL,
    temaDeclarado: temaCabecalho !== null,
    nivel: observacao ? 'observacao' : nivelPorData(Number.isFinite(maisRecente) ? maisRecente : null, hoje),
    titulo: file.title,
    gancho: file.hook,
    // Tapa os segredos ANTES de juntar as linhas: a regra de `password: …` é por linha.
    texto: redactMemorySecrets(conteudo.replace(FRONT, '')).replace(/\s+/g, ' ').trim(),
    criadaEm,
    modificadaEm,
    ultimoUsoEm,
    sempre: isPinnedMemory(conteudo),
    importancia: Number.isInteger(imp) && imp >= 1 && imp <= 5 ? imp : 3,
    gatilhos: lista(front, 'gatilhos').map(redactMemorySecrets),
    termos: lista(front, 'termos').map(redactMemorySecrets),
    contradiz: lista(front, 'contradiz'),
    relacionadas: lista(front, 'relacionadas'),
    substitui: lista(front, 'substitui')
  }
}

/** Fichas de todas as memórias da pasta (arquivos ilegíveis ficam de fora). */
export function lerFichas(dir: string, files: readonly MemoryFile[], hoje: number, banco?: ReadonlyMap<string, DatasDoBanco>): FichaMemoria[] {
  const index = memoryFileIndex(dir)
  const out: FichaMemoria[] = []
  for (const file of files) {
    const cached = index.byRelPath.get(file.relPath)
    if (!cached || cached.hasNul) continue
    out.push(fichaDe(file, cached.content, hoje, banco?.get(file.relPath)))
  }
  return out
}
