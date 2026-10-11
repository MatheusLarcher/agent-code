<!-- prompt 1 -->
# Handoff — Altura da mesa/cadeira e cadeira dupla na sala de reunião (escritório 3D)

## Arquivos

**Abra TODOS os arquivos de "Ler antes de começar" numa única resposta, com as leituras em paralelo. Não reexplore o que a lista cobre; use Grep/Glob só para o que faltar. As linhas são pista: o código pode ter mudado desde o planejamento.**

### Ler antes de começar
- `src/renderer/src/office3d/poses.ts:310-378`: `SEAT_HEIGHT` (`chair: 0.59` em :316, sofá e beira da mesa ao lado), `SIT_ON` e `sitLower`. O ramo da cadeira começa em :362, com a pose da cadeira alta: calcanhar erguido e ponta do pé no chão.
- `src/renderer/src/office3d/chairModel.ts` (79 linhas): a cadeira 3D. Só o estofado do assento segue `SEAT_TOP` (:61). O resto tem alturas fixas feitas para 0,59: encosto :62, coluna :65, suporte do encosto :67, braços :75-76. O cabeçalho (:1-11) fala em assento a 0,59 e braços a 0,80.
- `src/renderer/src/office3d/reach.ts` (77 linhas): a IK do braço. `DESK_TOP` :12, `SEATED_HIP` :13, `KEYS_AHEAD` :15, `solve` :30 (o clamp do braço esticado fica em :35), `reach` :44, `typing` :68.
- `src/renderer/src/office3d/officePlan.ts:1-25` e `:60-78`: o cabeçalho (:8-9 diz "assento perto de 0,36 m", já desatualizado), `DESK_HEIGHT = 0.75` :63, `MONITOR_Y` :67, o comentário dos braços a 0,80 acima do tampo (:69-73), `SEAT_FRONT` :74 e `KEYBOARD_FRONT` :76.
- `src/renderer/src/office3d/seatedPose.test.ts` (148 linhas): o teste de colisão da pose sentada (boneco). Ele repete números da cadeira: braços em 0,775–0,815 (:43-44), faixas do encosto de 0,58 a 1,18 (:39-42) e `backFront` com 0,88 (:23). O teste do pé com "ponta no chão" está em :139-141. Leva até 2 min.
- `src/renderer/src/office3d/gestures.ts:30-60` e `:289-301`: as ações sentadas (o `type` usa lean 0,1 em :39 e o `typeFast` usa 0,16 em :43) e o `napDesk`, com ângulos fixos "buscados no rig".
- `src/renderer/src/office3d/reactions.ts:48-95`: `handTip`/`seatedClamp`, com a regra do tampo (:71-73) e a do colo, que usa `SEAT_HEIGHT.chair + 0.12` (:88).
- `src/renderer/src/office3d/motionPick.ts:73-84`: os clipes sentados do Mixamo (máscara upper). Eles não passam pelo teste de colisão.
- `src/renderer/src/office3d/layout.ts:129-155`: `Office3DLayout` e `EMPTY_LAYOUT`.
- `src/renderer/src/office3d/layout.ts:180-266`: `layoutOffice`. As mesas têm memória via `prev.deskOf` (:197-206).
- `src/renderer/src/office3d/layout.ts:269-376`: `placeCharacters`. O lounge tem memória (:275-291), quem está fora de cena não ocupa a cabeceira (:317-319) e a cabeceira não tem memória (:363-366, `managerSeat(counters.manager++)`).
- `src/renderer/src/office3d/meetingRoom.ts` (102 linhas): `WAIT_CHAIRS` :42, `MANAGER_CHAIRS` :51, `managerSeat(i)` :70, `meetingSpots(order, managers)` :77 (exclui as cadeiras pela CONTAGEM) e `sameSpot` :100.
- `src/renderer/src/office3d/scene.ts:129-131`: `onRoom` chama `setVenues(meetingSpots(fila, nº de Managers))`. Isso só roda quando a fila muda.
- `src/renderer/src/office3d/scene.ts:160-225`: `sync(layout)`, que chama `crowd.upsert` em :222. **O arquivo tem 499 linhas.**
- `src/renderer/src/office3d/crowd.ts:228-306`: `setVenues` (:232-239, que refaz o modo com `b.mode = 'init'`) e `upsert` (:272-306, que só troca o `home` em :303). **O arquivo tem 500 linhas.**
- `src/renderer/src/office3d/brain.ts:172` (`decide`), `:266-274` (`enterMode` 'fixed' → `goSeat` no `home`) e `:472-484` (`stepBrain`, que só reage a troca de modo, em :477).
- `src/renderer/src/office3d/projectors.ts:205-212`: a fila da TV só é refeita quando a assinatura (chamados e testes) muda.
- `src/renderer/src/office3d/destinations.test.ts:1-32` (helpers `model`/`world`/`run`) e `:189-254` (o Manager à cabeceira, com "quem espera não toma a cadeira dele" em :207-209, e os chamados na sala).
- `src/renderer/src/office3d/agentCast.test.ts:1-120` e `:155-170`: como abrir o GLB sem o GLTFLoader e passar pelo `prepareAvatar`.
- `src/renderer/src/office3d/agentRest.ts:39-60`: `AvatarTemplate` (`metrics: BodyMetrics` e `fit`, a escala do personagem).
- `scripts/office-agents/app-harness.mjs:1-35`: uso e flags (`--desks`, `--poses`, `--shots-only`, `--keep`).
- `scripts/office-agents/app-harness.mjs:204-229`: o modo `--poses`, que **chama `meetingSpots(['tv', 'cadeira'], 0)` em :214**.
- Mídias, abrir com Read (texto; imagem e PDF o Read também mostra):
  - [Texto] 8ffc37-medidas.txt — D:\agent-code-replay\runs\a1-novo-r1\agent-code\planning\agent-code\plano-20261006-1026\midia\8ffc37-medidas.txt (ombro, cotovelo, punho, quanto falta até o teclado, ângulo do antebraço, joelho e quadril do boneco e dos 9 avatares, com o assento a 0,59 e a 0,46)
  - [Texto] c913ed-cadeiras.txt — D:\agent-code-replay\runs\a1-novo-r1\agent-code\planning\agent-code\plano-20261006-1026\midia\c913ed-cadeiras.txt (cenários A e B da cadeira dupla, reproduzidos com o código real: as coordenadas das cadeiras repetidas)

