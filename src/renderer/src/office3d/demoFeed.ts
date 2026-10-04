/**
 * Feed de demonstração do modo 3D (só DEV, Ctrl+Alt+Shift+D): 5 salas × 4
 * conversas = 20 agentes vivendo uma linha do tempo de DEMO_LOOP_MS (~120 s)
 * em loop. Todas as salas têm o mesmo elenco, com o conteúdo do projeto delas:
 *   0 dev        pedidos seguidos: Read → Edit com diff → testes (às vezes
 *                falham e ele corrige) → resposta final; nas notas, consulta
 *                a documentação do runner (WebFetch) antes de escrever. Na
 *                sala 2 ele testa a loja no navegador e na sala 4 o app no
 *                Android (demoDevices.ts): a TV mostra o teste.
 *   1 construtor escreve um componente, builda, pede permissão (`rm -rf dist`)
 *                e delega a um especialista (trilha que abre e fecha); nas salas
 *                1 e 3, no fim do loop, desenha um mockup e chama o usuário na TV.
 *   2 azarado    pede permissão para publicar, toma erro da API e tenta de novo;
 *                na sala 3 estoura o limite de uso (a janela de 5h esgota e
 *                volta), na sala 4 fica mais de 2 min em silêncio.
 *   3 dorminhoco ocioso há mais de 20 min (acima do sono).
 * O azarado de cada sala passa por todas as fases; o loop dispara todos os
 * tipos de evento de events.ts (menos speaking: a demo não tem voz). A janela
 * de 5h (demoUsage) é a energia do escritório: um ciclo completo por loop —
 * cheia → economia → alerta → apagão (26 s de festa) → luz voltou.
 *
 * `demoFeed(now)` é determinístico: o quadro na fase `now mod DEMO_LOOP_MS`.
 * Sem argumento, devolve o QUADRO DE VITRINE (fase 0, relógio Date.now()): o
 * retrato estático que a cena e os testes de tela usam. Quem republica a cada
 * DEMO_TICK_MS é o Office3DWorkspace. Não mexe no devFeed do escritório 2D.
 */
import { CENTRAL_ID } from '@shared/central'
import { contextLimitFor, type PermissionRequest, type RateLimitStatus } from '@shared/ipc'
import type { TrackMap } from '../agentTracks'
import type { OfficeFeed } from '../office/adapter/feed'
import type { Conversation } from '../types'
import { demoCentralState } from './demoCentral'
import { androidTurn, browserTurn, mockupTurn } from './demoDevices'
import { demoPlanConversation } from './demoPlan'
import { DEMO_LOOP_MS, demoUsage, playScript, USAGE_BACK_AT, USAGE_OUT_AT, type DemoStep, type DemoTurn, type ToolStep } from './demoTimeline'

export const DEMO_ROOMS = 5
export const DEMO_PER_ROOM = 4
/** Intervalo do tique que republica a demo. */
export const DEMO_TICK_MS = 1_000

const svgIcon = (bg: string, fg: string, letter: string): string =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/><text x="32" y="44" font-size="34" font-family="Segoe UI,Arial" font-weight="700" text-anchor="middle" fill="${fg}">${letter}</text></svg>`
  )

const EDIT_OLD = `export function total(items: Item[]): number {
  let sum = 0
  for (const i of items) sum += i.price
  return sum
}`
const EDIT_NEW = `export function total(items: Item[], discount = 0): number {
  // Soma com desconto percentual, nunca negativo.
  const sum = items.reduce((acc, i) => acc + i.price * i.qty, 0)
  return Math.max(0, sum * (1 - discount / 100))
}`
const WRITE_TSX = `import { useState } from 'react'

