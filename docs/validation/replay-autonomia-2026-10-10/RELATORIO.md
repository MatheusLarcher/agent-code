# Validação da autonomia do handoff — replay `a1` (10/10/2026)

Plano `plano-20261010-0616`, etapa `validar`. Arnês: `scripts/replay` (seção "Validação da autonomia" do README). Build: o do checkout em 10/10, com os prompts 1 e 2 do plano implementados.

## Sessão base

**`3708b226-14e5-4348-910a-ccd0f8a397e2`** (06/10, 14:17–16:21Z), conversa de handoff do `plano-20261006-1026` (escritório 3D: cadeira na altura padrão e uma cadeira por agente na sala de reunião). Os contadores estão em `baseline-sessao.json`, tirados do transcript dela no banco do app (`sdk_session_entries`, lido só com SELECT).

Por que esta e não as outras candidatas da medição:

| Candidata | Situação |
|---|---|
| `921d3343` (a preferida do plano) | Pesquisa num repositório do GitHub, que a cerca do arnês nega, e sem commit de referência no período. **Descartada.** |
| `21831ff9` | Era a conversa do Agent Manager: só editou o `_sandbox`. O commit `b85ca69` saiu de outra conversa. **Descartada.** |
| `41fb8e53` | 270 arquivos e 27 h, grande demais para refazer. **Descartada.** |
| `3708b226` | Handoff real que perguntou (1 AskUserQuestion, 1 espera de 7 min, 1 turno terminado em pergunta). A entrega são 3 commits seguidos, `794f767`, `63a4ae5` e `526d549`, 3 min antes do fim da sessão. Referência = faixa `8c89585..526d549`. **Escolhida.** |

## Resultado

| Métrica | Base (sessão real) | novo-r1 | novo-r2 |
|---|---|---|---|
| pergunta (chegou ao usuário) | 1 AskUserQuestion, 1 expirada em 7 min | 0 | 0 |
| insistência (turno terminou perguntando) | 1 turno | 0 | 0 |
| próximo-prompt (fila não soltou) | 0 | 0 | 0 |
| primeiro-prompt-forcado | — | 0 | 0 |
| tempo ativo | 116 min | 52 min | 53 min |
| chamadas ao modelo | 284 | 234 | 181 |
| contexto médio por chamada (tokens) | 416.926 | 111.332 | 109.356 |
| implementação | concluída (sem teto) | timeout (60 min) | timeout (60 min) |
| typecheck / falhas novas / testes sumidos | — | ok / 0 / 2 | ok / 3 / 0 |
| testes de referência | todos | 31/36 | 29/36 |
| revisão às cegas, novo × referência (atende, bugs, bordas, regras) | — | 4×5, 3×5, 3×5, 4×4 | 3×5, 2×5, 3×5, 2×4 |
| linhas ATENÇÃO / DESVIO DO PLANO (não é meta) | 0 / 0 | 1 / 1 | 0 / 1 |

### Veredito por meta

| Meta | Resultado |
|---|---|
| nenhuma pergunta não destrutiva chega ao usuário (`pergunta` = 0) | ✅ 0 / 0 |
| nenhum turno termina perguntando (`insistencia` = 0) | ✅ 0 / 0 |
| a fila solta os prompts 2..N sozinha (`proximo-prompt` = 0) | ✅ 0 / 0 (o handoff saiu em 1 prompt nas duas rodadas, então a fila de 2..N não chegou a ser exercitada) |
| o 1º prompt sai sem o condutor forçar | ✅ 0 / 0 |
| tempo ativo ≤ base | ✅ 52 e 53 min × 116 min |
| chamadas ≤ base | ✅ 234 e 181 × 284 |
| contexto médio ≤ base | ✅ 111k e 109k × 417k |
| implementação dentro do teto de 60 min | ❌ as duas estouraram. O handoff do Manager consumiu ~7 min do orçamento. A sessão base levou 116 min ativos e também não caberia nesse teto. |
| typecheck verde, sem falha nova nem teste sumido | ❌ r1 sumiu com 2 testes de pose; r2 deixou 2 testes de colisão vermelhos e um `_tmpGlbNap.test.ts` de rascunho |
| testes de referência passando | ❌ falhas de comportamento: quem espera a TV troca de cadeira (as duas rodadas); pé na ponta e colisão do cochilo (r2) |
| revisão às cegas sem regressão contra o diff original | ❌ notas abaixo da referência em atende/bugs/bordas nas duas rodadas |

**Veredito: REPROVADO.** As metas de autonomia passaram, as de qualidade não.

- **Autonomia (o que o plano mudou):** atendida. Nenhuma pergunta, nenhum turno terminado em pergunta, nenhuma intervenção do condutor. O tempo ativo caiu para menos da metade, o contexto médio para um quarto e as chamadas ficaram abaixo da base.
- **Qualidade da entrega dentro do teto:** reprovada. Nas duas rodadas o trabalho ficou incompleto no corte de 60 min e a revisão às cegas preferiu a entrega original.

**Tempo de parede (PROJEÇÃO, não medição):** 1 turno a menos terminando em pergunta × 14 min de parada média por turno que perguntava (medição de 09/10) ≈ **14 min de parede poupados por envio**. A espera de 7 min da pergunta expirada também some, mas já está dentro do tempo ativo da base.

## O que aconteceu no caminho (registrado, não ajustado)

1. **Erro do condutor corrigido; as primeiras tentativas foram anuladas.** Com a regra nova de "espera em segundo plano", o agente encerra o turno dizendo "sigo quando terminar" enquanto testes rodam em segundo plano. O condutor via a conversa parada e encerrava a rodada antes de a notificação trazer o agente de volta: a r1 parou aos 32 min e a r2 aos 10 min, sem nenhuma edição. A correção (`drive.mjs`, `pendingBackground`) conta como trabalho a tarefa em segundo plano sem `<task-notification>`. As duas rodadas foram refeitas; as tentativas anuladas e a revisão da r1 anulada estão em `a1/anuladas/`.
2. **O handoff saiu em 1 prompt** nas duas rodadas (37 KB, com `Aceite:`/`Verificar com:` nas 8 etapas). A meta da fila 2..N vale como "não precisou forçar", mas não exercitou a fila de verdade.
3. **O senso crítico apareceu.** Na r1:
   - "DESVIO DO PLANO: o plano preferia aproximar o teclado… nenhuma combinação passa nas duas; … quem tem braço curto inclina o tronco";
   - "ATENÇÃO: no vermelho com 0,59 … o número bate com o '8 de 9' do plano".

## Arquivos

- `baseline-sessao.json`: contadores da sessão base (`scripts/replay/baseline-sessao.mjs`).
- `pedidos/a1.md`: o prompt de handoff real da sessão base (pedido usado na revisão às cegas).
- `a1/baseline.json`: linha de base dos testes no pai `8c89585`. Typecheck ok; suíte com 6204 testes e 4 falhas, das quais 2 persistem isoladas (`AgentCrew.preview`, pré-existentes); testes de referência 25/36 no pai e 85/86 na referência (1 pulado, nenhum falhando).
- `a1/novo-r1`, `a1/novo-r2`: `run.json`, `events.json`, `eval.json`, `diff.patch`, `handoff.md`, `run.log`.
- `a1/revisao/`: notas da revisão às cegas e mapas A/B.
- `resumo-autonomia.json`: o que o `report.mjs` calculou.

Gerado com `node scripts/replay/report.mjs` (seção "Validação da autonomia — a1").