### Editar/criar
- `src/renderer/src/office3d/poses.ts`: `SEAT_HEIGHT.chair` de 0.59 para 0.46. Atualizar os comentários de :312-315 e :362 e refazer o ramo da cadeira do `sitLower` para o pé ficar apoiado.
- `src/renderer/src/office3d/chairModel.ts`: todas as alturas passam a derivar de `SEAT_TOP`. Exportar as alturas das peças (ex.: `ARM_TOP`, `BACK_CENTER_Y`, `COLUMN_TOP`) e atualizar o cabeçalho.
- `src/renderer/src/office3d/officePlan.ts`: comentários de :8-9 e :69-73. Mexer em `KEYBOARD_FRONT` só se o executor precisar (ver etapa 6).
- `src/renderer/src/office3d/reach.ts`: expor o resultado da IK com "alcançou" e o ângulo do antebraço, para o teste, sem mudar a pose.
- `src/renderer/src/office3d/gestures.ts`: `napDesk` e os ângulos das ações sentadas que baterem no tampo.
- `src/renderer/src/office3d/reactions.ts`: os ângulos que baterem no tampo, se houver.
- `src/renderer/src/office3d/seatedPose.test.ts`: usar as alturas exportadas do `chairModel` e trocar "ponta do pé" por "pé apoiado".
- `src/renderer/src/office3d/seatedReach.test.ts` (novo): o teste de ergonomia por avatar.
- Um helper de teste (novo, ex.: `src/renderer/src/office3d/glbTestScene.ts`), com o leitor de GLB extraído de `agentCast.test.ts`. Neste caso, `agentCast.test.ts` passa a importar dele.
- `src/renderer/src/office3d/layout.ts`: `managerOf` em `Office3DLayout`/`EMPTY_LAYOUT` e a cabeceira com memória.
- `src/renderer/src/office3d/meetingRoom.ts`: `meetingSpots` passa a receber as cadeiras ocupadas pelos Managers (posições) e, de preferência, ganha uma função pura que monta os lugares da sala a partir da fila e do layout.
- `src/renderer/src/office3d/scene.ts`: guardar a última fila do `onRoom` e refazer os lugares da sala também no `sync`.
- `src/renderer/src/office3d/crowd.ts`: quando o `home` de um `fixed` muda, o cérebro volta a `init`.
- `src/renderer/src/office3d/destinations.test.ts`: os testes de regressão da cadeira dupla e o ajuste de :208.
- `scripts/office-agents/app-harness.mjs:214`: acompanhar a assinatura nova do `meetingSpots`.
- `smartfone-remote/www/`: regenerado por `npm run phone:build`.

---

## Objetivo

O usuário vê os agentes do escritório 3D digitando com a mão "lá embaixo" e acha que a mesa está baixa. **A mesa está no padrão** (tampo a 0,775 m, NBR 13966: 720–750 mm). **Quem está fora é a cadeira:** o assento fica a 0,59 m, uns 13 cm acima do padrão (NBR 13962: a partir de 420 mm), e os braços ficam a ~0,80 m, acima do tampo. Por isso o ombro fica alto, o braço estica inteiro para baixo até o teclado e 8 dos 9 avatares nem alcançam. **Baixar o assento para 0,46 m**, refazer a cadeira 3D em volta dele e ajustar a pose sentada: pés no chão e antebraço quase horizontal.

Junto, um segundo defeito: **dois agentes sentados na mesma cadeira da sala de reunião.** Cada cadeira deve ter um agente só.

## Como trabalhar

