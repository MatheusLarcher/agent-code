<!-- prompt 1 -->
# Handoff — Commit no fim do fluxo de code review

Projeto: `D:\agent-code-replay\s1\agent-code` (Electron + React + TypeScript; branch atual `master`).
Planejamento (consulta, **não replaneje**): `D:\agent-code-replay\runs\s1-hoje-r1\agent-code\planning\agent-code\plano-20261009-1402`. Os cards citados abaixo estão lá; se algo aqui parecer contraditório com um card, o card vale, e você pergunta ao usuário antes de inventar uma terceira via.

## Objetivo

Hoje o botão de code review do Composer (ícone escudo) só **revisa**: envia `/code-review` sem `--fix`. O usuário quer que **um clique** faça tudo: revisar → corrigir os achados confirmados → rodar os checks do projeto → **criar um commit local**, e que **não** commite quando não deve (diff vazio, achado em aberto, check falhando), dizendo o motivo.

Isso é feito com uma flag nova `--commit` na skill `code-review`, ligada **só** pelo botão. Quem digita `/code-review` à mão (e o subagente crítico do PO, que tem a skill pré-carregada) continua com o comportamento de hoje.

## Antes de tudo: declare o plano

Declare as etapas como plano com TodoWrite (ou TaskCreate), **na ordem abaixo**, cada item começando pelo id da etapa entre colchetes:

- `[regras-commit] Ler e assimilar as regras do commit automático`
- `[skill-flag-commit] Adicionar a flag --commit à skill code-review`
- `[botao-envia-flags] Botão envia /code-review --fix --commit; título e teste`
- `[validacao] Validar: typecheck + testes + app real com diff real`

## Prazo e medição de tempo (obrigatório, sem exceção)

- **Ao começar cada etapa:** registre a sua estimativa com `mcp__entregas__entrega_estimar` e escreva no chat:
  `Etapa N — <título>: estimativa do plano X min (prazo), minha estimativa Z min`
- **Ao concluir cada etapa:** consulte `mcp__entregas__entrega_tempo` e escreva:
  `levou Y min de trabalho (dentro/fora do prazo)` — e, se passou do prazo, o motivo.
- O prazo é a estimativa do plano; a sua não o muda. O tempo que vale é o medido pelo app.

| # | Etapa (id) | Estimativa do plano (min de trabalho do agente) |
|---|---|---|
| 1 | `regras-commit` — Fechar as regras do commit automático (já especificada: ler e assimilar) | 2 |
| 2 | `skill-flag-commit` — Flag `--commit` na skill `.agents/skills/code-review/SKILL.md` | 8 |
| 3 | `botao-envia-flags` — Botão envia `/code-review --fix --commit`; título e teste do ChatPanel | 5 |
| 4 | `validacao` — typecheck + testes + app real clicando no botão | 20 |
| | **Total deste prompt** | **35** |

## Etapas, na ordem, com os cards

### Etapa 1 — `regras-commit` (2 min) — já especificada, só ler

Cards: [[Estado atual do botão de code review]], [[O botão deve corrigir sozinho antes de commitar?]], [[Quando NÃO commitar]], [[O que entra no commit e como]].

**Estado atual (nota, verificado no código):**
- `src/renderer/src/components/Composer.tsx:1297` — `onClick={() => props.onSend('/code-review', [], [], [])}`; linha 1299: `title="Revisar código (chama a skill code-review)"`.
- A skill vive versionada em `.agents/skills/code-review/SKILL.md` (73 linhas; já tem `--comment` e `--fix` no "Step 4 — Optional flags"). O app a copia para o cache/raiz global de skills → ela vale para **todos os projetos** do usuário (inclusive outros, como o ERP ITP).
- A mesma skill é pré-carregada no subagente crítico: `src/main/agents/specialists.ts:157` (`skills: ['code-review']`), que tem `Bash` e é proibido de alterar código.
- Teste que fixa o comando enviado: `src/renderer/src/components/ChatPanel.comment.test.tsx:314-318` (`getByTitle(/Revisar código/)` e `toHaveBeenCalledWith('/code-review', [], [], [])`).

Nada a implementar nesta etapa: confirme que entendeu as regras abaixo e siga.

### Etapa 2 — `skill-flag-commit` (8 min)

Card: [[Commit como flag --commit, ligado só pelo botão]] (decisão) + requisitos [[Quando NÃO commitar]] e [[O que entra no commit e como]].

