import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AgentCrew } from './AgentCrew'
import { CrewChip } from './CrewChip'
import type { CrewMember } from '../crew'

/**
 * Prova visual do elenco: renderiza o COMPONENTE REAL com o mesmo instante do
 * mockup e grava `mockups/_preview-equipe.html`, que carrega o `styles.css` do
 * app. Abrindo os dois lado a lado dá para comparar de verdade — um teste de
 * DOM diz que a classe existe, não que a tela ficou igual.
 *
 * Rode com: npx vitest run src/renderer/src/components/AgentCrew.preview.test.tsx
 */

afterEach(cleanup)

const T = Date.now()
const s = (n: number): number => T - n * 1000

const CREW: CrewMember[] = [
  {
    id: 'role:principal',
    role: 'principal',
    name: 'Principal',
    kind: 'supervisor',
    state: 'working',
    line: [
      { kind: 'text', text: 'delegando · ' },
      { kind: 'tool', text: 'Agent' },
      { kind: 'text', text: ' → critico' }
    ],
    startedAt: s(96),
    stepCount: 18,
    group: 'conversa'
  },
  {
    id: 'role:executor',
    role: 'executor',
    name: 'executor',
    kind: 'tarefa 8677ee2e',
    state: 'working',
    line: [
      { kind: 'tool', text: 'Edit' },
      { kind: 'text', text: ' src/main/po/po.ts ' },
      { kind: 'add', text: '+18' },
      { kind: 'text', text: ' ' },
      { kind: 'del', text: '−4' }
    ],
    startedAt: s(71),
    stepCount: 9,
    group: 'conversa',
    steps: [
      { id: 's1', name: 'Read', input: { file_path: 'src/main/observerQuery.ts' }, startedAt: s(70), endedAt: s(66) },
      { id: 's2', name: 'Edit', input: { file_path: 'src/shared/ipc.ts' }, startedAt: s(66), endedAt: s(64) },
      { id: 's3', name: 'Bash', input: { command: 'npx vitest run po.test.ts' }, startedAt: s(22) }
    ]
  },
  {
    id: 'role:critico',
    role: 'critico',
    name: 'critico',
    kind: 'review',
    state: 'working',
    line: [
      { kind: 'text', text: 'começou agora · ' },
      { kind: 'tool', text: 'task_get' }
    ],
    startedAt: s(2),
    stepCount: 1,
    group: 'conversa'
  },
  {
    id: 'role:navegador-de-codigo',
    role: 'navegador-de-codigo',
    name: 'navegador-de-codigo',
    state: 'idle',
    line: [{ kind: 'text', text: 'terminou · 3 arquivos, resposta em caminho:linha' }],
    endedAt: s(120),
    badge: { text: 'pronto', tone: 'ok' },
    group: 'conversa'
  },
  {
    id: 'role:memoria',
    role: 'memoria',
    name: 'memoria',
    state: 'idle',
    line: [{ kind: 'text', text: 'parado' }],
    badge: { text: 'disponível', tone: 'plain' },
    group: 'conversa'
  },
  {
    id: 'role:vigia',
    role: 'vigia',
    name: 'vigia',
    kind: 'observador',
    state: 'asking',
    line: [{ kind: 'text', text: '1 dúvida esperando você' }],
    endedAt: s(40),
    badge: { text: 'responder', tone: 'warn' },
    group: 'observadores'
  },
  {
    id: 'role:po',
    role: 'po',
    name: 'PO',
    kind: 'auditor do quadro',
    state: 'idle',
    line: [{ kind: 'text', text: 'auditou no fim do turno · 2 cartões corrigidos' }],
    endedAt: s(60),
    badge: { text: 'gpt-5.6-luna', tone: 'ok' },
    group: 'observadores'
  }
]

describe('AgentCrew — prova visual', () => {
  it('gera mockups/_preview-chip-chat.html — o chip no lugar novo, sobre o composer', () => {
    const { container } = render(
      <CrewChip working={CREW.filter((m) => m.state === 'working')} onOpen={() => undefined} />
    )
    expect(container.querySelectorAll('.crew-mini')).toHaveLength(3)

    const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>Chip do elenco — acima do composer</title>
<link rel="stylesheet" href="../src/renderer/src/styles.css" />
<style>
  body { margin: 0; padding: 28px; background: #171615; }
  h1 { font: 600 18px var(--font); color: var(--text); margin: 0 0 4px; }
  p.lead { font: 14px var(--font); color: var(--muted); margin: 0 0 22px; }
  .chat {
    width: 720px; background: var(--bg); border: 1px solid var(--line);
    border-radius: 14px; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px;
  }
  .bubble { align-self: flex-end; background: var(--bg-3); border-radius: 12px;
            padding: 10px 13px; font: 13px var(--font); color: var(--text); max-width: 70%; }
  .composer-bar { border: 1px solid var(--line); background: var(--bg-2); border-radius: 12px;
                  padding: 11px 13px; color: #6f6c68; font: 13px var(--font); }
</style>
</head>
<body>
<h1>Chip do elenco — agora acima da barra de digitação</h1>
<p class="lead">Saiu da topbar. Aparece só quando alguém está trabalhando.</p>
<div class="chat">
  <div class="bubble">revisa o diff e fecha a tarefa</div>
  ${container.innerHTML}
  <div class="composer-bar">Escreva uma mensagem…</div>
</div>
</body>
</html>`
    writeFileSync(resolve(process.cwd(), 'mockups/_preview-chip-chat.html'), html, 'utf8')
  })

  it('gera mockups/_preview-equipe.html a partir do componente real', () => {
    const { container } = render(<AgentCrew crew={CREW} />)

    // O que a comparação precisa provar antes de virar imagem.
    expect(container.querySelectorAll('.crew-agent').length).toBe(7)
    expect(container.querySelectorAll('.crew-agent.working').length).toBe(3)
    expect(container.querySelectorAll('.crew-agent.idle').length).toBe(3)
    expect(container.querySelectorAll('.crew-agent.asking').length).toBe(1)
    expect(container.querySelector('.crew-agent.just-started')).toBeTruthy()
    expect(container.querySelectorAll('.crew-step').length).toBe(3)

    const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>Implementação — Equipe de agentes</title>
<link rel="stylesheet" href="../src/renderer/src/styles.css" />
<style>
  /* Só a moldura do preview. Tudo dentro de .pane vem do styles.css do app. */
  body { margin: 0; padding: 28px; background: #171615; }
  h1 { font: 600 18px var(--font); color: var(--text); margin: 0 0 4px; }
  p.lead { font: 14px var(--font); color: var(--muted); margin: 0 0 22px; }
  .pane {
    width: 430px; height: 720px; display: flex; flex-direction: column;
    background: var(--bg); border: 1px solid var(--line); border-radius: 14px; overflow: hidden;
  }
</style>
</head>
<body>
<h1>Implementação — aba Agentes → Equipe</h1>
<p class="lead">Componente <code>AgentCrew</code> real, com o <code>styles.css</code> do app.</p>
<div class="pane">${container.innerHTML}</div>
</body>
</html>`
    writeFileSync(resolve(process.cwd(), 'mockups/_preview-equipe.html'), html, 'utf8')
  })
})
