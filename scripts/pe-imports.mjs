// Lê as DLLs que um executável do Windows (PE: .exe/.dll) importa — a tabela de
// importação normal e a de carga atrasada — e confere se cada uma é achada na
// pasta que viaja junto ou no próprio Windows. Usado pelo stage do PostgreSQL
// embutido (scripts/stage-postgres.mjs) para garantir que nenhum binário dependa
// de algo instalado só na máquina de build.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Runtime do Visual C++: NÃO faz parte do Windows, tem de ir junto com o app. */
export const VC_RUNTIME = /^(vcruntime\d+(_\d+)?|msvcp\d+(_\w+)?|msvcr\d+|concrt\d+|vccorlib\d+|vcomp\d+)\.dll$/i
/** API sets (api-ms-win-*, ext-ms-*): resolvidos pelo carregador do Windows. A UCRT
 *  (api-ms-win-crt-*) é parte do Windows 10/11. */
const API_SET = /^(api|ext)-ms-/i

/** { imports, delayImports }: nomes das DLLs, como gravados no binário. */
export function peImports(buf) {
  if (buf.length < 64 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error('não é um PE (sem MZ)')
  const pe = buf.readUInt32LE(0x3c)
  if (buf.readUInt32LE(pe) !== 0x00004550) throw new Error('não é um PE (sem assinatura PE)')
  const sectionCount = buf.readUInt16LE(pe + 6)
  const optionalSize = buf.readUInt16LE(pe + 20)
  const optional = pe + 24
  const magic = buf.readUInt16LE(optional)
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`cabeçalho PE desconhecido (0x${magic.toString(16)})`)
  const pe32plus = magic === 0x20b
  const imageBase = pe32plus ? buf.readBigUInt64LE(optional + 24) : BigInt(buf.readUInt32LE(optional + 28))
  const directoryCount = buf.readUInt32LE(optional + (pe32plus ? 108 : 92))
  const directories = optional + (pe32plus ? 112 : 96)
  const directoryRva = (index) => (index < directoryCount ? buf.readUInt32LE(directories + index * 8) : 0)

  const sections = []
  for (let i = 0; i < sectionCount; i++) {
    const at = optional + optionalSize + i * 40
    sections.push({
      virtualSize: buf.readUInt32LE(at + 8),
      virtualAddress: buf.readUInt32LE(at + 12),
      rawSize: buf.readUInt32LE(at + 16),
      rawPointer: buf.readUInt32LE(at + 20)
    })
  }
  const offsetOf = (rva) => {
    for (const s of sections) {
      if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)) {
        return rva - s.virtualAddress + s.rawPointer
      }
    }
    throw new Error(`RVA 0x${rva.toString(16)} fora das seções`)
  }
  const nameAt = (rva) => {
    const start = offsetOf(rva)
    return buf.toString('latin1', start, buf.indexOf(0, start))
  }

  const imports = []
  const importRva = directoryRva(1)
  // Descritor de 20 bytes; o campo Name (+12) zerado encerra a tabela.
  if (importRva) for (let at = offsetOf(importRva); buf.readUInt32LE(at + 12); at += 20) imports.push(nameAt(buf.readUInt32LE(at + 12)))
  const delayImports = []
  const delayRva = directoryRva(13)
  if (delayRva) {
    // Descritor de 32 bytes; DllName (+4) zerado encerra. Sem o bit 0 dos
    // atributos (formato antigo), os ponteiros são VAs, não RVAs.
    for (let at = offsetOf(delayRva); buf.readUInt32LE(at + 4); at += 32) {
      const pointer = buf.readUInt32LE(at + 4)
      delayImports.push(nameAt(buf.readUInt32LE(at) & 1 ? pointer : Number(BigInt(pointer) - imageBase)))
    }
  }
  return { imports, delayImports }
}

/**
 * Segue as importações a partir de `roots` (caminhos de .exe/.dll). Cada DLL
 * importada tem de estar em `binDir` (e aí é conferida também), ser um API set,
 * ou existir em `system32` sem ser runtime do Visual C++.
 * Devolve `missing` ({ dll, from }) e `vcRuntime` (runtimes do VC++ pedidos e
 * ausentes de `binDir`, em minúsculas).
 */
export function checkImports({ binDir, roots, system32 }) {
  const shipped = new Map(readdirSync(binDir).map((name) => [name.toLowerCase(), join(binDir, name)]))
  const seen = new Set()
  const missing = []
  const vcRuntime = new Set()
  const queue = [...roots]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file.toLowerCase())) continue
    seen.add(file.toLowerCase())
    const { imports, delayImports } = peImports(readFileSync(file))
    for (const dll of [...imports, ...delayImports]) {
      const lower = dll.toLowerCase()
      if (API_SET.test(lower)) continue
      const local = shipped.get(lower)
      if (local) queue.push(local)
      else if (VC_RUNTIME.test(lower)) vcRuntime.add(lower)
      else if (!existsSync(join(system32, dll))) missing.push({ dll, from: basename(file) })
    }
  }
  return { missing, vcRuntime: [...vcRuntime].sort(), checked: seen.size }
}
