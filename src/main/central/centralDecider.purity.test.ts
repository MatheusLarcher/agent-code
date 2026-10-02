// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A calibração (Etapa 8) roda o decisor FORA do Electron: nada que ele carrega em tempo de
// execução pode puxar electron, a config, o cliente do TypeSafe ou o store do app. Segue o grafo
// de imports reais (os `import type` somem na compilação) a partir do decisor.

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '..', '..')

/** Os especificadores importados em tempo de execução (estático e `import()`), sem os `import type`. */
function runtimeImports(file: string): string[] {
  const code = readFileSync(file, 'utf8')
  const specs: string[] = []
  for (const m of code.matchAll(/^import\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) specs.push(m[1])
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1])
  return specs
}

function resolveLocal(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec)
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) if (existsSync(candidate)) return candidate
  return null
}

/** Todos os módulos do projeto e os pacotes alcançados a partir de `entry`. */
function graph(entry: string): { modules: string[]; packages: string[] } {
  const modules = new Set<string>()
  const packages = new Set<string>()
  const visit = (file: string): void => {
    if (modules.has(file)) return
    modules.add(file)
    for (const spec of runtimeImports(file)) {
      if (!spec.startsWith('.')) {
        packages.add(spec)
        continue
      }
      const target = resolveLocal(file, spec)
      if (!target) throw new Error(`import não resolvido: ${spec} em ${file}`)
      visit(target)
    }
  }
  visit(entry)
  return {
    modules: [...modules].map((m) => relative(src, m).replace(/\\/g, '/')).sort(),
    packages: [...packages].sort()
  }
}

describe('o decisor roda fora do Electron', () => {
  it('nenhum import de tempo de execução alcança electron, config, cliente do TypeSafe, sandbox ou store', () => {
    const { modules, packages } = graph(join(here, 'centralDecider.ts'))
    expect(modules).toContain('main/central/centralPrompts.ts')
    expect(modules).toContain('main/central/centralOptions.ts')
    expect(modules).toContain('main/central/centralRedact.ts')
    expect(modules).toContain('main/central/centralIndex.ts')
    for (const forbidden of ['main/config.ts', 'main/typesafe/client.ts', 'main/sandbox.ts', 'main/store.ts']) {
      expect(modules).not.toContain(forbidden)
    }
    expect(packages.filter((p) => !p.startsWith('node:'))).toEqual([])
  })
})