Arquivo: `.agents/skills/code-review/SKILL.md` (editar **só** a fonte versionada; não edite cópias em cache nem em `~/.claude/skills`).

O que fazer:
1. Acrescentar `--commit` ao "Step 4 — Optional flags" (e mencioná-la na `description` do frontmatter, ao lado de `--comment`/`--fix`), como um **passo final** que roda depois do report e do `--fix`.
2. Deixar explícito: `--commit` só vale quando **passada explicitamente** nos argumentos. Nunca inferir commit de frases como "revisar antes de commitar", nem quando a skill roda dentro de um subagente de revisão. Sem `--commit`, o comportamento é **exatamente** o de hoje.
3. Texto **genérico** (a skill é global): os checks e as regras de commit vêm do AGENTS.md/CLAUDE.md do projeto revisado, não do agent-code.
4. Gates — o commit só acontece se **tudo** for verdade; senão **não commita e diz o motivo** (o usuário decide):
   1. Há diff para commitar. Diff vazio ou trivial → sem commit, com aviso de que não havia nada.
   2. Todo achado confirmado foi corrigido. Se algum ficou em aberto → avisa e não commita (alinhado ao Step 3 da skill). Consequência: `--commit` sem `--fix` com achados confirmados não commita.
   3. Depois das correções, passaram os checks que o projeto exige antes de commitar, conforme o AGENTS.md/CLAUDE.md dele. No agent-code isso é **`npm run typecheck` + `npm test` + `npm run build`** (o build inclui o binário .NET). O usuário aceitou o custo de tempo.
   - Sem achados, ainda vale: diff não vazio + checks verdes → commita.
5. O que entra e como (card [[O que entra no commit e como]]):
   - Entra o **diff revisado inteiro** (o trabalho + as correções), não só as correções.
   - Stage por **caminho explícito** dos arquivos revisados; **nunca** `git add -A` / `git add .` (outros agentes podem estar mexendo no mesmo projeto). **Nunca** `.env`, credenciais ou segredos.
   - Mensagem em **Conventional Commits**, no idioma do histórico do repo (no agent-code: português, ex.: `fix(codex): …`).
   - **Sem** trailer `Co-Authored-By`, salvo se o `.claude/settings.json` do projeto pedir (`attribution.commit`).
   - Commit no branch atual; **sem push**, sem criar branch.
   - Ao final, mostrar o hash e a mensagem do commit (ou o motivo de não ter commitado).
6. Manter o arquivo curto e no estilo atual (inglês, seções enxutas). Limite do projeto: arquivos < 500 linhas.

### Etapa 3 — `botao-envia-flags` (5 min)

Card: [[Botão envia /code-review --fix --commit]] (requisito). Ambiguidade resolvida: [[O botão deve corrigir sozinho antes de commitar?]].

- `src/renderer/src/components/Composer.tsx:1297`: trocar `'/code-review'` por `'/code-review --fix --commit'`.
- `title` (linha 1299): deixar claro que também corrige e commita, ex.: `"Revisar, corrigir e commitar (skill code-review)"`. Se houver `aria-label` equivalente, alinhar.
- `src/renderer/src/components/ChatPanel.comment.test.tsx:314-319`: ajustar o regex do `getByTitle` e o `toHaveBeenCalledWith('/code-review --fix --commit', [], [], [])`. **Manter** o que o teste protege: o trecho comentado **não** vai junto e continua no campo. Atualize também o nome do `it(...)` se citar o comando.
- Não precisa de parser novo: o texto chega ao SDK como slash command com args (`src/main/agentSession.ts:1371-1372` só detecta o `/` inicial).

### Etapa 4 — `validacao` (20 min)

Card: [[Critérios de aceite do commit automático]].

Ver "Critérios de aceite" abaixo. DoD do usuário: typecheck/teste verde **não** é pronto — é preciso rodar o app e exercitar o fluxo real, inclusive os casos de não-commit.

## Requisitos (resumo)

- Botão envia `/code-review --fix --commit` e o título diz que corrige e commita.
- Skill ganha `--commit` com os 3 gates, stage por caminho explícito, Conventional Commits no idioma do repo, sem `Co-Authored-By`, sem push.
- Sem `--commit` a skill não muda de comportamento.

## Decisões (com o porquê)