- **Declare as etapas como plano** (TodoWrite ou TaskCreate) antes de começar, um item por etapa, cada um começando pelo id entre colchetes, na ordem abaixo (ex.: `[diagnostico] Confirmar o diagnóstico e tirar as fotos de antes`).
- **Consulte o planejamento quando precisar, sem replanejar:** D:\agent-code-replay\runs\a1-novo-r1\agent-code\planning\agent-code\plano-20261006-1026 (cards em `cards/`, roteiro em `_roteiro.md`, mídias em `midia/`). Os cards resumidos aqui são a fonte; não reabra as decisões.
- **Tempo de cada etapa:** ao começar, registre a sua estimativa com `mcp__entregas__entrega_estimar` e escreva no chat: "Etapa N — <título>: estimativa do plano X min (prazo), minha estimativa Z min". Ao concluir, consulte `mcp__entregas__entrega_tempo` e escreva: "levou Y min de trabalho (dentro/fora do prazo)" e, se passou, o motivo. O prazo é a estimativa do plano; a sua não o muda, e o tempo que vale é o medido pelo app.
- **Avaliação contínua (avisa, não para):**
  - (a) Antes de cada etapa, rode `git status --short` e `git diff --stat` dos arquivos que ela vai tocar, compare com a seção Arquivos e leia o bloco OUTRAS_CONVERSAS. Escreva uma linha começando com "ATENÇÃO: " (o que mudou e o que vai fazer), adapte e siga, sem reverter nada de ninguém, em três casos: outra conversa mexeu num arquivo seu, o código mudou desde o planejamento (linha não bate, símbolo sumiu) ou uma premissa de card não vale mais.
  - (b) Se a evidência contradiz uma decisão do plano: uma linha começando com "DESVIO DO PLANO: " (o que encontrou e o que fez), e siga.
  - (c) Ao fechar cada etapa, um autocheck de 3 linhas, texto livre e sem nota: "Pode quebrar: …", "Não testei: …", "Olhe isto: …".
  - (d) O relatório final tem a seção **"Atenções"**, com todas as linhas ATENÇÃO e DESVIO DO PLANO.
  - (e) Nada disso é pergunta: avise e siga.
- **Autonomia** (card [[Autonomia da implementação]], `decisao-autonomia-handoff`): **Perguntas: nenhuma. Permissões: permitir tudo, exceto destrutivo.**
  - Destrutivo, que não se faz: `git checkout/restore/reset/stash/clean`, apagar ou reverter arquivo que não é desta mudança, `git push`, mexer em `package.json`/lockfiles, reiniciar ou fechar o app do usuário, versão/instalador.
  - Liberado: editar `src/renderer/src/office3d/**` e `scripts/office-agents/app-harness.mjs`, typecheck/test/build, o harness isolado, `phone:build` (com a regra do risco abaixo) e o commit local no fim.
- **Definition of Done (instrução global do usuário):** typecheck e teste verdes NÃO são "pronto". Antes de dizer que funciona, exercite a mudança no app (aqui, o harness isolado). Se uma parte não deu para exercitar no app, diga isso explicitamente, sem afirmar que funciona.
- Arquivos com menos de 500 linhas (AGENTS.md). `crowd.ts` já tem 500 e `scene.ts` 499: ponha a lógica nova em funções puras de `meetingRoom.ts`/`layout.ts` e deixe nesses dois só a chamada. Se mesmo assim passar, extraia um bloco coeso para um arquivo novo, sem espremer código em linhas longas.

### O que mudou desde o planejamento (já conferido em 10/10/2026)
- Os cards citam `docs/spec/plano-20261006-1026/_sandbox/measure.test.ts` (a conta de alcance) e `cadeiras.test.ts` (os cenários A e B). **Essa pasta não existe nesta árvore** (está no `.gitignore` e não foi preservada). Refaça a partir dos cards, das duas mídias e do `solve` de `reach.ts`.
- `scripts/office-agents/app-harness.mjs:214` chama `meetingSpots(['tv', 'cadeira'], 0)`. Os cards não o listavam, e ele precisa acompanhar a assinatura nova.
- Card de risco do celular: em 06/10, outra conversa ("Conexões múltiplas no app Android") tinha mudanças não commitadas em `src/phone/**` e `package*.json`. Em 10/10, a árvore estava limpa no commit `8c89585` e não havia outro agente trabalhando. A regra continua: confira antes do `phone:build`.

## Etapas e estimativas

| # | Etapa | Estimativa do plano |
|---|---|---|
| 1 | [diagnostico] Confirmar o diagnóstico e tirar as fotos de antes | 5 min |
| 2 | [altura-padrao] Aplicar as alturas padrão (assento 0,46; mesa como está) | 5 min |
| 3 | [diagnostico-cadeira-dupla] Reproduzir a cadeira dupla em teste (vermelho) | 5 min |
| 4 | [assento-exclusivo] Cadeira exclusiva na sala de reunião | 35 min |
| 5 | [ajuste-cadeira] Cadeira 3D derivada do `SEAT_TOP` | 20 min |
| 6 | [ajuste-pose] Pose sentada no assento novo | 45 min |
| 7 | [teste-ergonomia] Teste de ergonomia por avatar | 15 min |
| 8 | [verificacao] Verificação completa, fotos, celular e commit | 30 min |
| | **Total deste prompt** | **160 min (2 h 40 min)** |

---

### 1. [diagnostico] Confirmar o diagnóstico da altura e tirar as fotos de ANTES

Card: [[Diagnóstico: a mesa está no padrão, a cadeira é que está alta]] (anexo [Texto] 8ffc37-medidas.txt, caminho acima).

1. Confirme no código as premissas:
   - `SEAT_HEIGHT.chair = 0.59` (`poses.ts:316`);
   - `DESK_HEIGHT = 0.75` (`officePlan.ts:63`), com `DESK_TOP` = 0,775 (`reach.ts:12`);
   - o apoio dos braços da cadeira centrado em 0,795 (`chairModel.ts:76`);
   - a coluna com o topo a ~0,475 (`chairModel.ts:65`: altura 0,41, centro 0,27).
