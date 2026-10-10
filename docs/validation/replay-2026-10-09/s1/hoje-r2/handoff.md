<!-- prompt 1 -->
# Handoff — Commit no fim do fluxo de code review

Projeto: `D:\agent-code-replay\s1\agent-code` (Electron + React + TS; ver `AGENTS.md`).
Planejamento (consultar, **não replanejar**): `D:\agent-code-replay\runs\s1-hoje-r2\agent-code\planning\agent-code\plano-20261009-1402` (é só leitura: não edite os cards nem o roteiro).

## Objetivo

O botão de code review do Composer (ícone de escudo) passa a fazer tudo com **um clique**: revisa o diff, corrige os achados confirmados, roda os checks que o projeto exige e, se tudo passar, **cria um commit local**. Isso vem de uma nova flag `--commit` na skill `code-review`, e só o botão a envia. Quem digita `/code-review` à mão continua com o comportamento de hoje.

## Como trabalhar

1. Antes de tudo, declare as etapas como plano (TodoWrite ou TaskCreate). Cada item começa pelo id da etapa entre colchetes, na ordem:
   - `[skill-flag-commit] Adicionar a flag --commit à skill code-review`
   - `[botao-envia-flags] Botão envia /code-review --fix --commit + título + teste`
   - `[validacao] Validar no app real (typecheck, testes, botão com diff real)`
2. **Ao começar cada etapa**, registre a sua estimativa com `mcp__entregas__entrega_estimar` e escreva:
   `Etapa N — <título>: estimativa do plano X min (prazo), minha estimativa Z min`
3. **Ao concluir cada etapa**, consulte `mcp__entregas__entrega_tempo` e escreva:
   `levou Y min de trabalho (dentro/fora do prazo)`. Se passou do prazo, diga o motivo.
   O prazo é a estimativa do plano. A sua estimativa não muda o prazo, e o tempo que vale é o medido pelo app.
4. Siga o `AGENTS.md` do projeto e o DoD do usuário: typecheck/teste verde **não** é "pronto". Só diga "pronto" depois de rodar o app e exercitar o botão no fluxo real.

## Etapas e estimativas

A etapa 1 do roteiro (`regras-commit`) já foi **concluída** no planejamento: as regras dela estão logo abaixo. Este prompt cobre as etapas 2 a 4.

| Etapa | Id | Estimativa do plano (min de agente) |
|---|---|---|
| 2 — Adicionar a flag `--commit` à skill code-review (passo final com gates e commit) | `skill-flag-commit` | 8 |
| 3 — O botão do Composer envia `/code-review --fix --commit`; ajustar o título e o teste do ChatPanel | `botao-envia-flags` | 5 |
| 4 — Validar: typecheck + testes + rodar o app e clicar no botão com diff real | `validacao` | 20 |
| **Total deste prompt** | | **33 min** |

---

## Contexto: o estado atual (card [[Estado atual do botão de code review]])

- Em `src/renderer/src/components/Composer.tsx:1297`, o botão chama `props.onSend('/code-review', [], [], [])`, **sem `--fix`**. O título atual (linha 1299) é `"Revisar código (chama a skill code-review)"`. Hoje ele só **reporta** os achados.
- A skill fica versionada em `.agents/skills/code-review/SKILL.md` (73 linhas: Step 1 escopo/esforço, Step 2 review, Step 3 report, Step 4 flags `--comment`/`--fix`, Rules). O app a copia para o cache/raiz global de skills, então ela vale para **todos os projetos** (inclusive o ERP ITP), não só para o agent-code.
- A mesma skill é pré-carregada no subagente crítico (`src/main/agents/specialists.ts:157`, `skills: ['code-review']`). Esse subagente tem `Bash` e é proibido de alterar código.
- O teste que fixa o comando enviado é `src/renderer/src/components/ChatPanel.comment.test.tsx:314-320`.

## Decisões (com o porquê)

### [[Commit como flag --commit, ligado só pelo botão]] (decisão aprovada pelo usuário em 09/10/2026)
- O commit automático vale **só no botão**. Ele vem de uma nova flag `--commit` na skill (ao lado de `--fix` e `--comment`), e o botão envia `/code-review --fix --commit`.
- **Por quê:** (1) a skill é pré-carregada no subagente crítico (`specialists.ts:157`), que tem Bash. Com commit por padrão, ele passaria a commitar ao revisar tarefas do PO. (2) A skill é global e é usada em outros projetos, e quem digita `/code-review` à mão não espera um commit.
- **Efeito:** sem `--commit`, a skill se comporta **exatamente** como hoje. A seção nova tem que ser **genérica** e valer para qualquer projeto: os checks e as regras de commit vêm do `AGENTS.md`/`CLAUDE.md` do projeto revisado, nada fixo do agent-code.