export function Cart({ items }: { items: Item[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const count = items.length
  return (
    <aside className="cart">
      <button onClick={() => setOpen((v) => !v)}>Carrinho ({count})</button>
      {open && <CartList items={items} />}
    </aside>
  )
}`
const CSS_OLD = `.card {
  padding: 8px;
  border: 1px solid #ccc;
}`
const CSS_NEW = `.card {
  padding: 12px 16px;
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}`
const VITE_BUILD = `vite v6.0.3 building for production...
✓ 214 modules transformed.
dist/index.html                  0.46 kB
dist/assets/index-4f9a1c.js    182.31 kB │ gzip: 58.12 kB
✓ built in 2.84s`

/** O que muda de uma sala para outra: arquivos, testes, comandos, especialista e falas. */
interface Kit {
  project: string
  icon: string | null
  read: [path: string, text: string]
  edit: [path: string, before: string, after: string]
  /** Ajuste do teste que quebra (dev, 2º pedido). */
  fix: [path: string, before: string, after: string]
  write: [path: string, text: string]
  runner: 'vitest' | 'jest' | 'pytest'
  test: string
  suites: Array<[file: string, tests: number]>
  failing: [test: string, why: string]
  check: [command: string, output: string]
  /** Pedem permissão: construtor, azarado. */
  perms: [string, string]
  expert: { type: string; description: string; ok: boolean; result: string; grep?: [pattern: string, hit: string] }
  /** dev ×4, construtor ×3, azarado ×2, dorminhoco. */
  says: string[]
}

const KITS: Kit[] = [
  {
    project: 'agent-code',
    icon: '🚀',
    read: ['src\\cart.ts', 'export interface Item {\n  id: string\n  price: number\n  qty: number\n}\n\nexport const count = (items: Item[]): number => items.reduce((n, i) => n + i.qty, 0)'],
    edit: ['src\\total.ts', EDIT_OLD, EDIT_NEW],
    fix: ['src\\total.test.ts', '    expect(total(items, 10)).toBe(90)', '    expect(total(items, 10)).toBeCloseTo(85.5)'],
    write: ['src\\components\\Cart.tsx', WRITE_TSX],
    runner: 'vitest',
    test: 'npm test -- --run',
    suites: [['src/total.test.ts', 6], ['src/cart.test.ts', 12], ['src/api/orders.test.ts', 21]],
    failing: ['total > aplica desconto percentual', 'expected 90 to be 85.5'],
    check: ['npm run build', VITE_BUILD],
    perms: ['rm -rf dist', 'npm publish'],
    expert: { type: 'executor', description: 'implementar o cupom de desconto no checkout', ok: true, result: 'Cupom aplicado no checkout, com teste.' },
    says: [
      'Adiciona desconto percentual no total do carrinho, sem deixar o valor ficar negativo.',
      'O teste do total quebrou depois do merge. Consegue ver o que houve?',
      'Extrai o cálculo do frete pra uma função pura e cobre com teste.',
      'Escreve umas notas curtas explicando o fluxo do carrinho.',
      'Cria o componente do carrinho com o contador de itens no botão.',
      'Pede pro executor implementar o cupom de desconto no checkout.',
      'Remove os imports não usados e confere se o build continua passando.',
      'Roda os testes e, se passar, publica a versão 1.4.2 no npm.',
      'Atualiza as dependências e roda a suíte inteira.',
      'Revisa o handler de pagamentos e me diz se tem algo estranho.'
    ]
  },
  {
    project: 'loja-virtual',
    icon: svgIcon('#1f6feb', '#ffffff', 'L'),
    read: ['src\\pages\\Produto.tsx', 'export function Produto({ id }: { id: string }): JSX.Element {\n  const produto = useProduto(id)\n  return <ProductCard produto={produto} />\n}'],
    edit: ['src\\styles\\card.css', CSS_OLD, CSS_NEW],
    fix: ['src\\components\\ProductCard.test.tsx', "  expect(getByText('R$ 10')).toBeTruthy()", "  expect(getByText('R$ 10,00')).toBeTruthy()"],
    write: ['src\\components\\ProductCard.tsx', 'import { BuyButton } from \'./BuyButton\'\n\nexport function ProductCard({ produto }: { produto: Produto }): JSX.Element {\n  return (\n    <article className="card">\n      <img src={produto.foto} alt={produto.nome} />\n      <h3>{produto.nome}</h3>\n      <BuyButton produto={produto} />\n    </article>\n  )\n}'],
    runner: 'vitest',
    test: 'npm test -- --run',
    suites: [['src/components/ProductCard.test.tsx', 8], ['src/pages/Checkout.test.tsx', 14], ['src/lib/preco.test.ts', 9]],
    failing: ['ProductCard > mostra o preço formatado', 'Unable to find an element with the text: R$ 10'],
    check: ['npm run build', VITE_BUILD],
    perms: ['rm -rf dist', 'git push --force-with-lease'],
    expert: { type: 'critico', description: 'revisar o checkout antes do merge', ok: true, result: 'Aprovado, com uma ressalva no cálculo do frete.', grep: ['TODO|FIXME', 'src/pages/Checkout.tsx:88: // TODO: frete grátis acima de R$ 199'] },
    says: [
      'Deixa o card de produto com cantos arredondados e uma sombra leve.',
      'O teste do ProductCard quebrou, dá uma olhada?',
      'Mostra o preço parcelado embaixo do preço cheio.',
      'Documenta as variáveis de cor que o card usa.',
      'Cria o ProductCard reaproveitando o botão de comprar.',
      'Pede pro crítico revisar o checkout antes do merge.',
      'Tira o import que sobrou no ProductCard.',
      'Roda os testes e sobe a branch da vitrine pro remoto.',
      'Atualiza o Vite e as libs de teste.',
      'Vê se dá pra cachear as imagens dos produtos.'
    ]
  },
  {
    project: 'erp-itp',
    icon: null,
    read: ['src\\matricula\\matricula.service.ts', '@Injectable()\nexport class MatriculaService {\n  constructor(private readonly repo: MatriculaRepository) {}\n\n  async numero(ano: number): Promise<string> {\n    const seq = await this.repo.proximaSequencia(ano)\n    return `${ano}${seq}`\n  }\n}'],
    edit: ['src\\matricula\\matricula.service.ts', '    return `${ano}${seq}`', "    return `${ano}${String(seq).padStart(5, '0')}`"],
    fix: ['src\\matricula\\matricula.service.spec.ts', "    expect(await service.numero(2026)).toBe('20261')", "    expect(await service.numero(2026)).toBe('202600001')"],
    write: ['src\\financeiro\\dto\\boleto.dto.ts', 'import { IsDateString, IsPositive, IsUUID } from \'class-validator\'\n\nexport class CriarBoletoDto {\n  @IsUUID()\n  alunoId!: string\n\n  @IsPositive()\n  valor!: number\n\n  @IsDateString()\n  vencimento!: string\n}'],
    runner: 'jest',
    test: 'npx jest',
    suites: [['src/matricula/matricula.service.spec.ts', 9], ['src/financeiro/boleto.service.spec.ts', 11], ['src/auth/auth.guard.spec.ts', 4]],
    failing: ['MatriculaService › gera número com 5 dígitos', 'Expected: "202600001"  Received: "20261"'],
    check: ['npm run build', '> erp-itp@2.3.0 build\n> nest build'],
    perms: ['rm -rf dist', 'npx typeorm migration:revert'],
    expert: { type: 'navegador-de-codigo', description: 'mapear onde o boleto é gerado', ok: true, result: 'O boleto nasce em BoletoService.gerarBoleto, chamado pelo controller e pela fila.', grep: ['gerarBoleto', 'src/financeiro/boleto.service.ts:42:  async gerarBoleto(dto: CriarBoletoDto) {'] },
    says: [
      'O número de matrícula precisa ter 5 dígitos de sequência, com zero à esquerda.',
      'O teste da matrícula ficou vermelho depois da mudança, corrige?',
      'Valida o CPF do responsável antes de salvar a matrícula.',
      'Escreve um resumo do fluxo de matrícula pra equipe.',
      'Cria o DTO do boleto com validação do vencimento.',
      'Pede pro navegador de código mapear onde o boleto é gerado.',
      'Tira o import que não é mais usado no DTO do boleto.',
      'Roda os testes e reverte a última migration do banco de homologação.',
      'Atualiza o TypeORM e roda a suíte.',
      'Confere se o desconto por falta está batendo com a planilha.'
    ]
  },
  {
    project: 'portal-aluno',
    icon: '⚙️',
    read: ['src\\notas\\media.ts', 'export interface Nota {\n  valor: number\n  peso: number\n}\n\nexport function media(notas: Nota[]): number {\n  return notas.reduce((a, n) => a + n.valor, 0) / notas.length\n}'],
    edit: ['src\\notas\\media.ts', '  return notas.reduce((a, n) => a + n.valor, 0) / notas.length', '  const peso = notas.reduce((a, n) => a + n.peso, 0)\n  return Math.round((notas.reduce((a, n) => a + n.valor * n.peso, 0) / peso) * 10) / 10'],
    fix: ['src\\notas\\media.test.ts', '  expect(media(notas)).toBe(7.25)', '  expect(media(notas)).toBe(7.3)'],
    write: ['src\\components\\Boletim.tsx', "import { media } from '../notas/media'\n\nexport function Boletim({ aluno }: { aluno: Aluno }): JSX.Element {\n  return (\n    <table className=\"boletim\">\n      <tbody>\n        {aluno.disciplinas.map((d) => (\n          <tr key={d.id}>\n            <td>{d.nome}</td>\n            <td>{media(d.notas).toFixed(1)}</td>\n          </tr>\n        ))}\n      </tbody>\n    </table>\n  )\n}"],
    runner: 'vitest',
    test: 'npm test -- --run',
    suites: [['src/notas/media.test.ts', 7], ['src/components/Boletim.test.tsx', 5], ['src/api/frequencia.test.ts', 12]],
    failing: ['media > arredonda para uma casa', 'expected 7.25 to be 7.3'],
    check: ['npm run build', VITE_BUILD],
    perms: ['rm -rf dist', 'npm run deploy'],
    expert: { type: 'executor', description: 'corrigir o arredondamento da média no boletim', ok: false, result: 'Não consegui: o teste de arredondamento continua falhando.' },
    says: [
      'A média tem que ser ponderada pelo peso de cada avaliação.',
      'O teste da média quebrou com a mudança, ajusta?',
      'Mostra a frequência do aluno ao lado da média.',
      'Anota como o cálculo da média funciona agora.',
      'Monta o boletim do aluno com as notas por disciplina.',
      'Pede pro executor corrigir o arredondamento da média no boletim.',
      'Remove o import duplicado do boletim.',
      'Roda os testes e faz o deploy da versão de homologação.',
      'Atualiza o React Router e roda a suíte.',
      'Revisa o texto da tela de login.'
    ]
  },
  {
    project: 'api-pagamentos',
    icon: svgIcon('#0f9d58', '#fffbe6', '$'),
    read: ['app\\pagamentos.py', 'from fastapi import APIRouter, HTTPException\n\nrouter = APIRouter(prefix="/pagamentos")\n\n@router.post("/")\nasync def criar(p: Pagamento) -> dict:\n    if p.valor <= 0:\n        raise HTTPException(400, "valor inválido")\n    tx = await gateway.cobrar(p.cartao, p.valor)\n    return {"id": tx.id, "status": tx.status}'],
    edit: ['app\\pagamentos.py', '    if p.valor <= 0:\n        raise HTTPException(400, "valor inválido")', '    if p.valor <= 0 or p.valor > LIMITE_PIX:\n        raise HTTPException(422, "valor fora do limite")'],
    fix: ['tests\\test_pagamentos.py', '    assert r.status_code == 400', '    assert r.status_code == 422'],
    write: ['tests\\test_gateway.py', 'from unittest.mock import AsyncMock\n\nasync def test_cobranca_aprovada(client, gateway: AsyncMock):\n    gateway.cobrar.return_value = Transacao(id="tx_1", status="aprovada")\n    r = await client.post("/pagamentos/", json={"valor": 50, "cartao": "tok_visa"})\n    assert r.json() == {"id": "tx_1", "status": "aprovada"}'],
    runner: 'pytest',
    test: 'pytest',
    suites: [['tests/test_pagamentos.py', 10], ['tests/test_gateway.py', 8]],
    failing: ['test_valor_acima_do_limite', 'assert 400 == 422'],
    check: ['ruff check .', 'All checks passed!'],
    perms: ['rm -rf build', 'rm -rf .pytest_cache'],
    expert: { type: 'Explore', description: 'achar onde o webhook do gateway é tratado', ok: true, result: 'O webhook entra em app/webhooks.py (receber_evento) e confirma a cobrança.', grep: ['def receber_evento', 'app/webhooks.py:17:async def receber_evento(evento: EventoGateway):'] },
    says: [
      'Recusa pagamento acima do limite do Pix com 422.',
      'O teste do status code falhou depois disso, corrige?',
      'Loga o id da transação em toda resposta de erro.',
      'Escreve um resumo dos códigos de erro da API.',
      'Escreve os testes do gateway de cobrança.',
      'Explora o repositório e acha onde o webhook do gateway é tratado.',
      'Tira o import que sobrou no teste do gateway.',
      'Investiga por que o estorno está demorando tanto.',
      'Instala as dependências novas e roda os testes.',
      'Lista os endpoints que ainda não têm teste.'
    ]
  }
]

/** Contexto usado (fração) no começo e no fim do loop, por sala × conversa. */
const CONTEXT: Array<Array<[number, number]>> = [
  [[0.12, 0.28], [0.38, 0.5], [0.55, 0.66], [0.71, 0.71]],
  [[0.7, 0.93], [0.93, 0.95], [0.22, 0.35], [0.64, 0.64]],
  [[0.86, 0.94], [0.38, 0.47], [0.55, 0.62], [0.71, 0.71]],
  [[0.12, 0.25], [0.45, 0.58], [0.3, 0.42], [0.64, 0.64]],
  [[0.2, 0.34], [0.38, 0.49], [0.55, 0.61], [0.4, 0.4]]
]

const API_529 = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'

// ── passos ─────────────────────────────────────────────────────────────────

type P = (rel: string) => string
const base = (path: string): string => path.split(/[\\/]/).pop() ?? path
const numbered = (text: string): string => text.split('\n').map((l, i) => `${String(i + 1).padStart(6)}→${l}`).join('\n')
const say = (text: string): DemoStep => ({ do: 'answer', text })
const tool = (ms: number, name: string, input: Record<string, unknown>, result = ''): ToolStep => ({ do: 'tool', ms, name, input, result })
/** Documentação do runner de testes da sala (o dev consulta antes de escrever as notas). */
const DOCS: Record<Kit['runner'], string> = {
  vitest: 'https://vitest.dev/guide/',
  jest: 'https://jestjs.io/docs/getting-started',
  pytest: 'https://docs.pytest.org/en/stable/'
}
const bash = (ms: number, command: string, result: string, description?: string): ToolStep => tool(ms, 'Bash', description ? { command, description } : { command }, result)
const read = (k: Kit, p: P, ms: number, path = k.read[0], text = k.read[1]): ToolStep => tool(ms, 'Read', { file_path: p(path) }, numbered(text))
const edit = (p: P, ms: number, [path, before, after]: [string, string, string]): ToolStep =>
  tool(ms, 'Edit', { file_path: p(path), old_string: before, new_string: after }, `The file ${p(path)} has been updated.`)
const write = (p: P, ms: number, path: string, text: string): ToolStep => tool(ms, 'Write', { file_path: p(path), content: text }, `File created successfully at: ${p(path)}`)

function testOutput(k: Kit, cwd: string, pass: boolean): string {
  const total = k.suites.reduce((n, [, c]) => n + c, 0)
  const files = k.suites.length
  const [name, why] = k.failing
  const tally = (sep: string): string => (pass ? `${total} passed` : `1 failed${sep} ${total - 1} passed`)
  if (k.runner === 'jest') {
    return [
      ...k.suites.map(([f], i) => `${!pass && i === 0 ? 'FAIL' : 'PASS'} ${f}`),
      ...(pass ? [] : ['', `  ● ${name}`, '', `    ${why}`]),
      '',
      `Test Suites: ${pass ? `${files} passed` : `1 failed, ${files - 1} passed`}, ${files} total`,
      `Tests:       ${tally(',')}, ${total} total`,
      'Time:        3.214 s'
    ].join('\n')
  }
  if (k.runner === 'pytest') {
    const bar = (s: string): string => `${'='.repeat(18)} ${s} ${'='.repeat(18)}`
    return [
      bar('test session starts'),
      `collected ${total} items`,
      '',
      ...k.suites.map(([f, c], i) => `${f} ${!pass && i === 0 ? `${'.'.repeat(c - 1)}F` : '.'.repeat(c)}`),
      ...(pass ? [] : ['', bar('FAILURES'), `____ ${name} ____`, `E   ${why}`]),
      '',
      bar(`${tally(',')} in 0.84s`)
    ].join('\n')
  }
  return [
    ` RUN  v4.1.9 ${cwd.replace(/\\/g, '/')}`,
    '',
    ...k.suites.map(([f, c], i) =>
      !pass && i === 0 ? ` ❯ ${f} (${c} tests | 1 failed) 11ms\n   × ${name} 4ms\n     → ${why}` : ` ✓ ${f} (${c} tests) ${9 + 31 * i}ms`
    ),
    '',
    ` Test Files  ${pass ? `${files} passed` : `1 failed | ${files - 1} passed`} (${files})`,
    `      Tests  ${tally(' |')} (${total})`,
    '   Duration  1.42s'
  ].join('\n')
}

// ── roteiros ───────────────────────────────────────────────────────────────

const RETRY = 'Tenta de novo, por favor.'

function scriptsFor(k: Kit, r: number): DemoTurn[][] {
  const cwd = `C:\\demo\\${k.project}`
  const p: P = (rel) => `${cwd}\\${rel}`
  const s = k.says
  const test = (ms: number, pass: boolean): ToolStep => bash(ms, k.test, testOutput(k, cwd, pass), 'Roda os testes')
  const check = (ms: number): ToolStep => bash(ms, k.check[0], k.check[1])
  const install = (ms: number): ToolStep =>
    k.runner === 'pytest'
      ? bash(ms, 'pip install -r requirements.txt', 'Successfully installed httpx-0.27.2 pydantic-2.9.2')
      : bash(ms, 'npm install', 'added 12 packages, changed 3 packages in 9s\n\nfound 0 vulnerabilities')
  const ask = (wait: number, ms: number, command: string): DemoStep => ({ do: 'ask', wait, ms, name: 'Bash', input: { command } })
  const x = k.expert
  // A memória vai à estante de Memórias (salas 1, 3 e 5): consulta as convenções do projeto.
  const memo: DemoStep = { do: 'delegate', ms: 16_000, type: 'memoria', description: 'consultar as memórias do projeto', steps: [tool(5_000, 'mcp__memory__memory_list', {}, '3 memórias deste projeto')], ok: true, result: 'A convenção de testes está nas memórias.' }
  const expertSteps: ToolStep[] =
    x.type === 'executor'
      ? [read(k, p, 3_000), edit(p, 5_000, k.edit), test(5_000, x.ok)]
      : [tool(3_000, 'Grep', { pattern: x.grep?.[0] ?? '', path: cwd }, x.grep?.[1]), read(k, p, 4_000), check(4_000)]
  const firstLine = k.write[1].split('\n')[0]

  const dev: DemoTurn[] = [
    { at: -7_000 - r * 500, user: s[0], steps: [read(k, p, 3_000), edit(p, 8_000, k.edit), test(5_000, true), say(`Pronto: ${base(k.edit[0])} atualizado e os testes passaram.`)] },
    // A TV da sala de reunião: a loja testada no navegador (sala 2) e o app no Android (sala 4).
    ...(r === 1 ? [browserTurn(10_000)] : r === 3 ? [androidTurn(9_000, cwd)] : []),
    // Nas salas 1 e 3 ele consulta a memória antes (vai à estante) e grava uma lição (a folha no fichário).
    // Não nas 2 e 4: quem ainda está testando na TV fica na sala de reunião (ela vem antes da estante).
    { at: 24_000 + r * 1_100, user: s[1], steps: [...(r === 0 || r === 2 ? [tool(3_000, 'mcp__memory__memory_list', {}, '3 memórias deste projeto'), tool(3_000, 'mcp__memory__memory_propose', { op: 'create', title: 'Testes antes do commit' }, 'Proposta registrada.')] : []), test(5_000, false), read(k, p, 2_500, k.fix[0], k.fix[1]), edit(p, 3_000, k.fix), test(4_500, true), say(`O teste esperava o valor antigo. Ajustei ${base(k.fix[0])} e a suíte voltou a passar.`)] },
    { at: 60_000 + r * 1_100, user: s[2], steps: [...(r % 2 === 0 ? [memo] : []), read(k, p, 2_500), edit(p, 4_000, k.edit), test(5_000, true), say(`Feito, mudança em ${base(k.edit[0])} coberta por teste.`)] },
    {
      at: 92_000 + r * 1_100,
      user: s[3],
      steps: [
        read(k, p, 3_000),
        tool(3_000, 'WebFetch', { url: DOCS[k.runner], prompt: 'Como a documentação sugere descrever a suíte de testes' }, 'A documentação sugere um parágrafo por suíte e o comando para rodar.'),
        write(p, 4_000, 'docs\\NOTAS.md', `# ${k.project}\n\n- ${s[3]}\n- Testes: \`${k.test}\`\n`),
        say('Escrevi docs/NOTAS.md com o resumo.')
      ]
    }
  ]
  const builder: DemoTurn[] = [
    { at: -5_000 - r * 600, user: s[4], steps: [read(k, p, 2_000), write(p, 6_000, ...k.write), check(4_000), ask(6_000, 1_000, k.perms[0]), check(4_000), say(`Criei ${base(k.write[0])}; o build passou depois de limpar a saída antiga.`)] },
    {
      at: 34_000 + r * 1_300,
      user: s[5],
      steps: [read(k, p, 2_000), { do: 'delegate', ms: 18_000, type: x.type, description: x.description, steps: expertSteps, ok: x.ok, result: x.result }, say(x.ok ? `${x.type} terminou: ${x.result}` : `${x.type} não conseguiu: ${x.result}`)]
    },
    { at: 80_000 + r * 1_000, user: s[6], steps: [tool(2_500, 'Grep', { pattern: firstLine, path: cwd }, `${k.write[0].replace(/\\/g, '/')}:1:${firstLine}`), edit(p, 3_500, [k.write[0], `${firstLine}\n`, '']), check(4_000), say('Limpo, e o build continua passando.')] },
    // O mockup e o chamado (salas 1 e 3), com a luz de volta: dois chamados, o 2º espera sentado ("+1 esperando").
    ...(r === 0 ? [mockupTurn(93_000, cwd, 'vitrine.html', 'Fiz a vitrine nova — dá uma olhada?')] : r === 2 ? [mockupTurn(95_000, cwd, 'cadastro.html', 'O cadastro ficou assim, aprova?')] : [])
  ]
  // Azarado: permissão → erro da API → nova tentativa. Sala 3 estoura o limite; sala 4 trava.
  const unlucky: DemoTurn[] =
    r === 4
      ? [
          { at: -80_000, user: s[7], steps: [read(k, p, 2_000), { do: 'stall', ms: 128_000, flagAfter: 60_000 }, edit(p, 4_000, k.edit), ask(5_000, 1_000, k.perms[1]), test(4_000, true), say('O estorno esperava o gateway sem timeout; agora responde em 2 s.')] },
          { at: 84_000, user: s[8], steps: [install(4_000), { do: 'fail', text: 'Agent stopped: Error: read ECONNRESET' }] }
        ]
      : [
          { at: -9_000, user: s[7], steps: [test(8_000, true), ask(7_000, 2_000, k.perms[1]), say('Testes verdes e feito.')] },
          { at: 28_000 + r * 1_200, user: s[8], steps: [install(4_000), { do: 'fail', text: API_529 }] },
          r === 3
            ? { at: USAGE_OUT_AT - 5_000, user: RETRY, steps: [read(k, p, 2_000), test(3_000, true), { do: 'limit', ms: USAGE_BACK_AT - USAGE_OUT_AT, text: 'Claude AI usage limit reached' }, test(4_000, true), say('Voltei depois do limite: testes passando.')] }
            : { at: 60_000 + r * 1_000, user: RETRY, steps: [read(k, p, 2_000), test(4_000, true), say('Agora foi: testes passando.')] }
        ]
  const sleeper: DemoTurn[] = [{ at: -(22 + 2 * r) * 60_000, user: s[9], steps: [read(k, p, 2_000), say('Dei uma olhada: está tudo certo, deixei duas sugestões no fim do arquivo.')] }]
  return [dev, builder, unlucky, sleeper]
}