2. Tire as fotos de **antes**, ANTES de editar qualquer coisa em `src/`. O harness sobe `electron-vite dev` a partir da árvore, então editar durante a captura põe código novo na foto de "antes". Rode as duas em sequência, em segundo plano:
   `node scripts/office-agents/app-harness.mjs --desks --shots-only && node scripts/office-agents/app-harness.mjs --poses --shots-only`
   - `--shots-only` pula a medição de quadro (`app-harness.mjs:162/171`).
   - Cada execução imprime `capturas: <pasta>` (:338). Guarde as duas pastas.
   - O harness é uma cópia DEV isolada (pasta, HOME e banco temporários) e não mexe no app em uso.
   - O tempo de máquina do harness não está nos 5 min do plano: se a etapa passar por isso, o motivo é esse.

Aceite: as quatro premissas conferidas (ou uma linha ATENÇÃO para a que não bater) e as duas pastas de capturas de "antes" existindo, com os PNGs das mesas e dos assentos.
Verificar com: Grep das constantes acima e listagem das duas pastas impressas pelo harness (`ls <pasta>`).
Decidido: as fotos são só de referência visual; não se tira nenhuma medida delas. Se o harness falhar (ex.: falta o Chromium do Playwright), escreva ATENÇÃO com o erro e siga sem as fotos de antes. Na etapa 8, compare com o commit `8c89585` descrito nos cards.

### 2. [altura-padrao] Aplicar as alturas padrão: mesa como está, assento a 0,46

Cards: [[Mesa fica como está; assento da cadeira desce para ~0,46 m]] (decisão) e [[Baixar a cadeira ao padrão em vez de subir a mesa]] (sugestão aceita pelo usuário).
- Fontes: NBR 13962 (assento a partir de 420 mm, com curso de pelo menos 100 mm): https://www.gov.br/icmbio/pt-br/acesso-a-informacao/licitacoes-e-contratos/licitacoes/dispensas/exercicios-anteriores/2020/projeto_basico_dispensa_7_2020_poltronas_giratorias.pdf
- NBR 13966 (mesa de 720/750 mm): https://www.trt7.jus.br/files/contas_publicas/licitacoes/pregao_eletronico/2025/PE_90026_2025/TERMO%20DE%20REFERENCIA%20ANEXO%20I%20-%20VALOR%20ESTIMADO%20E%20ESPECIFICACOES.pdf

1. `poses.ts:316`: `chair: 0.59` passa a `chair: 0.46`.
2. Atualize o comentário de :312-315 (assento padrão a 0,46, NBR 13962).

Aceite: `SEAT_HEIGHT` fica `{ chair: 0.46, sofa: 0.6, desk: 0.775 }`. `DESK_HEIGHT` (0.75) e `MONITOR_Y` (1.12) seguem iguais, e o comentário não fala mais em 0,59.
Verificar com: `git diff src/renderer/src/office3d/poses.ts src/renderer/src/office3d/officePlan.ts` e `npx vitest run src/renderer/src/office3d/agentPoses.test.ts src/renderer/src/office3d/poses.test.ts`. Esses dois seguem `SEAT_HEIGHT.chair` (`agentPoses.test.ts:50`, `poses.test.ts:105`); se falharem, há número fixo em outro lugar, a tratar na etapa 6. O `seatedPose.test.ts` pode ficar vermelho até as etapas 5 e 6, e isso é esperado.
Decidido:
- O valor é 0,46. Pode ir a qualquer ponto entre 0,44 e 0,48 se a pose (etapa 6) pedir, mas nunca sair de 0,42–0,52.
- **Não mudam:** a mesa, o monitor, as divisórias, os objetos da mesa, o console da Central, `SEAT_HEIGHT.sofa` e `SEAT_HEIGHT.desk`.
- Todas as cadeiras de escritório (24 estações e sala de reunião) usam o mesmo modelo e a mesma constante, então descem juntas. A mesa da sala de reunião tem a mesma altura (`decorBack.ts:141`) e é corrigida junto.

### 3. [diagnostico-cadeira-dupla] Reproduzir a cadeira dupla em teste (vermelho)

Card: [[Diagnóstico: dois agentes na mesma cadeira da sala de reunião]] (anexo [Texto] c913ed-cadeiras.txt, caminho acima).

Causa: as cadeiras da sala são distribuídas por dois caminhos que não se falam.
- **Managers** (planejamento aberto): `layout.ts:365`, `managerSeat(counters.manager++)`, sem memória e refeito a cada layout.
- **Quem espera a vez na TV:** `scene.ts:131`, `meetingSpots(fila, nº de Managers)`. Só roda quando a fila da TV muda (`projectors.ts:208-212`) e exclui as cadeiras dos Managers pela CONTAGEM daquele instante.

Escreva em `destinations.test.ts` um `describe` novo ("sala de reunião: uma cadeira por agente"), com um verificador "nenhuma cadeira com dois sentados": agrupe os cérebros com `seat === 'chair'` e `sit > 0.97` pelo assento (`seatX`/`seatZ`, arredondado ao cm) e exija no máximo um por cadeira.
- **Cenário A (fila velha):**
  1. b espera sentado na cabeceira (4,25; −5,40), porque não há Manager.
  2. Abre um planejamento: o Manager novo (`placement: { kind: 'destination', papel: 'reuniao-cabeceira' }`) recebe `managerSeat(0)`, a mesma cabeceira.
  3. A fila não é refeita. Resultado: `conv:b + conv:p` na mesma cadeira.
