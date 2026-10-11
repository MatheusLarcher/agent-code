# Replay: refazer tarefas reais com os interruptores desligados × ligados

Prova (plano-20261008-2158, etapa `teste-replay`) de que a leitura guiada e o catálogo de skills em níveis não pioram a qualidade (o interruptor das 7 fases por etapa nos handoffs, que também era comparado, saiu do app em 10/10: o rigor passou a ser decidido por etapa no planejamento, com Aceite/Verificar com/Decidido). Três tarefas reais do agent-code são refeitas a partir do commit pai de cada uma, 2 rodadas por lado (escolha do usuário em 09/10; o handoff pedia 3). O resultado final vai para `docs/validation/replay-<data>/`.

As tarefas são simples (`config.mjs`): commits pequenos, com teste, cujo pedido original está no banco do app. Em 09/10 13:03 o usuário trocou as três primeiras (mais de 2 h por rodada) e pediu no máximo 20 min por teste. Por isso o trabalho do agente (handoff + implementação) tem teto de 10 min (regra do usuário em 09/10 15:10). O teto de 10 min é **estrito para handoff + implementação**: passou do prazo, a rodada reprova, mesmo que o código parcial avaliado no corte esteja verde. Só uma implementação com estado `done` no prazo pode passar; estado faltante não aprova. Se o handoff consumir todo o orçamento, a implementação não recebe tempo adicional. Não houve aprovação humana para relaxar esse limite; uma pergunta posterior expirou sem resposta. A avaliação (uns 3 min) vem depois e não conta no teto. A conversa que parou antes do teto conta como terminada, mesmo que a confirmação do fim passe dele.

## Isolamento (o agente da rodada não pode achar a solução nem mexer no PC do usuário)

- **Cópias:** `D:\agent-code-replay\tN\agent-code`, uma por tarefa.
  - A pasta se chama `agent-code` para o projeto aparecer com o nome original.
  - São repositórios próprios, recriados a cada execução: `init` + `fetch` do commit pai + `reset` + `clean -fdx` (menos o `node_modules`).
  - O histórico vai só até o pai, sem remote, sem reflog, stash ou branch de rodada anterior.
  - Uma `git worktree` dividiria os objetos com o repositório do usuário: `git show <referência>` entregaria a solução.
- **Ordem s1 → s2 → s3 (`config.mjs`, do pai mais novo ao mais velho), apagando a cópia ao terminar cada tarefa (`retire`).** A cópia de um commit pai posterior contém a solução das tarefas anteriores. Nessa ordem, nenhuma cópia vizinha tem a solução da tarefa em curso.
- **Ambiente da instância (`instance.mjs`):** `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` e `TEMP` apontam para `runs\<rodada>\perfil`.
  - `~`, `$env:APPDATA` e o `%TEMP%` dos comandos do agente caem lá.
  - O login do CLI segue o de sempre: `CLAUDE_CONFIG_DIR` = `~/.claude` real. Os transcripts caem em `~/.claude/projects/<slug da cópia>` e cada rodada os move para a pasta dela.
- **Cerca do CLI (`fence.mjs`):** `.claude/settings.local.json` da cópia, ignorado pelo git dela.
  - `deny` de `Read` para tudo que não é da rodada:
    - o checkout do usuário e o `%APPDATA%\agent-code-desktop` real (logs de builds posteriores às tarefas);
    - o `%LOCALAPPDATA%\agent-code` real, o `~/.claude` e o OneDrive;
    - as outras cópias, rodadas, saídas e mapas do replay;
    - os dados do próprio app da instância (`userData`, `localappdata`: os logs dele são do build atual).
  - `deny` de `WebFetch`, `WebSearch`, `mcp__browser` e `EnterWorktree`: o repositório é público no GitHub.
  - Essas ferramentas o app aprova sozinho, sem passar pela ponte. Conferido com o CLI: leitura proibida → "File is in a directory that is denied by your permission settings".
- **Política (`policy.mjs`)** para o que passa pela ponte:
  - o agente escreve só na cópia, no perfil isolado e no cache da instância (plano, memórias);
  - nega shell que cite pasta proibida ou uma pasta acima dela, ou que suba `../..`;
  - nega rede (`git clone/fetch/pull/push`, `curl`, `iwr`, `gh`), qualquer execução do Electron e `npm run dev`;
  - nega matar processo, instalar dependência, mexer na cerca (`.claude/`), subagente em worktree e controle do Windows/Chrome.
  - Perguntas: a opção com "(Recomendado)" no rótulo; sem marca, a primeira.
  - Fim de turno com pergunta (inclusive pergunta seguida de lista): uma insistência padrão, no máximo 3.
  - Prompts 2..N do handoff que a fila do Quadro retém (PO desligado) são enviados pelo condutor. Mesma regra nos dois lados.
- **Fim da rodada (`drive.mjs`):** conversa parada por 60 s **e** nenhum transcript da rodada escrito nesse tempo. Subagentes em segundo plano não aparecem na ponte. Teto de 10 min (handoff + implementação).

## Passos

