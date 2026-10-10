<!-- prompt 1 -->
# Handoff — Commit no fim do fluxo de code review (prompt 1 de 1)

## Arquivos

### Ler antes de começar
- `AGENTS.md` — checks exigidos antes de commitar neste projeto (`npm run typecheck`, `npm test`, `npm run build`, que inclui o binário .NET) e a regra de não pôr `Co-Authored-By`.
- `.agents/skills/code-review/SKILL.md` — a skill inteira (73 linhas): `description` do frontmatter (:3-9), Step 3 Report com o aviso de achados em aberto antes de commit (:50-58), Step 4 com as flags `--comment`/`--fix` (:60-66), Rules com "diff vazio ou trivial" (:68-73).
- `src/renderer/src/components/Composer.tsx:1295-1302` — o botão de escudo: `onClick={() => props.onSend('/code-review', [], [], [])}` e `title="Revisar código (chama a skill code-review)"`.
- `src/renderer/src/components/ChatPanel.comment.test.tsx:314-320` — o teste que acha o botão por `getByTitle(/Revisar código/)`, confere a string enviada e garante que o trecho comentado continua no campo.
- `src/main/agents/specialists.ts:150-159` — o subagente `critico` pré-carrega `skills: ['code-review']` (tem `Bash`, não pode mexer no código): é o motivo de o commit ser opt-in.
- `src/main/agentSession.ts:1371-1377` — texto que começa com `/` é tratado como slash command; não há parser de args (não precisa de um).
- `src/main/agentSession.ts:1843-1858` (campo em :682) — `synchronizeManagedSkills`: compara o digest de `.agents/skills` (`managedSkillsFilesystemVersion`, `src/main/skillManager.ts:88-89`) com `managedSkillSourceVersion` e recopia a skill para o cache no próximo envio. É assim que a skill editada chega às conversas.
- `src/main/index.ts:2272-2273` — `requestSingleInstanceLock()`: uma segunda instância do app com o mesmo userData fecha na hora (importa na validação).
- `docs/ARQUITETURA.md:1799` e `docs/REFERENCIA.md:252` — descrevem a skill (`--fix`) e o atalho do botão como `props.onSend('/code-review', [], [])`.

### Editar/criar
- `.agents/skills/code-review/SKILL.md` — flag `--commit` no `description` e no Step 4; seção nova de commit (gates + o que entra + mensagem); regra "sem `--commit`, nunca commita". Em inglês, como o resto do arquivo.
- `src/renderer/src/components/Composer.tsx` (:1297 e :1299) — a string enviada passa a `'/code-review --fix --commit'`, e o `title` diz que o botão também corrige e commita.
- `src/renderer/src/components/ChatPanel.comment.test.tsx` (:314-319) — nome do teste, regex do `getByTitle` e `toHaveBeenCalledWith`.
- `docs/ARQUITETURA.md:1799` e `docs/REFERENCIA.md:252` — atualizar a descrição da skill (`--commit`) e do botão (envia `/code-review --fix --commit`). Isso não está nos cards: é do Manager, só para a doc não ficar desatualizada.

**Abra TODOS os arquivos de "Ler antes de começar" numa única resposta, com as leituras em paralelo. Não reexplore o que a lista cobre; use Grep/Glob só para o que faltar. As linhas são pista: o código pode ter mudado desde o planejamento.**

## Objetivo

Hoje o botão de escudo do Composer só **revisa** o diff (`/code-review`, sem `--fix`). O usuário quer que **um clique** faça tudo: revisar → corrigir os achados confirmados → rodar os checks do projeto → **criar um commit local**, e que não commite quando algo não está certo, dizendo o motivo. O commit vem de uma flag nova `--commit` na skill `code-review`, ligada **só pelo botão**. Sem a flag, a skill fica exatamente como hoje.

## Como trabalhar