- **Cenário B (Manager que muda de cadeira sem levantar):**
  1. p1 e p2 sentados nas cadeiras 0 e 1.
  2. O plano de p1 é enviado (`offstage: true`) e, no layout novo, p2 vira o Manager 0. O `crowd.upsert` só troca o `home` e o cérebro continua `fixed`: p2 fica na cadeira 1.
  3. Chega p3, que vira o Manager 1 e vai para a cadeira 1. Resultado: `conv:p2 + conv:p3` em (7,98; −5,40).
- Para simular a cena, use um helper local no teste que faz o que `scene.sync` faz: `layoutOffice(model, prevLayout)` e `crowd.upsert` de cada personagem; os lugares da sala, só quando a fila muda. Depois de cada passo, `run(crowd, 30)` e o verificador.

Aceite: os dois testes novos FALHAM no código atual com dois agentes na mesma cadeira, nas coordenadas de `cadeiras.txt` (A: 4,25; −5,40; B: 7,98; −5,40), e os testes antigos de `destinations.test.ts` continuam verdes.
Verificar com: `npx vitest run src/renderer/src/office3d/destinations.test.ts` (2 vermelhos novos, o resto verde).
Decidido: o `_sandbox/cadeiras.test.ts` citado no card não existe; reconstrua pelos passos acima. Na etapa 4, o helper passa a chamar a mesma função pura que a `scene.ts` vai chamar no `sync`.

### 4. [assento-exclusivo] Cadeira exclusiva na sala de reunião

Cards: [[Cadeiras da sala de reunião: uma por agente]] (requisito) e [["Colisões" é só a cadeira ou também quem se atravessa andando?]] (ambiguidade resolvida).

1. **Cabeceira com memória** (`layout.ts:363-366`). O Manager que já tinha cadeira fica com ela, como as mesas (`prev.deskOf`, :197-206) e o lounge (:275-291). Quem chega pega a primeira livre na ordem de `MANAGER_CHAIRS`. O layout passa a guardar o mapa Manager → cadeira (`managerOf`, como o `deskOf`) em `Office3DLayout` e em `EMPTY_LAYOUT` (:129-155). Assim, a saída de um Manager não faz os outros trocarem de lugar.
2. **A fila da TV usa as cadeiras reais dos Managers e é refeita a cada layout.**
   - `meetingSpots` (`meetingRoom.ts:77`) passa a receber as posições das cadeiras ocupadas pelos Managers, não a contagem.
   - A cena guarda a última fila do `onRoom` e refaz `setVenues(...)` também no `sync()`, quando o layout muda (`scene.ts:131` e `:160`).
   - O `setVenues` já ignora quem não mudou (`sameSpot`).
   - Se um Manager chega numa cadeira em que alguém da fila esperava, **o Manager fica com a cadeira** e quem espera vai para a próxima livre.
3. **O `home` mudou, o cérebro vai para o novo** (`crowd.ts:303`). Se o `home` de um personagem `fixed` (Manager, PO, memória) muda mais de ~5 cm, o modo volta a `init` (como o `setVenues` faz em `crowd.ts:237`): ele levanta e anda até o lugar novo. É a rede de proteção para qualquer lugar dado por contador.
4. **Testes de regressão:**
   - os cenários A e B da etapa 3 ficam verdes;
   - acrescente: um Manager sai e outro chega; dois chamados esperando com dois Managers; o chamado atendido (a fila anda).
   - O teste existente "quem espera na sala não toma a cadeira dele" (`destinations.test.ts:207-209`) continua valendo, com a chamada de :208 na assinatura nova (ex.: `meetingSpots([...], [managerSeat(0)!])`).

Aceite:
- `destinations.test.ts` inteiro verde, inclusive A, B e os três casos novos; nenhuma cadeira com dois sentados em nenhum passo;
- `offstage.test.ts`, `officePlan.test.ts` e `layout.test.ts` verdes (os dois primeiros usam `managerSeat(0)`);
- typecheck verde;
- `scene.ts` e `crowd.ts` com no máximo 500 linhas.

Verificar com: `npx vitest run src/renderer/src/office3d/destinations.test.ts src/renderer/src/office3d/offstage.test.ts src/renderer/src/office3d/officePlan.test.ts src/renderer/src/office3d/layout.test.ts`, `npm run typecheck` e `wc -l src/renderer/src/office3d/scene.ts src/renderer/src/office3d/crowd.ts`.

Decidido:
- **Assinatura:** `meetingSpots(order, held: readonly { x: number; z: number }[] = [])`.
- **Função pura:** crie em `meetingRoom.ts` uma função que tira as cadeiras ocupadas de `layout.characters` (`spot === 'manager'`). A cena (nos dois lugares) e o teste usam a mesma.
- **Harness:** atualize `scripts/office-agents/app-harness.mjs:214` para `meetingSpots(['tv', 'cadeira'], [])`. Ele é JS puro: o typecheck não pega e ele quebra só na hora de rodar `--poses`.
- **Manager fora de cena** (`offstage`) não ocupa cadeira (`layout.ts:317-319`) e libera a dele.
- **Volta ao `init`** só quando o cérebro está no modo `fixed`, sem interromper festa, reunião ou ida ao quadro.
- **Fora do escopo** (decisão do usuário, 06/10/2026): o desvio entre agentes que andam. Hoje eles se atravessam ao andar e isso **não** muda; não mexa na navegação (`nav.ts`, `brain*.ts`) por causa disso.

