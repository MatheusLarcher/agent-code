<!-- prompt 1 -->
# Handoff — Commit no fim do fluxo de code review

## Arquivos

> Abra TODOS os arquivos de "Ler antes de começar" numa única resposta, com as leituras em paralelo. Não reexplore o que a lista cobre; use Grep/Glob só para o que faltar. As linhas são pista: o código pode ter mudado desde o planejamento.

### Ler antes de começar
- `.agents/skills/code-review/SKILL.md` — a skill inteira (73 linhas): frontmatter `description` (l.3-9), Step 3 Report com o aviso de achados em aberto antes de commit (l.50-58), Step 4 flags `--comment`/`--fix` (l.60-66), Rules (l.68-72).
- `src/renderer/src/components/Composer.tsx:1295` — o botão escudo: `onClick={() => props.onSend('/code-review', [], [], [])}` (l.1297) e `title="Revisar código (chama a skill code-review)"` (l.1299).
- `src/renderer/src/components/ChatPanel.comment.test.tsx:314` — teste que acha o botão por `getByTitle(/Revisar código/)` (l.317) e confere `toHaveBeenCalledWith('/code-review', [], [], [])` (l.318); protege que o trecho comentado não vai junto e continua no campo (l.319).
- `src/main/agents/specialists.ts:150` — subagente `critico` pré-carrega `skills: ['code-review']` (l.157), com `CRITIC_TOOLS` (l.88) que inclui Bash e sem Write. É o motivo de o commit ser opt-in.
- `src/main/agentSession.ts:1843` — `synchronizeManagedSkills`: compara o hash de `.agents/skills` com `managedSkillSourceVersion` (campo na l.682) e recopia a skill para o cache/raiz global e marca recarga. Critério de aceite 7.
- `src/main/skillManager.ts:88` — `managedSkillsFilesystemVersion` (hash de `<appRoot>/.agents/skills`); `syncCacheSkills` na l.430.
- `AGENTS.md` — checks antes de commitar no agent-code (typecheck + test + build, o build inclui o .NET) e a regra "NEVER add a Co-Authored-By trailer…".
- `docs/ARQUITETURA.md:1799` — parágrafo da skill `code-review` e do atalho do composer (hoje diz `props.onSend('/code-review', [], [])` e só cita `--fix`).

### Editar/criar
- `.agents/skills/code-review/SKILL.md` — nova flag `--commit` no Step 4 (passo final com gates, o que entra no commit, mensagem); citar `--commit` na `description` do frontmatter. Sem `--commit`, o comportamento atual não muda.
- `src/renderer/src/components/Composer.tsx:1297-1299` — comando vira `'/code-review --fix --commit'`; `title` vira algo como "Revisar, corrigir e commitar (skill code-review)".
- `src/renderer/src/components/ChatPanel.comment.test.tsx:314-318` — regex do `getByTitle` e o `toHaveBeenCalledWith` acompanham o novo título e o novo comando; manter a asserção da l.319.
- `docs/ARQUITETURA.md:1799` — sincronizar: a skill aceita `--commit` e o botão envia `/code-review --fix --commit` (e corrigir a assinatura citada para os 4 argumentos reais). Só um ajuste na documentação, sem mexer em mais nada.

---

## Objetivo

Hoje o botão escudo do Composer só **revisa** (envia `/code-review`, sem `--fix`). Com esta mudança, **um clique faz tudo**: revisa o diff, corrige os achados confirmados, roda os checks que o projeto exige e cria **um commit local**. Se algum gate falhar, não commita e explica o motivo. Quem digita `/code-review` à mão continua com o comportamento de hoje.

## Como trabalhar

- Planejamento (só para consulta pontual, **não replaneje**): `D:\agent-code-replay\runs\s1-novo-r1\agent-code\planning\agent-code\plano-20261009-1402`. Cards e decisões estão lá; este texto é autocontido.
- Declare as etapas como plano no Quadro (TodoWrite/TaskCreate): **um item por etapa**, com o título começando pelo id entre colchetes, por exemplo `[skill-flag-commit] Adicionar a flag --commit à skill code-review`. Mostre a fase atual no texto de andamento (activeForm), por exemplo `[skill-flag-commit] test: escrevendo o roteiro de verificação`. **Nunca** crie um item por fase com o mesmo prefixo: o primeiro concluído fecharia a etapa antes da hora.
- **Estimativa e prazo, em toda etapa, sem exceção:**
  - Ao começar: registre a sua estimativa com `mcp__entregas__entrega_estimar` e escreva `Etapa N — <título>: estimativa do plano X min (prazo), minha estimativa Z min`.
  - Ao concluir: consulte `mcp__entregas__entrega_tempo` e escreva `levou Y min de trabalho (dentro/fora do prazo)` e, se passou, o motivo.
  - O prazo é a estimativa do plano. A sua não o muda, e o tempo que vale é o medido pelo app.