- Declare as etapas como plano no Quadro (TodoWrite/TaskCreate): **um item por etapa**, e o título começa pelo id entre colchetes:
  - `[skill-flag-commit] Adicionar a flag --commit à skill code-review`
  - `[botao-envia-flags] Botão envia /code-review --fix --commit`
  - `[validacao] Validar no app real`
  A fase atual vai no texto de andamento (activeForm), ex.: `[skill-flag-commit] test: escrevendo o roteiro de verificação`. **Nunca** faça um item por fase com o mesmo prefixo: o primeiro concluído fecharia a etapa antes da hora.
- O plano está em `D:\agent-code-replay\runs\s1-novo-r2\agent-code\planning\agent-code\plano-20261009-1402` (cards em markdown). Consulte quando tiver dúvida pontual; **não replaneje**. Se algo nos cards não fechar com o código, pare e pergunte ao usuário.
- Este prompt não tem mídias anexadas.

### Prazo de cada etapa (obrigatório)
- Ao **começar** cada etapa: registre a sua estimativa com `mcp__entregas__entrega_estimar` e escreva: `Etapa N — <título>: estimativa do plano X min (prazo), minha estimativa Z min`.
- Ao **concluir**: consulte `mcp__entregas__entrega_tempo` e escreva: `levou Y min de trabalho (dentro/fora do prazo)`; se passou, diga o motivo.
- O prazo é a estimativa do plano; a sua não o muda. O tempo que vale é o medido pelo app.

### Estimativas deste prompt (minutos de trabalho do agente)
A numeração é a do roteiro. A etapa 1 (`regras-commit`, 2 min) foi concluída no planejamento e virou os requisitos abaixo.

| Etapa | Id | Estimativa |
|---|---|---|
| 2 — Flag `--commit` na skill code-review | `skill-flag-commit` | 8 min |
| 3 — Botão envia `/code-review --fix --commit` + título + teste | `botao-envia-flags` | 5 min |
| 4 — Validar: typecheck + testes + app rodando com diff real | `validacao` | 20 min |
| **Total deste prompt** | | **33 min** |

## Ciclo obrigatório: as 7 fases de cada etapa, nesta ordem

1. **plan**: declarar a etapa no plano e ler em lote os arquivos dela (skill `executing-plans`; `subagent-driven-development` se delegar).
2. **test**: antes de mexer em lógica, escrever o teste que falha e mostrar a falha (RED) (skill `test-driven-development`, ou `tdd-workflow` se estiver instalada). Mudança só visual ou de texto: escrever antes o roteiro de verificação no app (o que abrir, clicar e ver).
3. **implement**: o mínimo para passar; refatorar com o teste verde.
4. **review**: revisar o diff da etapa (skill `code-review` ou `requesting-code-review`). Bug achado é corrigido e revisado de novo. O que você decidir não corrigir vai no relatório, com o motivo.
5. **verify**: typecheck, testes, build e o app rodando de verdade (skills `verification-before-completion` e `verification-loop`). Teste pulado, ou falha atribuída a "bug que já existia", vai declarado no relatório, com o motivo.
6. **remember**: aprendizado não óbvio (armadilha, regra do projeto) vira memória por `memory_propose`. Nada que já esteja no código ou no git.
7. **improve**: no fim do prompt, autoavaliação de 1 a 5 em precisão, completude, clareza, ação e concisão, com prova (skill `agent-self-evaluation`), e uma lista "Melhorias sugeridas". Só sugerir: não edite skill nem prompt.

Proporcional: etapa trivial (texto, configuração) pode juntar test e verify, desde que diga por quê. A etapa `skill-flag-commit` é texto de skill: a fase test dela é o roteiro de verificação (o que será exercitado na etapa `validacao`), escrito **antes** de editar o SKILL.md.

## O que já está decidido (cards do plano)

