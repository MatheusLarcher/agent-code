# Validação do Scrum Master — app real, instância isolada (11/10/2026)

Instância isolada (`--user-data-dir` próprio, sem tocar no app instalado), `AGENT_CODE_SCRUM_ESCALA=0.05`
(o prazo de 80 min vira 4 min), conversa `cmv46zo893qa8u` — "Implementação: Validação do Scrum Master",
projeto de teste `smproj` com duas etapas (`laco`, `arquivo-b`). Roteiro: `validar-scrum.mjs`.
Saída: `execucao.log`, `resultado.json`, `diario.jsonl` (cópia do `scrum-decisions.log`, 10 linhas).

| # | Cenário | Resultado | Evidência |
|---|---------|-----------|-----------|
| 1 | Cobrança em 150% e 200% com `additionalContext` na transcrição | OK | `transcricao-cobrancas.md` (3 anexos `hook_additional_context` do PostToolUse:Bash: etapa 1 a 1,5× e 2×, etapa 2 a 1,5×); `diario.jsonl` linhas `cobrou` marco 150 e 200 |
| 2 | Toast `scrum` | OK | `02-aviso-scrum-1..4.png`; textos em `resultado.json` → `notas` |
| 3 | Parada PARAR em 300%, fila segurando | OK | `03-parada-300.png`, `03-fila-segura.png` ("1 prompt esperando no quadro — o próximo parou…"); `execucao.log`: "fila segurou 60 s: true"; diário `parou` marco 300 veredito `parar` |
| 4 | Corte de agente travado, que recebe a mensagem e continua | PARCIAL — ver Atenção | `04-continuou-etapa.png` (o agente retomou depois da parada e entregou `arquivo-b`); diário `deixou-seguir` |
| 5 | Espera declarada (`entrega_aviso_demora`) não cortada | OK | `05-declarado-sem-corte.png`; diário `declarou` (espera.js) → `deixou-seguir` "dentro do tempo declarado" |

## Atenção — cenário 4

No `arquivo-b` (`node lento.js` em primeiro plano, sem declaração), o modelo do SM deu o veredito
**justificado** e o diário registrou `deixou-seguir`, com o motivo "Sem respostas de texto ainda e cobrança
pendente sem chegar ao agente…". Por isso o corte do travado não aconteceu nesta rodada. O agente seguiu e
entregou a etapa. Como o plano manda, o veredito não foi forçado em código de produção.

O corte e a continuação depois dele estão cobertos por testes unitários:

- `src/main/scrum/scrumMaster.test.ts`:
  - :214 — sem declaração, DESVIO corta sem as marcas do Stop e manda a mensagem;
  - :247 — passada a declaração, corta;
  - :262 — o stallWatch já encerrou: não corta;
  - :281 — uma intervenção forte por envio;
- `src/main/handoffTracking/handoffQueueError.test.ts:115` — a parada do SM segura a fila;
- `src/main/scrum/scrumMarks.test.ts` :191 e :202 — `travadoDue`, inclusive com a escala de dev.

A continuação de uma conversa parada pelo SM foi vista no app real, depois da parada de 300% (`04-continuou-etapa.png`).

# Escritório 3D e painel do SM — etapa [visual]

Instância isolada em DEV, com a demo de 5 salas do escritório e o diário semeado a partir do `diario.jsonl` acima
(projeto trocado, mais 3 cobranças de ontem). As perguntas ao SM vão ao modelo de verdade.
Roteiro: `validar-painel.mjs`. Saída: `painel-execucao.log`, `painel-resultado.json`, `painel-conversa.jsonl`
e `painel-rodada1.log`.

Foram três rodadas. A rodada 1 foi a única com a janela visível o tempo todo e parou no "fechar e reabrir"
por um erro do roteiro. A rodada 2 achou um defeito real, o diário ilegível aparecendo como vazio, que foi
corrigido com `readScrumLogStrict` só na aba Histórico. Na rodada 3 a janela da instância ficou minimizada
(`IsIconic`): o Chromium reduz o rAF a cerca de 1 Hz. Isso derrubou o fps, a visita da demo e o clique da
reabertura com a câmera em movimento (o clique depois do F5 e o do diário ilegível passaram). Ela deu 23 OK e
2 falhas e foi parada antes de relançar o app, porque a memória livre não voltou a 4 GB. A visita e o tempo de
quadro valem os da rodada 1. O reinício vale o da rodada 2 (`painel-resultado.json` é dessa rodada).
`painel-execucao.log` é o da rodada 3.

| Check | Resultado | Evidência |
|-------|-----------|-----------|
| Um SM por sala com quadro, com o avatar `scrum.glb` | OK | `10-sm-na-sala.png`, `10-sm-de-perto.png` |
| A visita leva o SM à mesa do agente | OK (rodada 1) | `11-sm-visita.png`; `painel-rodada1.log` linha 8 |
| Clique no SM abre o painel e o chat flutuante some | OK (1 clique falhou com a janela minimizada) | `12-painel-agora.png` |
| Agora vazio sem envio em andamento | OK | `12-painel-agora.png` |
| Histórico com o corte, Hoje aberto e Ontem fechado com o resumo | OK | `13-painel-historico.png` |
| Questionar abre a Conversa com o "Sobre:" do corte | OK | `14-painel-conversa-resposta.png` |
| Pergunta e contestação respondidas pelo modelo | OK | `15-painel-conversa-contestado.png`; `painel-conversa.jsonl` |
| Marca de contestado com a frase e o selo "1 contestado" | OK | `16-historico-contestado.png` |
| Persistência após fechar e reabrir e F5 | OK | `painel-execucao.log` |
| Persistência após reiniciar o app | OK (rodada 2) | `18-reiniciado-contestado.png`; `painel-resultado.json` |
| Diário ilegível mostra o erro, e o Histórico volta depois | OK (rodada 3; falhava na 2, corrigido) | `17-historico-erro.png` |

**Tempo de quadro** (rodada 1, demo de 5 salas, 25 personagens, 20 s): 59,85 fps, 16,72 ms por quadro,
P95 19,83 ms (pior janela 22,3 ms), 4,06 ms de trabalho por quadro (P95 5,3), 254 draw calls,
629.821 triângulos. Na rodada 3, com a janela minimizada, o trabalho por quadro ficou em 3,23 ms
com 33 personagens. O fps 1 dela é do rAF reduzido, não do motor.

**Comparação com os mockups**

- `16-historico-contestado.png` ≈ `916995-painel-hist.png`: chips de filtro e período, grupos por dia,
  cartão do corte com a marca vermelha e "Ver a conversa contestada", e o selo na aba.
- `15-painel-conversa-contestado.png` ≈ `646fd9-painel-chat.png`: aviso de guarda, "Sobre:", balões VC e SM.
  O compositor fica no fim da rolagem, e não fixo, como no mockup.

**Olhe isto**

- Com o painel aberto e o foco no SM, o SM fica atrás do painel (prints 12, 15 e 16). A câmera não desconta
  a largura do painel.
- O `scrum.glb` tem 12.683.896 B, sem compactação, como o plano manda.
- A prévia ao passar o mouse no SM com o painel aberto não aparece.