### Etapas e estimativas (minutos de trabalho do agente)

| # | Etapa | Estimativa |
|---|---|---|
| 1 | `skill-flag-commit` — flag `--commit` na skill code-review | 8 min |
| 2 | `botao-envia-flags` — botão envia `/code-review --fix --commit`; título, teste e doc | 5 min |
| 3 | `validacao` — typecheck + testes + app rodando com diff real | 20 min |
| | **Total deste prompt** | **33 min** |

(A etapa `regras-commit`, 2 min, já foi **concluída no planejamento**: ela gerou as regras abaixo e não é trabalho de implementação.)

### Ciclo obrigatório: cada etapa passa por estas 7 fases, nesta ordem
1. **plan**: declarar a etapa no Quadro e ler em lote os arquivos dela (skill `executing-plans`; `subagent-driven-development` se delegar).
2. **test**: antes de mexer em lógica, escrever o teste que falha e mostrar a falha (RED) (skill `test-driven-development`, ou `tdd-workflow` se instalada). Se a mudança for só de texto ou visual, escrever antes o roteiro de verificação no app: o que abrir, clicar e ver.
3. **implement**: o mínimo para passar; refatorar com o teste verde.
4. **review**: revisar o diff da etapa (skill `code-review` ou `requesting-code-review`). Bug achado é corrigido e revisado de novo. O que você decidir não corrigir vai no relatório, com o motivo.
5. **verify**: typecheck, testes, build e o app rodando de verdade (skills `verification-before-completion` e `verification-loop`). Teste pulado, ou falha atribuída a "bug que já existia", é declarado no relatório com o motivo.
6. **remember**: aprendizado não óbvio (armadilha, regra do projeto) vira memória por `memory_propose`. Nada que já esteja no código ou no git.
7. **improve**: no fim do prompt, autoavaliação de 1 a 5 em precisão, completude, clareza, ação e concisão, com prova (skill `agent-self-evaluation`), e uma lista "Melhorias sugeridas". Só sugerir: não edite skill nem prompt.

Proporcional: etapa trivial (texto, configuração) pode juntar test e verify, dizendo por quê. A etapa 1 é texto de skill: o "teste" dela é o roteiro de verificação, executado de fato na etapa 3. A etapa 2 tem teste de unidade, e o RED é obrigatório: mude o teste primeiro e mostre a falha.

O **relatório final** traz o mapa etapa → teste → prova RED → prova GREEN.

---

## Etapa 1 — `skill-flag-commit` (8 min)

Cards: [[Commit como flag --commit, ligado só pelo botão]] (decisão), [[Quando NÃO commitar]] (requisito), [[O que entra no commit e como]] (requisito), [[O botão deve corrigir sozinho antes de commitar?]] (ambiguidade resolvida), [[Estado atual do botão de code review]] (nota).