### Ambiguidade resolvida: [[O botão deve corrigir sozinho antes de commitar?]]
- Leituras: (A) um clique faz tudo: review → corrige → checks → commit; (B) o botão só revisa e o commit vem depois de o usuário pedir a correção. A leitura B não cabe no botão, porque o turno seguinte é texto livre do usuário.
- **Decisão do usuário (09/10/2026): A.** O botão envia `/code-review --fix --commit`. O risco de corrigir sem aprovar achado por achado é pequeno no esforço padrão `medium` (só achados de alta confiança), e o commit é local e reversível.

### Decisão: [[Commit como flag --commit, ligado só pelo botão]]
- O commit automático vale **só no botão**, por uma flag nova `--commit` (ao lado de `--fix` e `--comment`).
- **Por quê:** (1) a skill é pré-carregada no subagente `critico` (`src/main/agents/specialists.ts:157`), que tem `Bash` e é proibido de mexer no código; com commit por padrão, ele passaria a commitar ao revisar tarefas do PO. (2) A skill é instalada globalmente e usada em outros projetos (ex.: ERP ITP); quem digita `/code-review` à mão não espera um commit.
- **Efeito:** sem `--commit`, a skill se comporta exatamente como hoje. A seção nova tem de ser **genérica** (vale para qualquer projeto): os checks e as regras de commit vêm do AGENTS.md/CLAUDE.md do projeto revisado.

### Requisito: [[Quando NÃO commitar]] (aprovado pelo usuário em 09/10/2026)
O commit só acontece se **tudo** abaixo for verdade. Se não, a skill **não commita e diz o motivo**, e o usuário decide o que fazer:
1. Há diff para commitar. Diff vazio ou trivial: nada a fazer, sem commit. ("Trivial" é o mesmo critério que a skill já usa em Rules, `SKILL.md:72`. Não amplie.)
2. Todo achado confirmado foi corrigido. Se algum ficou em aberto, a skill avisa e não commita (alinhado ao Step 3). Consequência: `/code-review --commit` sem `--fix` só commita quando não há achados.
3. Depois das correções, passaram os checks que o projeto exige antes de commitar, conforme o AGENTS.md/CLAUDE.md dele. No agent-code são **typecheck + test + build** (o build inclui o binário .NET); o usuário aceitou o custo de tempo.
- Sem achados também vale: diff não vazio e checks verdes → commita.
- Lacuna que os cards não cobrem: projeto **sem** checks documentados. Padrão do Manager, derivado do que o `--fix` já diz (`SKILL.md:64-66`, "re-run the affected checks (typecheck/tests)"): rodar os checks evidentes do projeto (ex.: scripts de typecheck/test) e dizer na resposta quais rodaram. Registre no relatório que adotou esse padrão.

### Requisito: [[O que entra no commit e como]]
No planejamento ficou como "proposto (padrão)", e a etapa de regras foi concluída com ele. É o padrão adotado:
- Entra **o diff revisado inteiro** (o trabalho + as correções), não só as correções. A review cobre o diff não commitado, e commitar só as correções deixaria o trabalho original solto.
- Stage por **caminho explícito** dos arquivos revisados (`git add -- <caminhos>`). **Nunca** `git add -A`/`git add .`, porque outros agentes podem estar mexendo no mesmo projeto. **Nunca** `.env`, credenciais ou segredos.
- Mensagem em Conventional Commits, no idioma do histórico do repo (conferir com `git log`; aqui é português, ex.: `fix(codex): …`).
- Sem trailer `Co-Authored-By`, a não ser que o `.claude/settings.json` do projeto peça (`attribution.commit`).
- Commit no branch atual; **sem push**, sem criar branch.
- Do Manager (não está nos cards, é a prática segura de git): sem `--amend` e sem `--no-verify`. Hook de pre-commit que falha conta como check falhando (gate 3).