### 5. [ajuste-cadeira] Cadeira 3D inteira derivada do assento

Card: [[Cadeira 3D inteira derivada do assento]].

Cada peça desce junto com o assento. Hoje só o estofado segue `SEAT_TOP` (`chairModel.ts:61`):
- a **coluna a gás** (:65, topo a ~0,475) atravessaria o assento novo, cujo estofado começa em `SEAT_TOP − 0.14` (~0,32): encurtar até a base do estofado;
- o **encosto** (:62, centro a 0,88) e o **suporte do encosto** (:67, 0,66) descem a mesma distância que o assento (0,59 − `SEAT_TOP`);
- os **braços** (:75-76, colunas a 0,68 e apoio a 0,795) ficam com o topo ~0,20–0,22 m acima do assento (~0,66–0,68 m), **abaixo da face de baixo do tampo** (0,725);
- **não mudam:** a base de 5 pés, os rodízios, `CHAIR_HALF_W`, `CHAIR_BASE_R`, `CHAIR_CENTER_Z` (são o obstáculo da navegação e o recuo) e `CHAIR_PULL`.

**Como:** exporte de `chairModel.ts` as alturas calculadas a partir de `SEAT_TOP` (ex.: `ARM_TOP`, `BACK_CENTER_Y`, `COLUMN_TOP`) e use-as no `seatedPose.test.ts`, no lugar dos números repetidos: braços em :43-44, faixas do encosto em :39-42 e o 0,88 do `backFront` em :23.

**Comentários a atualizar:** o cabeçalho de `chairModel.ts`, `officePlan.ts:8-9`, `officePlan.ts:69-73` (braços abaixo do tampo), `poses.ts:362` ("Cadeira (alta, a do mockup)").

Aceite:
- nenhuma altura literal de peça fora da base e dos rodízios em `officeChairGeometries`;
- `COLUMN_TOP ≤ SEAT_TOP − 0.14`;
- `SEAT_TOP + 0.20 ≤ ARM_TOP ≤ SEAT_TOP + 0.22` e `ARM_TOP < DESK_HEIGHT − 0.025`;
- `seatedPose.test.ts` sem os números fixos da cadeira;
- `party.ts:57` continua usando `SEAT_TOP`.

Verificar com: um teste curto com esses `expect` (em `seatedPose.test.ts` ou num `chairModel.test.ts` novo), mais `npx vitest run` dele e `npm run typecheck`. As specs de colisão podem continuar vermelhas até a etapa 6.
Decidido: as medidas de largura e profundidade do mockup ficam. Só as alturas passam a seguir o assento.

### 6. [ajuste-pose] Pose sentada no assento novo: pés no chão e mãos no teclado

Card: [[Pose sentada no assento novo: pés no chão e mãos no teclado]].

1. **Pernas** (`sitLower`, ramo da cadeira, `poses.ts:362` em diante). Coxa ~horizontal, canela perto da vertical e **pé apoiado no chão** (quem tem canela longa pode ficar com um pouco de ponta de pé). Vale para o boneco e para todos os avatares, cujos joelhos ficam de 46 a 57 cm do chão. Mantenha o `vary` (cada um senta do seu jeito) e os joelhos sob o tampo.
2. **Mãos no teclado** (`typing`/`reach`, `reach.ts`). A IK já usa `SEATED_HIP = SEAT_HEIGHT.chair + 0.075` e acompanha.
   - Exigência: **nenhum avatar com o braço esticado inteiro** ao digitar (`type` e `typeFast`) e o antebraço entre −20° e +20° da horizontal.
   - O executor fica 2 cm curto com o assento a 0,46 (braço curto do modelo; ver `medidas.txt`). Escolha o menor ajuste.
3. **Cochilo na mesa** (`napDesk`, `gestures.ts:289-301`): reajuste os ângulos para a cabeça deitar nos braços sobre o tampo, sem atravessar.
4. **Ações e reações sentadas** (readScreen, drum, sip, web, assist e as reações de `reactions.ts`): o tampo agora fica mais perto do peito. Reajuste os ângulos que baterem no tampo.
5. **Clipes sentados do Mixamo** (sitIdle, sitTalk, sitDrink…, `motionPick.ts:74-84`, máscara upper): eles não passam pelo teste de colisão. Confira na foto que os braços não atravessam a borda da mesa.
6. **Sala de reunião:** mesma cadeira e mesma conta. Confira quem senta lá (foto `--poses`, "reuniao").