### O que fazer em `.agents/skills/code-review/SKILL.md`
- **`description` do frontmatter:** citar `--commit` ao lado de `--comment`/`--fix`, em uma frase: depois de corrigir e passar os checks, commita localmente.
- **Step 4:** novo item `--commit`, que roda **por último**, depois do report e do `--fix`. Ele precisa conter:
  - **Gates.** Só commita se TODOS forem verdadeiros. Senão, **não commita e diz qual gate falhou** (o usuário decide o que fazer):
    1. Há diff para commitar. Diff vazio ou trivial: nada a fazer, sem commit (é a mesma regra da seção Rules, aprovada assim pelo usuário).
    2. Todo achado confirmado foi corrigido. Se algum ficou em aberto, avisa e não commita (alinhado ao Step 3). Consequência: `--commit` sem `--fix` só commita quando não há achado confirmado.
    3. Depois das correções, passaram **os checks que o projeto exige antes de commitar, conforme o AGENTS.md/CLAUDE.md dele**. No agent-code isso é typecheck + test + build (o build inclui o binário .NET). Se um check não puder rodar (ferramenta ausente, por exemplo), isso conta como gate falho, e não como aprovado.
    4. Sem achados, ainda vale: diff não vazio e checks verdes → commita.
  - **O que entra no commit:**
    - O **diff revisado inteiro**, ou seja, o trabalho mais as correções. Commitar só as correções deixaria o trabalho original solto.
    - Stage por **caminho explícito** só dos arquivos do escopo revisado (Step 1). **Nunca** `git add -A` nem `git add .`: outros agentes podem estar mexendo no mesmo projeto.
    - Nunca `.env`, credenciais ou segredos.
  - **Mensagem:** Conventional Commits, no idioma do histórico do repo (no agent-code: português, ex.: `fix(codex): …`; confira com `git log`).
    - **Sem** trailer `Co-Authored-By`, salvo se o `.claude/settings.json` do projeto pedir (`attribution.commit`).
  - **Onde:** commit no branch atual. **Sem push**, sem criar branch, sem `--amend`, sem `--no-verify`.
  - **No fim:** informar o hash e a mensagem do commit (ou o gate que barrou).
- **Texto genérico:** a skill é instalada globalmente e usada em outros projetos (ex.: ERP ITP). Nada de agent-code hardcoded: os checks e as regras de commit vêm do AGENTS.md/CLAUDE.md do projeto revisado. O agent-code pode aparecer só como exemplo.
- **Sem `--commit`:** a skill tem de se comportar **exatamente como hoje**. Não mexa em Steps 1-3 além do necessário.
- **Arquivo pequeno:** mantenha-o bem abaixo de 500 linhas.