### Requisito: [[Botão envia /code-review --fix --commit]]
- `Composer.tsx:1297`: trocar `'/code-review'` por `'/code-review --fix --commit'`.
- O `title` deixa claro que o botão também corrige e commita (ex.: "Revisar, corrigir e commitar (skill code-review)"). Hoje o texto é só "Revisar código".
- O teste `ChatPanel.comment.test.tsx:314-319` acha o botão por `getByTitle(/Revisar código/)` e confere a string enviada: ajustar o regex e o `toHaveBeenCalledWith`. Manter o que o teste protege: o trecho comentado não vai junto e continua no campo.
- O texto chega ao SDK como slash command com args (`agentSession.ts:1372` só o trata como slash). Não precisa de parser novo.

### Nota: [[Estado atual do botão de code review]]
- Hoje o botão chama `props.onSend('/code-review', [], [], [])`, sem `--fix`, e por isso só **reporta**.
- A skill fica versionada em `.agents/skills/code-review/SKILL.md`, e o app a copia para o cache e para a raiz global de skills. Ela vale para **todos os projetos**.

### Sugestões
Não há cards de sugestão neste plano.

## Etapas

### Etapa 2 — `[skill-flag-commit]` Flag `--commit` na skill code-review (8 min)
Cards: [[Commit como flag --commit, ligado só pelo botão]], [[Quando NÃO commitar]], [[O que entra no commit e como]].
- **test (roteiro antes de editar):** escrever o roteiro com os cenários da etapa `validacao` (critérios 2 a 7 abaixo): o que preparar, o que clicar e o que conferir no `git log`/`git show --stat`.
- **implement** em `.agents/skills/code-review/SKILL.md`, em inglês e genérico (nada específico do agent-code no texto da skill):
  - `description` do frontmatter: mencionar `--commit` ao lado de `--comment`/`--fix`.
  - Step 4: listar `--commit` e dizer que ele **só** vale quando está explícito nos args da invocação.
  - Uma seção nova (ex.: "Step 5 — Commit (only with `--commit`)"), que roda depois do review e do `--fix`: os 3 gates, na ordem, cada um dizendo o que responder quando falha; o que entra no commit; a mensagem; o branch; sem push. No fim, mostrar o hash e a mensagem do commit criado (ex.: `git log -1 --stat`).
  - Em Rules: "Without `--commit`, never stage or commit anything", o que protege o `critico` e quem digita à mão.
  - Coerência com o Step 3 (achados em aberto antes de commit) e com a regra "empty or trivial" (:72).
- **verify:** a etapa é só texto. Junte test e verify aqui (diga isso no relatório) e exercite de verdade na etapa `validacao`. Confira que o arquivo continua abaixo de 500 linhas.

### Etapa 3 — `[botao-envia-flags]` Botão envia `/code-review --fix --commit` (5 min)
Card: [[Botão envia /code-review --fix --commit]].
- **test (RED):** primeiro mude `ChatPanel.comment.test.tsx:314-319`: nome do teste, `getByTitle` com o regex do título novo, `toHaveBeenCalledWith('/code-review --fix --commit', [], [], [])`, mantendo `expect(tokens()).toHaveLength(1)`. Rode só esse arquivo no vitest e mostre a falha.
- **implement:** `Composer.tsx:1297` e `:1299`. Não refatore o Composer (ele já passa de 500 linhas, mas isso está fora do escopo).
- Atualize `docs/ARQUITETURA.md:1799` e `docs/REFERENCIA.md:252` (skill com `--commit`; botão envia `/code-review --fix --commit`).
- **verify:** o teste fica GREEN; depois `npm run typecheck` e `npm test` inteiros.

