// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { scanBashWrites } from './bashWriteScan'

/**
 * Duas metades igualmente importantes: o que o scanner PRECISA pegar (senão o
 * escopo vira sugestão) e o que ele precisa DEIXAR passar (senão um executor
 * com escopo não consegue rodar teste, build ou git status, e a trava é
 * desligada no primeiro dia).
 */

describe('o que precisa ser reconhecido como escrita', () => {
  it.each([
    ['redirecionamento', 'echo oi > src/main/x.ts', ['src/main/x.ts']],
    ['append', 'echo oi >> notas.md', ['notas.md']],
    ['redirecionamento colado sem espaço', 'echo oi >relatorio.txt', ['relatorio.txt']],
    ['stderr para arquivo', 'npm test 2> erro.log', ['erro.log']],
    ['cp usa o destino, não a origem', 'cp src/a.ts dist/a.ts', ['dist/a.ts']],
    ['mv usa o destino', 'mv a.txt b.txt', ['b.txt']],
    ['rm pega todos os operandos', 'rm -rf dist out', ['dist', 'out']],
    ['mkdir', 'mkdir -p src/novo', ['src/novo']],
    ['touch', 'touch src/a.ts src/b.ts', ['src/a.ts', 'src/b.ts']],
    ['tee', 'echo x | tee saida.txt', ['saida.txt']],
    ['sed -i grava no arquivo', "sed -i 's/a/b/' src/x.ts", ['src/x.ts']],
    ['dd of=', 'dd if=/dev/zero of=disco.img', ['disco.img']],
    ['aspas com espaço no nome', 'rm "pasta com espaco/x.txt"', ['pasta com espaco/x.txt']],
    // O descritor de `2>&1` não pode virar operando: `2` seria conferido como
    // caminho e recusaria um comando legítimo.
    ['descritor não vira caminho', 'rm -rf dist 2>&1', ['dist']],
    // O redirecionamento é coletado antes dos operandos — vale para qualquer
    // comando do segmento, então vem primeiro.
    ['descritor com arquivo de verdade', 'rm -rf dist 2> erro.log', ['erro.log', 'dist']],
    // `ln -s alvo link` cria só o link; o alvo é apontado, não gravado.
    ['ln grava só o link', 'ln -s ../fora/lib.js src/lib.js', ['src/lib.js']]
  ])('%s', (_label, command, expected) => {
    const scan = scanBashWrites(command)
    expect(scan.unbounded).toBe(false)
    expect(scan.targets).toEqual(expected)
  })

  it('encadeamento confere cada comando do encadeamento', () => {
    const scan = scanBashWrites('npm run build && cp out/app.js dist/app.js && rm tmp.log')
    expect(scan.targets).toEqual(['dist/app.js', 'tmp.log'])
  })
})

describe('o que NÃO pode ser confundido com escrita', () => {
  it.each([
    ['rodar teste', 'npm test'],
    ['git de leitura', 'git status --short'],
    ['ler arquivo', 'cat src/main/index.ts'],
    ['procurar', "grep -rn 'padrao' src"],
    ['sed sem -i só imprime', "sed 's/a/b/' src/x.ts"],
    ['entrada redirecionada não é escrita', 'node script.js < entrada.json'],
    ['descarte não é arquivo do projeto', 'npm run build > /dev/null'],
    ['duplicar descritor não é arquivo', 'npm test 2>&1'],
    ['cd sozinho não escreve', 'cd C:/GitHub/agent-code && npm test']
  ])('%s', (_label, command) => {
    const scan = scanBashWrites(command)
    expect(scan).toEqual({ targets: [], unbounded: false })
  })
})

describe('escrita que o scanner não consegue fixar', () => {
  it('destino vindo de variável', () => {
    const scan = scanBashWrites('echo x > "$DEST/saida.txt"')
    expect(scan.unbounded).toBe(true)
    expect(scan.reason).toContain('variável')
  })

  it('substituição de comando no destino', () => {
    expect(scanBashWrites('rm -rf $(cat lista.txt)').unbounded).toBe(true)
  })

  it('caminho relativo depois de cd — a base deixou de ser o projeto', () => {
    const scan = scanBashWrites('cd ../outro-projeto && rm -rf src')
    expect(scan.unbounded).toBe(true)
    expect(scan.reason).toContain('cd')
  })

  it('mas caminho ABSOLUTO depois de cd continua conferível', () => {
    const scan = scanBashWrites('cd /tmp && rm -rf C:/GitHub/agent-code/src')
    expect(scan.unbounded).toBe(false)
    expect(scan.targets).toEqual(['C:/GitHub/agent-code/src'])
  })

  it('git que mexe na árvore inteira não declara destino', () => {
    const scan = scanBashWrites('git checkout .')
    expect(scan.unbounded).toBe(true)
    expect(scan.reason).toContain('git checkout')
  })

  it('eval não é inspecionável', () => {
    expect(scanBashWrites('eval "$CMD"').unbounded).toBe(true)
  })
})