### Dica técnica (verificada na doc do git)
`git commit -m "<msg>" -- <paths>` commita só aqueles caminhos e **ignora o que já estava staged para outros caminhos** (modo `--only`, padrão quando se passam paths; ver https://git-scm.com/docs/git-commit). Arquivo novo precisa de `git add -- <path>` antes, senão o git recusa o pathspec. Isso protege contra commitar algo que o usuário ou outro agente tenha deixado no index. Vale escrever na skill: `git add -- <paths novos>` e depois `git commit -m … -- <todos os paths do escopo>`. Antes do commit, conferir `git status --short`.

---

## Etapa 2 — `botao-envia-flags` (5 min)

Card: [[Botão envia /code-review --fix --commit]] (requisito).

- `Composer.tsx:1297`: `props.onSend('/code-review', [], [], [])` → `props.onSend('/code-review --fix --commit', [], [], [])`.
- `Composer.tsx:1299`: `title` deixa claro que o botão também corrige e commita, por exemplo "Revisar, corrigir e commitar (skill code-review)".
- `ChatPanel.comment.test.tsx:314-319`: ajuste o regex do `getByTitle` e o `toHaveBeenCalledWith`. Mantenha o que o teste protege (o trecho comentado não vai junto e continua no campo, `tokens()` com 1 item). Ajuste o nome do `it(...)` se citar o comando.
  - **RED primeiro:** mude o teste, rode `npx vitest run src/renderer/src/components/ChatPanel.comment.test.tsx` e mostre a falha. Só depois mude o Composer e mostre o verde.
- O texto chega ao SDK como slash command com args (`agentSession.ts:1371-1372` só o detecta como slash para não ligar o auto-loop). **Não precisa de parser novo.**
- `docs/ARQUITETURA.md:1799`: atualizar a frase do atalho do composer e citar `--commit` na descrição da skill.

---

## Etapa 3 — `validacao` (20 min)

Card: [[Critérios de aceite do commit automático]] (requisito).

**Atenção, risco real:** clicar no botão **dentro do repo agent-code** commitaria o seu próprio trabalho no `master` do usuário. **Não faça isso.** Para os testes de clique, use um **repo descartável** fora do projeto (ex.: pasta temporária com `git init`), aberto como projeto no app. A skill é global, então a versão nova vale lá também. Sugestão de repo mínimo, sem instalar nada:
- um `AGENTS.md` dizendo "Antes de commitar, rode `node --test`";
- um `soma.js` e um `soma.test.js` com `node:test`;
- um commit inicial.

Para o caso 3, um erro que a correção não resolva: por exemplo, um teste que falha por motivo que não está no diff.

Os commits da implementação no agent-code **não** fazem parte deste prompt. Não commite sem o usuário pedir.

### Critérios de aceite (todos com prova)
1. `npm run typecheck` e `npm test` verdes no agent-code. `npm run build` também, já que a skill muda e o AGENTS.md pede build verificado.
2. App rodando (`npm run dev`) e repo descartável com diff real e um bug plantado. Ao clicar no botão, a skill revisa, corrige, roda os checks do AGENTS.md daquele repo e cria **um** commit local. Provas:
   - `git log -1` mostra mensagem Conventional Commits no idioma do histórico, **sem** `Co-Authored-By`;
   - nada de push.
3. Check falhando, que a correção não resolve: **nenhum commit**, e a resposta diz o motivo.
4. Diff vazio e clique no botão: nenhum commit, com aviso de que não havia nada.
5. Arquivo não relacionado ou não rastreado fora do escopo (ex.: um `.env` de teste, ou um arquivo já staged por fora): **não** entra no commit (`git show --stat HEAD`).
6. `/code-review` digitado à mão, sem `--commit`: comportamento igual ao de hoje, sem commit.
7. A skill atualizada chega ao cache. Depois de editar `.agents/skills/code-review/SKILL.md`, o app recarrega a versão nova (`synchronizeManagedSkills` em `agentSession.ts:1843`, campo `managedSkillSourceVersion` na l.682). Prova: a cópia no cache/raiz global de skills contém `--commit`.

**Risco a conferir:** com o provedor GPT/Codex, ver se o slash command com args chega à skill do mesmo jeito. Se não der para testar (sem credencial, por exemplo), declare no relatório que não foi testado.

DoD do usuário: typecheck e teste verdes **não** bastam. Rode o app e exercite o fluxo real, incluindo os caminhos de falha (3, 4 e 5). O que não conseguir validar de fato, diga explicitamente; não afirme que funciona.

---

## Decisões (com o porquê)
- **Commit só via flag `--commit`, ligada só pelo botão.** A skill é pré-carregada no subagente `critico` (`specialists.ts:157`), que tem Bash e é proibido de mexer no código: com commit por padrão, ele passaria a commitar ao revisar tarefas do PO. Além disso, a skill é global, e quem digita `/code-review` à mão não espera commit.
- **Checks completos do projeto antes de commitar** (no agent-code: typecheck + test + build, com o .NET). O usuário aceitou o custo de tempo para seguir a regra do AGENTS.md.

## Ambiguidade resolvida
- **"O botão deve corrigir sozinho antes de commitar?"** Decisão do usuário (09/10/2026): **sim, leitura A, um clique faz tudo.** O botão envia `/code-review --fix --commit`.
- **Por quê:** é a única leitura que o botão consegue garantir sempre, já que o turno seguinte é texto livre do usuário.
- **Risco aceito:** corrigir sem aprovação achado a achado. Ele é pequeno no esforço `medium` padrão (só achados de alta confiança), e o commit é local e reversível (`git reset HEAD~1`).

## Requisito com status "proposto (padrão)"
- [[O que entra no commit e como]] não teve aprovação explícita, mas os pontos dele que dá para checar já estão nos critérios de aceite aprovados: Conventional Commits em português, sem `Co-Authored-By`, sem push, nada fora do escopo. Siga-o como está.

## Riscos
- **Commit acidental no repo do usuário durante a validação.** Use o repo descartável (ver etapa 3).
- **Index com coisas staged por fora entrando no commit.** Use `git commit -- <paths>` (modo `--only`) e confira com `git show --stat HEAD`.
- **Build do agent-code depende do dotnet SDK.** Se faltar, o gate 3 falha e a skill não deve commitar; no relatório da implementação, diga se o build rodou.
- **Provedor GPT/Codex** pode tratar o slash command com args de outro jeito. Teste ou declare que não testou.
- **Diff "trivial" não commita.** O gate 1 diz "vazio ou trivial", como foi aprovado. Se isso se mostrar estranho no teste, relate em vez de mudar a regra.

## Sugestões com fonte
- `git commit -- <paths>` para isolar o commit do index: https://git-scm.com/docs/git-commit (seção "--only" / modo padrão com paths).