### Ambiguidade resolvida: [[O botão deve corrigir sozinho antes de commitar?]]
- Leituras: A) um clique faz tudo (review → corrige → checks → commit); B) o botão só revisa e o commit vem depois. A B não cabe no botão, porque o turno seguinte é texto livre do usuário.
- **Decisão do usuário (09/10/2026): leitura A.** O botão envia `/code-review --fix --commit`. O risco de corrigir sem aprovar cada achado é pequeno no esforço padrão `medium`, que só reporta achados de alta confiança, e o commit é local e reversível (`git reset HEAD~1`).

## Requisitos

### [[Quando NÃO commitar]] (aprovado pelo usuário em 09/10/2026)
O commit só acontece se **tudo** abaixo for verdade. Se algo falhar, a skill **não commita e diz o motivo**, e o usuário decide o que fazer:
1. Há diff para commitar. Com diff vazio ou trivial não há nada a fazer, e não sai commit.
2. Todos os achados confirmados foram corrigidos. Se algum ficou em aberto, a skill avisa e não commita (alinhado ao Step 3 da skill).
3. Depois das correções, passaram os checks que o projeto exige antes de commitar, conforme o `AGENTS.md`/`CLAUDE.md` dele. No agent-code são **typecheck + test + build** (o build inclui o binário .NET). O usuário aceitou o custo de tempo. Repare que isso é **mais** do que o `--fix` faz hoje ("re-run the affected checks"): com `--commit` valem os checks completos de pré-commit do projeto.
- Mesmo sem achados vale a regra: com diff não vazio e checks verdes, commita.
- Consequência dos gates (não é decisão nova): `--commit` sem `--fix` só commita se não houver nenhum achado confirmado.

### [[O que entra no commit e como]] (proposta padrão do planejamento: siga-a)
- Entra **o diff revisado inteiro** (o trabalho + as correções), não só as correções. A review cobre o diff não commitado, e commitar só as correções deixaria o trabalho original solto.
- Faça o stage por **caminho explícito** dos arquivos revisados. **Nunca** use `git add -A` nem `git add .`, porque outros agentes podem estar mexendo no mesmo projeto. Nunca entram `.env`, credenciais ou segredos.
- A mensagem segue Conventional Commits, no **idioma do histórico do repo**. No agent-code é português, ex.: `fix(codex): falha ao ler o storage …`.
- Sem trailer `Co-Authored-By`, salvo se o `.claude/settings.json` do projeto definir `attribution.commit`.
- O commit vai no **branch atual**: **sem push** e sem criar branch.

### [[Botão envia /code-review --fix --commit]] (aprovado)
- Em `Composer.tsx:1297`, troque `'/code-review'` por `'/code-review --fix --commit'`.
- O `title` do botão precisa deixar claro que ele também corrige e commita, ex.: `"Revisar, corrigir e commitar (skill code-review)"`.
- No teste `ChatPanel.comment.test.tsx:314-320`, ajuste o `getByTitle(/Revisar código/)` ao novo título e o `toHaveBeenCalledWith('/code-review --fix --commit', [], [], [])`. **Mantenha o que o teste protege**: o trecho comentado não vai junto e continua no campo (`expect(tokens()).toHaveLength(1)`).
- O texto chega ao SDK como slash command com args (`agentSession.ts` só o trata como slash), então **não precisa de parser novo**.

---

## Etapa 2 — `skill-flag-commit` (8 min)

Edite `.agents/skills/code-review/SKILL.md`, mantendo o inglês e o estilo do arquivo:
- No Step 4 ("Optional flags"), acrescente `--commit`. Se ficar mais claro, crie um passo final próprio (ex.: "Step 5 — Commit (only with `--commit`)") que diga:
  - ele roda **somente** quando `--commit` foi passado; sem a flag, nada muda;
  - quais são os gates (os 3 de [[Quando NÃO commitar]]) e que, se algum falhar, não commita e diz qual falhou;
  - os checks vêm do `AGENTS.md`/`CLAUDE.md` do projeto revisado (genérico);
  - o que entra e como commitar ([[O que entra no commit e como]]): diff revisado inteiro, stage por caminho explícito, nada de `-A`/`.`, sem segredos, Conventional Commits no idioma do histórico, sem `Co-Authored-By` salvo `attribution.commit`, branch atual, sem push;
  - no fim, reporta o hash e a mensagem do commit (ou o motivo de não ter commitado).