```
node scripts/replay/replay.mjs prepare <t>            # cópia no commit pai; npm install aproveitando o node_modules da pasta
node scripts/replay/replay.mjs baseline <t>           # typecheck + suíte no pai (com os ids que passam); testes da referência no pai e na referência
node scripts/replay/replay.mjs plan <t>               # o Manager planeja UMA vez a partir do pedido original (interruptores desligados); o plano é congelado
node scripts/replay/replay.mjs batch <t>              # as 4 rodadas (hoje r1, novo r1, hoje r2, novo r2), uma por vez; erro de infraestrutura repete (até 5 tentativas)
node scripts/replay/replay.mjs round <t> <hoje|novo> <n> [--smoke]
node scripts/replay/review.mjs prepare <t> <n>        # revisão às cegas do par n: pasta fora do repo, A/B sorteados, falhas com chaves f1..fN
node scripts/replay/review.mjs ingest <t> <n> <json>  # grava a nota com os lados revelados (recusa se faltar classificar falha)
node scripts/replay/replay.mjs publish <t>            # depois das revisões: saídas privadas (D:\agent-code-replay\saidas) → docs/validation
node scripts/replay/replay.mjs retire <t>             # apaga a cópia e os dados das execuções da tarefa
node scripts/replay/report.mjs                        # tabelas + veredito (pass^k do novo, ≥ hoje, nenhuma média pior; incompleto não aprova)
node --test scripts/replay/replay.test.mjs            # teste do arnês
```

Uma rodada faz, em ordem:
1. Recria a cópia e grava a cerca.
2. Prepara a pasta de dados (skills do usuário, sem as dos kits, e o plano congelado).
3. Abre a instância com os interruptores do lado.
4. Reabre o plano e pede o handoff ao Manager.
5. Envia para implementação e conduz até o fim.
6. Salva o diff, marcando trabalho que tenha ficado fora dele (stash, worktree).
7. Avalia (`evaluate.mjs`):
   - typecheck;
   - suíte comparada com a linha de base (falha nova só conta se repetir em 2 re-execuções isoladas);
   - testes que passavam no pai e sumiram;
   - testes do commit de referência (gravados a partir do repositório do usuário, já que a cópia não tem o commit).
8. Mede o tempo (`medir-exploracao.mjs`, cópia sem mudança da mídia do plano).

O "passou" final do avaliador de código sai depois da revisão às cegas. Falha de teste de referência classificada como "nome" não conta; "comportamento" conta.

## Validação da autonomia do handoff (tarefa `a1`, plano-20261010-0616)

Prova de que, com o build novo, a conversa de handoff decide sozinha: nenhuma pergunta não destrutiva chega ao usuário, nenhum turno termina perguntando, a fila solta os prompts 2..N sozinha, e tempo ativo, chamadas e contexto médio não pioram. Resultados em `docs/validation/replay-autonomia-2026-10-10/`.

- **Base = uma sessão real que perguntou:** `3708b226` (06/10), handoff do `plano-20261006-1026` (cadeiras do escritório 3D). Ela teve 1 AskUserQuestion, 1 espera de 7 min, 1 turno terminado em pergunta, 116 min ativos, 284 chamadas e contexto médio de 417 mil tokens. As outras candidatas da medição saíram: `921d3343` (pesquisa num repositório do GitHub, que a cerca nega, e sem commit de referência), `21831ff9` (era a conversa do Agent Manager) e `41fb8e53` (270 arquivos e 27 h).
- **Os contadores da base** saem do transcript da sessão, guardado no banco do app (`sdk_session_entries`), por `baseline-sessao.mjs`. As mesmas contas rodam sobre a conversa de implementação de cada rodada (`run.autonomy`).
- **A tarefa `a1`** (`config.mjs`):
  - referência = a faixa `8c89585..526d549` (a entrega foram 3 commits seguidos);
  - teto de 60 min;
  - lado único `novo`, com os interruptores da config do usuário (leitura guiada e catálogo em níveis ligados);
  - plano = cópia do plano real, sem o `_handoff`. O Manager só escreve o handoff, com as regras novas.
- **A autonomia é a padrão:** sem card, perguntas `nenhuma` e permitir tudo exceto destrutivo. O condutor continua respondendo pela recomendada; se uma pergunta chegar, ela conta como falha da meta.
- **A revisão às cegas** compara o diff da rodada com o diff de referência (A/B sorteados).

```
node scripts/replay/replay.mjs prepare a1 && node scripts/replay/replay.mjs baseline a1 && node scripts/replay/replay.mjs plan a1
node scripts/replay/replay.mjs round a1 novo 1   # depois a rodada 2; uma por vez, em segundo plano
node scripts/replay/review.mjs prepare a1 <n>    # revisor às cegas; depois ingest
node scripts/replay/replay.mjs publish a1 && node scripts/replay/replay.mjs retire a1
node scripts/replay/report.mjs                   # tabela base × novo-r1 × novo-r2 e veredito por meta
```

As metas não se ajustam para passar:
- `pergunta`, `insistencia`, `proximo-prompt` e `primeiro-prompt-forcado` = 0;
- tempo ativo, chamadas e contexto médio ≤ base;
- typecheck e suíte verdes;
- testes de referência passando;
- revisão sem nota abaixo da referência.

O tempo de parede entra só como **projeção**: turnos que deixaram de perguntar × 14 min de parada média (medição de 09/10).