- **Commit como flag `--commit`, ligado só pelo botão** (decisão do usuário, 09/10/2026). Porquê: (a) a skill é pré-carregada no subagente crítico (`src/main/agents/specialists.ts:157`), que tem `Bash` — com commit padrão ele passaria a commitar ao revisar tarefas do PO; (b) a skill é global e usada em outros projetos: quem digita `/code-review` à mão não espera um commit.
- **Gates aprovados pelo usuário** (09/10/2026), incluindo rodar **typecheck + test + build** no agent-code antes de commitar, apesar do custo de tempo — porque é a regra do AGENTS.md ("verify the build before committing").

## Ambiguidades resolvidas

- **[[O botão deve corrigir sozinho antes de commitar?]]** → leitura A (usuário, 09/10/2026): um clique faz tudo — revisa, corrige os achados confirmados, roda os checks e commita. A leitura B (botão só revisa e o commit vem depois) foi descartada porque o botão não controla o turno seguinte. O risco (corrigir sem aprovar achado por achado) é pequeno no esforço padrão `medium`, que só reporta achados de alta confiança, e o commit é local e reversível (`git reset HEAD~1`).

## Sugestões

Nenhuma sugestão aberta neste plano.

## Ponto em aberto (siga o padrão, não replaneje)

- O card [[O que entra no commit e como]] está com status **"proposto (padrão)"** — não foi confirmado explicitamente pelo usuário, mas a etapa de regras foi fechada. Siga-o como está. Se o usuário vetar algo dele durante a conversa, a palavra dele vale.

## Riscos

1. **Provedor GPT/Codex:** conferir se o slash command com args (`/code-review --fix --commit`) chega à skill do mesmo jeito que no Claude. Se não chegar, **relate** ao usuário com a evidência; não invente um caminho alternativo sem perguntar.
2. **Cache da skill:** o app só recarrega a skill quando a versão da fonte muda (`managedSkillSourceVersion`, `src/main/agentSession.ts:682`; sincronização em `synchronizeManagedSkills`, linhas 1843-1858). Confirmar que a versão editada é a que roda.
3. **Subagente crítico:** a skill nova não pode levar o crítico a commitar. O texto da flag precisa ser inequívoco (só com `--commit` explícito).
4. **Não poluir o histórico do agent-code nem o trabalho de outros agentes:** para os cenários com commit de teste, prefira um **repositório descartável** (git init numa pasta temporária, com um AGENTS.md mínimo declarando os checks, ex.: um `npm test` que você consiga fazer falhar). Se testar dentro do agent-code, faça num **git worktree** descartável e nunca deixe commit de teste no `master`. Não use `git stash/reset/checkout/clean` sobre mudanças que não são suas.
5. **App em uso:** o usuário roda o app de onde esta conversa vem. Para validar, suba uma **instância de dev separada** (script do `package.json`); não feche nem reinicie a instância dele.
6. **Commit da própria implementação:** não commite estas mudanças nem dê push sem o usuário pedir.

## Critérios de aceite

1. `npm run typecheck` e `npm test` verdes (e `npm run build` verde antes de qualquer commit da implementação, se o usuário pedir commit).
2. App rodando, diff real com um bug plantado, clique no botão: a skill revisa, corrige, roda os checks do projeto (no agent-code: typecheck + test + build) e cria **um** commit local. `git log -1` mostra mensagem Conventional Commits em português e **sem** `Co-Authored-By`. Nada de push.
3. Check falhando (ex.: erro de tipo que a correção não resolve): **nenhum commit**, e a resposta diz o motivo.
4. Diff vazio, clique no botão: nenhum commit, com aviso de que não havia nada.
5. Arquivo não relacionado/não rastreado fora do escopo (ex.: `.env` de teste): **não** entra no commit.
6. `/code-review` digitado à mão (sem `--commit`): comportamento igual ao de hoje, sem commit.
7. A skill atualizada chega ao cache: depois de editar `.agents/skills/code-review/SKILL.md`, o app recarrega a versão nova (`managedSkillSourceVersion`).
8. Risco 1 (GPT/Codex) conferido e relatado.

Se algum critério não puder ser validado de fato, diga isso explicitamente — não afirme que funciona.

## Regras do projeto (AGENTS.md) que valem aqui

- Rodar typecheck e testes depois das mudanças; verificar o build antes de commitar.
- Nunca commitar segredos, credenciais ou `.env`.
- Nunca adicionar `Co-Authored-By` (o `.claude/settings.json` não define `attribution.commit`).
- Arquivos < 500 linhas; arquivos de trabalho fora da raiz.

## Mídias

O plano não tem mídias anexadas.