let scripts: DemoTurn[][][] | null = null
/** Roteiros por sala × conversa (montados na 1ª chamada, não no import). */
export function demoScripts(): DemoTurn[][][] {
  return (scripts ??= KITS.map(scriptsFor))
}

export function demoFeed(now?: number): OfficeFeed {
  const clock = now ?? Date.now()
  const t = now === undefined ? 0 : ((now % DEMO_LOOP_MS) + DEMO_LOOP_MS) % DEMO_LOOP_MS
  const cycle = now === undefined ? 0 : Math.floor(now / DEMO_LOOP_MS)
  const start = clock - t
  const conversations: Conversation[] = []
  const busyIds = new Set<string>()
  const busySince: Record<string, number> = {}
  const permissions: Record<string, PermissionRequest> = {}
  const stalledSince: Record<string, number> = {}
  const tracks: Record<string, TrackMap> = {}
  const projectIcons: Record<string, string | null> = {}
  const model = 'claude-opus-4-5'
  const limit = contextLimitFor(model)
  demoScripts().forEach((room, r) => {
    const cwd = `C:\\demo\\${KITS[r].project}`
    projectIcons[cwd] = KITS[r].icon
    room.forEach((turns, i) => {
      const id = `demo-${r}-${i}`
      const st = playScript(turns, t, start, id, cycle)
      const [u0, u1] = CONTEXT[r][i]
      conversations.push({
        id,
        title: `Demo ${r + 1}.${i + 1}`,
        cwd,
        model,
        sdkSessionId: null,
        messages: st.messages,
        tokens: { context: Math.round(limit * (u0 + ((u1 - u0) * t) / DEMO_LOOP_MS)), output: 0, cost: 0 },
        createdAt: start - 2 * 3_600_000,
        updatedAt: st.updatedAt,
        ...(st.recovery ? { recovery: st.recovery } : {})
      })
      if (st.busy) busyIds.add(id)
      if (st.busySince !== null) busySince[id] = st.busySince
      if (st.permission) permissions[id] = st.permission
      if (st.stalledSince !== null) stalledSince[id] = st.stalledSince
      if (Object.keys(st.tracks).length > 0) tracks[id] = st.tracks
    })
  })
  // A Central, no console do centro: a última mensagem que ela despachou.
  const central = playScript([{ at: -40_000, user: 'Roda os testes da loja e me avisa.', steps: [say('Mandei para loja-virtual, na conversa Demo 2.1.')] }], t, start, CENTRAL_ID, cycle)
  // Os despachos dela (demoCentral.ts): o pulso corre do console até o destino.
  conversations.push({ id: CENTRAL_ID, title: 'Central', cwd: '', mode: 'central', model, sdkSessionId: null, messages: central.messages, tokens: { context: 0, output: 0, cost: 0 }, createdAt: start - 3_600_000, updatedAt: central.updatedAt, central: demoCentralState(t, start, cycle, (r) => `C:\\demo\\${KITS[r].project}`) })
  // O Manager do plano do checkout: senta à cabeceira; a TV pinta o resumo (demoPlan.ts).
  const plan = demoPlanConversation(t, start, cycle, `C:\\demo\\${KITS[1].project}`, model)
  conversations.push(plan.conv)
  if (plan.busy) busyIds.add(plan.conv.id)
  if (plan.busySince !== null) busySince[plan.conv.id] = plan.busySince
  const usageLimits: Record<string, RateLimitStatus> = { five_hour: demoUsage(t, start, clock) }
  return {
    conversations,
    activeId: conversations[0].id,
    busyIds,
    busySince,
    permissions,
    vigiaAlerts: {},
    vigiaAt: {},
    poDiagnostics: {},
    memoristaDiagnostics: {},
    observersOn: { po: false, vigia: false, memorista: false },
    stalledSince,
    tracks,
    projectIcons,
    usageLimits
  }
}