Aceite: as 3 specs de `seatedPose.test.ts` verdes, com a 3ª atualizada para "pé apoiado". No boneco, calcanhar e ponta do pé a menos de 2 cm do chão (era "ponta do pé no chão, calcanhar erguido", :139-141), joelho sob o tampo e quadril sobre o assento. As fotos do harness (`--poses` e `--desks`) mostram pés no chão, mãos no teclado, cochilo sobre os braços e os clipes sentados sem atravessar a mesa.
Verificar com: `npx vitest run src/renderer/src/office3d/seatedPose.test.ts src/renderer/src/office3d/poses.test.ts src/renderer/src/office3d/agentPoses.test.ts src/renderer/src/office3d/motion.test.ts` (o `seatedPose` leva até 2 min). Depois, `node scripts/office-agents/app-harness.mjs --poses --shots-only`, abrindo os PNGs com Read. Para um clipe específico, use `--keep` e `scripts/office-agents/cdp-eval.mjs`.
Decidido:
- **Executor:** prefira aproximar o teclado (`KEYBOARD_FRONT`, `officePlan.ts:76`, usado só em `decorIslands.ts:90-91`, `reach.ts:15` e `seatedPose.test.ts:37`) a mexer em `SEAT_FRONT`, que também move o obstáculo da navegação (`furniture.ts:249`), o `layout`, o `party` e o `reactions`. Com o joelho mais baixo sobra espaço sob o tampo. Mantenha o teste "joelhos sob o tampo".
- **Monitor:** não muda. Com o assento a 0,46, os olhos ficam a ~1,25 m e o centro da tela ~13 cm abaixo deles, o recomendado.
- **Assento:** se nenhuma pose fechar a 0,46, pode ir a 0,44–0,48, com uma linha DESVIO DO PLANO.

### 7. [teste-ergonomia] Teste de ergonomia por avatar

Card: [[Teste de ergonomia por avatar]].

Crie `src/renderer/src/office3d/seatedReach.test.ts`, para o problema não voltar quando entrar avatar novo ou mudar uma medida.
- Abra cada GLB de `resources/office-agents` (central, critico, executor, memoria, navegador-de-codigo, po, principal, subagente, vigia) **sem o GLTFLoader**, como faz o `agentCast.test.ts`. Passe pelo `prepareAvatar` e use `t.metrics` (o `b`) e `t.fit` (o `scale`). Teste também o boneco (`BODY`) nas escalas 1 e 0,85.
- Com o agente sentado na cadeira da estação e a IK do `reach.ts` (lean 0,1 do `type` e 0,16 do `typeFast`), exija:
  - (a) o punho no alvo do teclado (`DESK_TOP + 0.055`, `KEYS_AHEAD`) **sem o braço esticado inteiro**: a distância ombro→alvo fica abaixo de `upperArm + forearm`, sem cair no clamp de `reach.ts:35`, com folga de pelo menos 1 cm;
  - (b) o antebraço entre −20° e +20° da horizontal;
  - (c) o quadril acima do assento e o joelho abaixo da face de baixo do tampo.
- Confira também as constantes: assento entre 0,42 e 0,52 (NBR 13962) e tampo (`DESK_TOP`) entre 0,72 e 0,78.

Aceite: `seatedReach.test.ts` verde para o boneco (×1 e ×0,85) e os 9 GLBs, com prova de vermelho e verde. Com `SEAT_HEIGHT.chair` trocado só para o teste para 0.59, ele FALHA como em `medidas.txt` (8 de 9 avatares não alcançam). De volta ao valor novo, PASSA.
Verificar com: `npx vitest run src/renderer/src/office3d/seatedReach.test.ts src/renderer/src/office3d/agentCast.test.ts`, rodado com 0.59 (vermelho) e com o valor final (verde). Volte a constante e confira com `git diff`.
Decidido:
- **A conta:** venha de uma função exportada de `reach.ts` (ex.: o `solve` devolvendo também se alcançou e o ângulo do antebraço), sem copiar a fórmula e sem mudar a pose que o `typing` produz.
- **Calibração:** o `_sandbox/measure.test.ts` (função `seated`) não existe. Calibre a sua conta contra `medidas.txt` (assento 0,46, teclado original: boneco +14°, principal +1°, executor −16° e 2 cm curto, central −18°). Se você moveu o teclado na etapa 6, os números mudam no sentido esperado.
- **Leitor de GLB:** não copie as ~100 linhas do `agentCast.test.ts`. Extraia-as para um helper de teste compartilhado e faça os dois importarem dele.
- **Central:** digita em pé no console, mas entra no teste (a 0,46 ela alcança com −18°). Se só ela falhar por algo do console, exclua-a com comentário e uma linha ATENÇÃO.

### 8. [verificacao] Verificar: typecheck, testes, build, fotos de antes e depois, sala sem cadeira dupla e celular

Cards: [[Verificação e critérios de aceite]], [[Risco: outra implementação mexendo no app do celular]] e [[Autonomia da implementação]].

1. `npm run typecheck`, `npm test` (a suíte toda; o `seatedPose.test.ts` leva até 2 min) e `npm run build`. O build compila também o binário .NET e precisa do dotnet SDK: se faltar, diga isso, sem dar o build como verde.
2. **Fotos de depois:** `node scripts/office-agents/app-harness.mjs --desks --shots-only` e `--poses --shots-only`. Mostre ao usuário as de antes (etapa 1) ao lado das de depois, com os caminhos.
3. **Sala sem cadeira dupla no app:** a prova é o teste de regressão. Além dele, no harness com `--keep` e `scripts/office-agents/cdp-eval.mjs`, tente exercitar o cenário B na cena isolada (dois Managers, um sai e outro chega) e confira um agente por cadeira. O harness não tem login do Claude e não abre planejamento de verdade. Se não der para exercitar no app isolado, diga explicitamente que essa parte não foi exercitada no app e por quê.
4. **Celular:**
   - Antes do `npm run phone:build`, rode `git status --short`. Se houver mudanças que não são suas em `src/phone/**` ou `package*.json`, escreva ATENÇÃO e **não** rode o `phone:build`: o bundle levaria código alheio pela metade. Avise o usuário.
   - Com a árvore só com as suas mudanças, rode `npm run phone:build`. Ele regenera `smartfone-remote/www/`, que entra no commit.