- Atualize a `description` do frontmatter para mencionar `--commit`, sem mudar os triggers.
- O subagente crítico não pode commitar nunca. O texto tem que deixar inequívoco que commit **só** acontece com `--commit` explícito.

## Etapa 3 — `botao-envia-flags` (5 min)

- `Composer.tsx:1297`: novo comando. `Composer.tsx:1299`: novo `title`.
- `ChatPanel.comment.test.tsx:314-320`: regex do título + string enviada, como descrito acima.
- Confira com Grep se mais algum teste/código procura o título `Revisar código` ou a string `'/code-review'` enviada pelo botão. Na análise do plano só apareceu esse teste.
- Não refatore o `Composer.tsx` (ele já passa de 500 linhas, mas a mudança aqui é de uma linha e dividir o arquivo está fora do escopo).

## Etapa 4 — `validacao` (20 min)

### [[Critérios de aceite do commit automático]] (aprovado)
1. `npm run typecheck` e `npm test` verdes.
2. Com o app rodando, um diff real com um bug plantado e um clique no botão, a skill revisa, corrige, roda os checks do projeto (no agent-code: typecheck+test+build) e cria **um** commit local. `git log -1` mostra uma mensagem Conventional Commits em português e sem `Co-Authored-By`. Nada de push.
3. Com um check falhando (ex.: um erro de tipo que a correção não resolve), **nenhum commit**, e a resposta diz o motivo.
4. Com o diff vazio, o clique no botão não gera commit e avisa que não havia nada a commitar.
5. Um arquivo não relacionado/não rastreado fora do escopo (ex.: um `.env` de teste) **não** entra no commit.
6. `/code-review` digitado à mão (sem `--commit`) se comporta como hoje, sem commit.
7. A skill atualizada chega ao cache. Depois de editar `.agents/skills/code-review/SKILL.md`, o app recarrega a versão nova (`managedSkillSourceVersion` em `src/main/agentSession.ts:682`, comparada em `:1847`). Confira que a cópia em cache/global tem a seção `--commit`.

Além disso, siga o DoD do usuário: remonte (saia e volte à conversa), dê reload (F5) e repita o clique pelo menos uma vez, para ver que o botão continua enviando o comando certo.

## Riscos

- **Provedor GPT/Codex:** confira se o slash command com args (`/code-review --fix --commit`) chega à skill do mesmo jeito que no Claude. Se não chegar, **relate ao usuário** antes de ampliar o escopo.
- **Não sujar o histórico real do agent-code:** os critérios 2–5 criam commits com bug plantado. Prefira um **repositório git descartável** (pasta temporária com um arquivo de código e um `AGENTS.md` que declare um check barato que você consiga fazer falhar), aberto como projeto no app. A skill é global, então isso testa os gates de verdade. Para ver o caso específico do agent-code (typecheck+test+build), **pergunte ao usuário** antes de deixar o botão commitar no repo do agent-code. Nunca deixe um commit com bug plantado em `master`, e nunca dê push.
- **Commit da implementação:** não commite as mudanças desta implementação sem o usuário pedir (regra global). Se ele pedir, siga o `AGENTS.md` (typecheck + test + build antes) e não use `Co-Authored-By`.
- **Outros agentes no mesmo projeto:** não use `git add -A`/`.`, `checkout`, `reset`, `stash` nem `clean` em mudanças que não são suas, e não reinicie o app que o usuário está usando. Para validar, rode uma instância de dev.
- **Projeto sem checks declarados:** se o `AGENTS.md`/`CLAUDE.md` do projeto revisado não disser quais checks rodar antes de commitar, a skill deve dizer na resposta quais rodou (ou que não achou nenhum declarado), em vez de commitar em silêncio. Se preferir outro comportamento, confirme com o usuário.
- **Custo de tempo:** typecheck+test+build (com .NET) deixa o clique lento no agent-code. O usuário já aceitou isso, então não otimize cortando o build.

## Critério de pronto

As três etapas estão concluídas e os 7 critérios de aceite foram verificados de fato no app rodando, com o resultado de cada um relatado (o que você viu, `git log -1` quando houve commit). Se algum critério não puder ser verificado, diga qual e por quê, em vez de afirmar que funciona.
