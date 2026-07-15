# Progresso visual (TodoWrite) fixo sobre a composer

## Objetivo

Hoje, quando o agente usa a ferramenta `TodoWrite` (o mecanismo nativo do Claude Code pra
planejar/rastrear passos de uma tarefa complexa), ela aparece no chat como mais um `ToolCard`
cinza igual a `Bash`/`Read`/`Edit` — a lista de tarefas fica escondida dentro do JSON de input,
só visível se o usuário clicar pra expandir o card. O usuário quer que esse plano apareça de
forma visível e bonita: um card fixo, centralizado, em cima da caixa de mensagem, mostrando o
progresso ao vivo.

## Formato do `TodoWrite` (SDK)

Confirmado em `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:729`:

```ts
interface TodoWriteInput {
  todos: { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }[]
}
```

O agente manda a lista **inteira** a cada mudança de status (ex: chama de novo com todos os
itens quando um passa de `pending` pra `in_progress`) — não incrementos.

## Regra central: um plano vivo por conversa, não um card por chamada

Cada chamada de `TodoWrite` **substitui** o plano da conversa em vez de empilhar um novo card —
é um único checklist que se atualiza ao vivo, não vários cards quase idênticos se acumulando no
histórico.

- `Conversation` (`src/renderer/src/types.ts:49`) ganha um campo opcional `todoPlan?: TodoPlan`,
  no mesmo padrão de `recovery?: TurnRecovery` — persiste com a conversa (sobrevive a reload e
  troca de aba).
- `reduceMessages` (`src/renderer/src/App.tsx:133`) ganha um desvio: quando o evento é
  `tool-use` com `name === 'TodoWrite'`, em vez de deixá-lo virar mais uma entrada em
  `messages` (hoje cai no fallback `return [...prev, e as UIMessage]`, linha 164), ele NÃO entra
  na lista de mensagens — vira só uma atualização do `todoPlan` da conversa (chamada em
  `onEvent`, `App.tsx:341-370`, ao lado de onde `reduceMessages` já é chamado).
- Isso corrige de vez o card genérico e cinza que já existia (o usuário pediu pra "aproveitar
  pra melhorar o código" — este é o ponto onde a chamada de `TodoWrite` deixa de poluir o feed
  de mensagens com um card que nunca agregou valor ali).

```ts
interface TodoPlan {
  items: { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }[]
  /** false depois que o turno termina (result/error) — recolhe o card automaticamente. */
  active: boolean
}
```

## Componente: `TodoPlanCard`

Novo componente, renderizado em `ChatPanel.tsx` no mesmo lugar do `working-banner` atual
(`ChatPanel.tsx:300-307`) — fixo, centralizado, logo acima da composer.

**Fechado (estado padrão enquanto ativo):**
- Anel giratório (reaproveita o mesmo spinner do `working-banner`/`.working-ring`).
- Título: a tarefa `in_progress` atual, via `activeForm` (ex: "Corrigindo a validação").
- Fileira de pontinhos — um por item: verde (`completed`), laranja com leve pulso
  (`in_progress`), cinza (`pending`). Visualmente no mesmo espírito do `QuestionMap` já existente
  (`src/renderer/src/components/QuestionMap.tsx`), reaproveitando a ideia de marcador compacto
  em vez de inventar um padrão novo.
- Badge com contagem (`2/5`).
- Clique no cabeçalho expande.

**Aberto:** lista completa por baixo do cabeçalho — cada item com check (✓ verde se completed,
anel destacado se in_progress, contorno cinza se pending) + `content` (resumido, sem detalhe
técnico, conforme já validado).

**Ao concluir o turno** (evento `result` ou `error` chega, `active` vira `false`): o spinner
para (vira ✓ estático se todos completed, ou some se o turno terminou com itens ainda
pendentes/incompletos — ex: interrompido), e o card recolhe para um resumo (`5/5 concluído`),
permanecendo visível e clicável pra reabrir — nunca some da tela.

## Persistência e limpeza

- `todoPlan` é salvo/restaurado junto com o resto da `Conversation` (o mecanismo de persistência
  já existente não muda — é só mais um campo).
- Uma nova mensagem do usuário (novo turno) **não limpa** o `todoPlan` anterior automaticamente
  — ele só é substituído quando o agente chamar `TodoWrite` de novo. Se o agente nunca usar
  `TodoWrite` numa tarefa simples, nenhum card aparece (comportamento hoje já é assim: card só
  aparece se a ferramenta for chamada).

## Validação

- Disparar uma tarefa complexa que o agente naturalmente planeja com `TodoWrite` (ex: pedir uma
  refatoração em vários arquivos) → card aparece fixo acima da composer, fechado, mostrando a
  tarefa atual + pontinhos.
- Conforme o agente avança (`TodoWrite` chamado de novo com itens atualizados) → o MESMO card
  atualiza (não duplica), pontinho novo fica laranja, anterior fica verde.
- Clicar no card → expande mostrando a lista completa com o texto de cada item.
- Turno termina com tudo `completed` → card recolhe pra "N/N concluído", continua clicável.
- Turno termina (usuário interrompe) com itens ainda pendentes → card recolhe mesmo assim,
  refletindo o estado parcial.
- Reload do app / trocar de conversa e voltar → o card do plano da conversa persiste como
  estava.
- Nenhuma chamada de `TodoWrite` na tarefa → nenhum card aparece, chat idêntico ao
  comportamento atual.
- `TodoWrite` não aparece mais como card cinza solto na lista de mensagens.