5. **Commit local:**
   - Só os arquivos desta mudança: `src/renderer/src/office3d/**`, `scripts/office-agents/app-harness.mjs` e `smartfone-remote/www/`.
   - Sem `git push`, sem `Co-Authored-By` (AGENTS.md), sem versão nem instalador.
   - Mensagem no estilo do repositório, ex.: `fix(escritorio): assento da cadeira no padrão (0,46 m), pose sentada com pés no chão e uma cadeira por agente na sala de reunião`.
   - Não reverta nem inclua arquivos de outras conversas.

Aceite: os critérios do card [[Verificação e critérios de aceite]], todos com evidência:
1. sentado digitando, o boneco e os avatares que sentam ficam com as mãos no teclado na altura do cotovelo (antebraço quase horizontal), sem nenhum braço esticado;
2. os braços da cadeira ficam abaixo do tampo e a coluna não atravessa o assento;
3. os pés ficam no chão;
4. no cochilo na mesa, a cabeça fica sobre os braços no tampo e nada atravessa;
5. quem senta na sala de reunião fica certo;
6. sala de reunião sem cadeira dupla: o teste de regressão passa e, no app, cada agente fica na sua cadeira (ou a declaração explícita do que não deu para exercitar);
7. typecheck, testes (inclusive o `seatedReach.test.ts`) e build passam;
8. o usuário confere no PC e no celular. Isso é o julgamento visual dele; a prova de que funciona é sua.

Verificar com: a saída de `npm run typecheck`, `npm test` (0 falhas) e `npm run build` (exit 0), as pastas de capturas de antes e de depois, `git status --short` antes do `phone:build` e `git show --stat HEAD` depois do commit.
Decidido:
- Se `npm test` falhar num teste que não é do escritório 3D (ex.: `src/phone/core/pcs.test.ts`, de outra conversa), não é desta mudança: avise com ATENÇÃO em vez de "consertar".
- O relatório final traz: o que mudou por etapa, as evidências, as fotos lado a lado, o que não foi exercitado e a seção **"Atenções"**.

---

## Resumo dos cards (para não precisar abrir)

- **Decisão** [[Mesa fica como está; assento da cadeira desce para ~0,46 m]]: a mesa não muda e o assento vai a 0,46 (0,44–0,48 se a pose pedir; nunca fora de 0,42–0,52). Braços a ~0,66–0,68. Sofá e beira da mesa ficam como estão. *Por quê:* a cadeira é que está 13 cm acima do padrão; baixar resolve o alcance e os pés e custa menos que subir a mesa com tudo o que está sobre ela.
- **Sugestão aceita** [[Baixar a cadeira ao padrão em vez de subir a mesa]] (fontes ICMBio/NBR 13962 e TRT7/NBR 13966, URLs na etapa 2). A alternativa descartada era subir o tampo para ~0,87 m: fica fora do padrão, com altura de balcão, e tem mais peças para mexer.
- **Ambiguidade resolvida** [["Colisões" é só a cadeira ou também quem se atravessa andando?]]: o usuário escolheu "só lugares" (06/10/2026). O desvio entre quem anda fica fora.
- **Requisitos:** [[Cadeiras da sala de reunião: uma por agente]], [[Cadeira 3D inteira derivada do assento]], [[Pose sentada no assento novo: pés no chão e mãos no teclado]], [[Teste de ergonomia por avatar]] e [[Verificação e critérios de aceite]].
- **Notas:** [[Diagnóstico: a mesa está no padrão, a cadeira é que está alta]], [[Diagnóstico: dois agentes na mesma cadeira da sala de reunião]] e [[Risco: outra implementação mexendo no app do celular]].
- **Autonomia** [[Autonomia da implementação]]: perguntas, nenhuma; permissões, tudo exceto destrutivo.

## Riscos

- **App do celular:** o `phone:build` empacota a árvore inteira. Se houver mudança alheia em `src/phone/**`, não rode (etapa 8).
- **Limite de 500 linhas:** `crowd.ts` (500) e `scene.ts` (499) estão no teto.
- **Harness:** editar `src/` durante a captura de "antes" contamina a foto. Além disso, `app-harness.mjs:214` quebra em tempo de execução se a assinatura do `meetingSpots` mudar e ele não for atualizado.
- **Clipes do Mixamo sentados:** não têm teste automático de colisão; só a foto pega.
- **Mexer em `SEAT_FRONT`** mexe também na navegação e no layout; prefira `KEYBOARD_FRONT`.
- **Tempo:** o `seatedPose.test.ts` é lento (até 2 min) e o `npm run build` depende do dotnet SDK.
- **Pastas que não existem:** o `_sandbox` citado nos cards não existe; as contas e os cenários são refeitos a partir das mídias.