### Etapa 4 — `[validacao]` Validar no app real (20 min)
Card: [[Critérios de aceite do commit automático]]. A DoD do usuário vale aqui: typecheck e teste verdes **não** bastam, e a verificação de que funciona é sua, não do usuário.
- **Não crie commits de teste no repo agent-code.** Para os critérios 2 a 6, use um **repo git descartável** num diretório temporário fora do projeto (ex.: `%TEMP%`): `git init`, um projeto mínimo (ex.: um módulo JS e um teste com `node --test`, `npm test`), um `AGENTS.md` que exija `npm test` antes de commitar, e um commit inicial **em português** (para testar a regra do idioma). Abra essa pasta como projeto no app e use o botão nela. A skill é global, então vale ali também.
- Para rodar o app: `npm run dev` (skill `run`, se existir, para dirigir e capturar o Electron). Atenção: o usuário pode estar com o Agent Code aberto (esta conversa roda nele), e o lock de instância única (`src/main/index.ts:2272-2273`) fecha uma segunda instância com o mesmo userData. **Não feche o app do usuário nem pare processos que você não iniciou.** Se o lock bloquear, pergunte a ele como seguir.
- Gate 3 no agent-code (typecheck + test + build): o único diff real disponível é o desta implementação. No fim, pergunte ao usuário (AskUserQuestion) se ele autoriza clicar no botão sobre esse diff, o que cria o commit da feature. Com o sim, faça e mostre `git log -1 --stat`. Sem o sim, diga no relatório que o gate de typecheck + test + build do agent-code não foi exercitado pelo botão.

## Critérios de aceite (card [[Critérios de aceite do commit automático]])
1. `npm run typecheck` e `npm test` verdes (e `npm run build` antes de qualquer commit, conforme o AGENTS.md).
2. App rodando, diff real com um bug plantado, clique no botão: a skill revisa, corrige, roda os checks do projeto e cria **um** commit local. `git log -1` mostra mensagem Conventional Commits em português e sem `Co-Authored-By`. Nada de push.
3. Check falhando (ex.: erro que a correção não resolve): **nenhum commit**, e a resposta diz o motivo.
4. Diff vazio, clique no botão: nenhum commit, com aviso de que não havia nada.
5. Arquivo não relacionado ou não rastreado fora do escopo (ex.: um `.env` de teste): **não** entra no commit (`git show --stat HEAD`).
6. `/code-review` digitado à mão (sem `--commit`): comportamento igual ao de hoje, sem commit (`git log` não muda).
7. A skill atualizada chega ao cache: depois de editar `.agents/skills/code-review/SKILL.md`, o app recarrega a versão nova (`managedSkillSourceVersion`, `agentSession.ts:682` e `:1843-1858`). Prova: a cópia da skill que uma conversa nova enxerga contém `--commit`.

## Riscos
- **Provedor GPT/Codex:** ver se o slash command com args chega à skill do mesmo jeito. Se der para testar, teste. Se quebrar, reporte com a prova e **não** amplie o escopo sem perguntar ao usuário.
- **Subagente `critico`:** ele pré-carrega a skill e tem `Bash`. A regra "sem `--commit`, nunca commita" é o que o protege, então ela tem de estar explícita no SKILL.md.
- **Outros agentes no mesmo projeto:** por isso o stage é por caminho explícito. Se o diff tiver arquivos que não são do escopo revisado, eles ficam de fora.
- **Build lento:** o build do agent-code inclui o binário .NET (precisa do dotnet SDK). O usuário aceitou esse custo de tempo no gate 3.
- **"Diff trivial" sem commit:** é o que o card aprovado diz. Siga como está e não reinterprete.

## Relatório final
- Por etapa: estimativa do plano × a sua × tempo medido (`mcp__entregas__entrega_tempo`), e o motivo se passou do prazo.
- Mapa **etapa → teste → prova RED → prova GREEN** (na etapa de texto da skill: roteiro → cenário exercitado → evidência de `git log`/`git show --stat`).
- Resultado de cada critério de aceite (1 a 7), com evidência (saída de comando, captura de tela ou hash).
- O que a review achou e não foi corrigido, com o motivo; testes pulados ou falhas atribuídas a "bug que já existia", com o motivo; o padrão adotado para projeto sem checks documentados; e o resultado do risco Codex.
- Autoavaliação 1–5 (precisão, completude, clareza, ação, concisão) com prova, e a lista "Melhorias sugeridas".
