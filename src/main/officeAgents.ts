/**
 * Arquivos 3D dos agentes do Escritório (resources/office-agents): os modelos
 * <papel>.glb e o ambiente do PBR já assado (ambiente.bin). O renderer pede por
 * IPC e recebe os bytes, porque no app empacotado a janela abre por file:// e
 * o fetch do GLTFLoader não lê file:. No instalador vêm por extraResources
 * (resources/office-agents); no dev, da raiz do projeto.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** O arquivo: nome em letras minúsculas e hífen (o papel do agente, "ambiente") e .glb ou .bin. Sem pasta. */
const FILE_NAME = /^[a-z][a-z-]{0,39}\.(glb|bin)$/
/** Teto de leitura: um GLB do elenco tem ≤ 4 MB; acima disso não é um dos nossos. */
const MAX_BYTES = 16 * 1024 * 1024

export interface OfficeAgentsPaths {
  packaged: boolean
  resourcesPath: string
  appPath: string
}

export function officeAgentFilePath(name: string, p: OfficeAgentsPaths): string {
  const base = p.packaged ? join(p.resourcesPath, 'office-agents') : join(p.appPath, 'resources', 'office-agents')
  return join(base, name)
}

/** Os bytes do arquivo `name` (ex.: principal.glb), ou null (nome inválido, arquivo ausente ou grande demais). */
export async function readOfficeAgentFile(name: unknown, p: OfficeAgentsPaths): Promise<Uint8Array | null> {
  if (typeof name !== 'string' || !FILE_NAME.test(name)) return null
  const file = officeAgentFilePath(name, p)
  if (!existsSync(file)) return null
  const data = await readFile(file)
  return data.byteLength > MAX_BYTES ? null : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
