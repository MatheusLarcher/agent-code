<!-- prompt 1 -->
# Arquivos

Abra TODOS os arquivos de "Ler antes de começar" numa única resposta, com as leituras em paralelo. Não reexplore o que a lista cobre; use Grep/Glob só para o que faltar. As linhas são pista: o código pode ter mudado desde o planejamento.

Caminhos relativos à raiz do projeto `D:\agent-code-replay\a1\agent-code`. Linhas conferidas em 10/10/2026 sobre o commit `8c89585`.

## Ler antes de começar

- `src/renderer/src/office3d/poses.ts:310-378`: `SeatKind`, `SEAT_HEIGHT` (`:316`, cadeira 0.59), `SIT_ON` (`:319`), `sitLower` (`:331`). O sofá (`:343-360`) já calcula "pé apoiado" (`:346`); o ramo da cadeira (`:362-377`) é o da "ponta do pé".
- `src/renderer/src/office3d/chairModel.ts:1-79`: a cadeira 3D. `SEAT_TOP` (`:18`). Só o estofado (`:61`) segue `SEAT_TOP`. Encosto `:62`, coluna `:65`, cubo `:66`, suporte do encosto `:67`, base e rodízios `:69-73` e braços `:74-77` usam números fixos.
- `src/renderer/src/office3d/reach.ts:1-77`: `DESK_TOP` (`:12`), `SEATED_HIP` (`:13`), `KEYS_AHEAD` (`:15`), a IK `solve` (`:30-41`, privada), `reach` (`:44`) e `typing` (`:68`, alvo `DESK_TOP + 0.055`).
- `src/renderer/src/office3d/officePlan.ts:1-10` e `:60-78`: o cabeçalho (`:8-9`, "assento perto de 0,36 m", desatualizado), `DESK_HEIGHT` (`:63`), `MONITOR_Y` (`:67`), o comentário dos braços a 0,80 (`:69-73`), `SEAT_FRONT` (`:74`) e `KEYBOARD_FRONT` (`:76`).
- `src/renderer/src/office3d/seatedPose.test.ts:1-140`: o teste de colisão sentado. Repete números da cadeira antiga: `backFront` com 0.88 (`:23`), faixas do encosto 0.58–1.18 (`:39-42`) e braços 0.775–0.815 (`:43-44`). Os joelhos ficam sob o tampo em `:138`.
- `src/renderer/src/office3d/gestures.ts:289-301`: `napDesk`, com ângulos fixos "buscados no rig".
- `src/renderer/src/office3d/reactions.ts:61-96`: `seatedClamp` (usa `DESK_TOP` e `SEAT_HEIGHT.chair + 0.12`).
- `src/renderer/src/office3d/motionPick.ts:73-84`: os clipes sentados do Mixamo (máscara `upper`).
- `src/renderer/src/office3d/party.ts:57`: o que fica sobre o assento na festa (`SEAT_TOP + 0.03`).
- `src/renderer/src/office3d/decorBack.ts:141-142`: a mesa da sala de reunião em `DESK_HEIGHT`.
- `src/renderer/src/office3d/agentCast.test.ts:1-80` e `:158-184`: abre os GLB de `resources/office-agents` sem o GLTFLoader (`readGlb`, `buildScene`) e chama `prepareAvatar` → `t.metrics`.
- `src/renderer/src/office3d/agentRest.ts:39-60`: `AvatarTemplate` (`metrics`, `fit`).
- `src/renderer/src/office3d/agentBody.ts:47`: a escala do personagem, `template.fit ?? (principal ? 1 : 0.85)`.
- `src/renderer/src/office3d/layout.ts:129-155` (`Office3DLayout` com `deskOf`/`islandOf`; `EMPTY_LAYOUT` em `:155`), `:180-266` (`layoutOffice(model, prev)`; as mesas com memória em `:197-206`) e `:269-376` (`placeCharacters`; o lounge com memória em `:275-291`; a cabeceira **sem memória** em `:363-366`).
- `src/renderer/src/office3d/meetingRoom.ts:1-102`: `WAIT_CHAIRS` (`:42`), `MANAGER_CHAIRS` (`:51`), `managerSeat` (`:70`), `meetingSpots(order, managers)` (`:77`, exclui as cadeiras dos Managers **pela contagem**) e `sameSpot` (`:100`).
- `src/renderer/src/office3d/scene.ts:129-131` (`onRoom` → `setVenues(meetingSpots(order, nº de Managers))`) e `:160-185` (`sync(layout)`).
- `src/renderer/src/office3d/crowd.ts:232-239` (`setVenues`: lugar novo → `mode = 'init'`) e `:272-306` (`upsert`; em `:303` troca só o `home`, sem mexer no modo).
- `src/renderer/src/office3d/brain.ts:472-484`: `stepBrain` só reage a troca de modo (`:477`).
- `src/renderer/src/office3d/projectors.ts:203-214`: `emitRoom` só emite quando a fila da TV muda.
- `src/renderer/src/office3d/destinations.test.ts:1-32` (`model`, `world`, `run`) e `:189-211` (o teste do Agent Manager; `:207-209` "ninguém senta na cadeira do Manager").
- `src/renderer/src/office/adapter/model.ts:164`: **já existe** um `managerOf` (implementação → planejamento), que é outra coisa (veja "Decidido" da etapa 4).
- `scripts/office-agents/app-harness.mjs:1-60`: o harness isolado e as flags `--desks` e `--poses`.

## Editar/criar

- `src/renderer/src/office3d/poses.ts`: `SEAT_HEIGHT.chair` 0.59 → 0.46. Comentários `:312-315` e `:326-327` e `:362-364`. O ramo da cadeira de `sitLower` passa a deixar o pé apoiado no chão.
- `src/renderer/src/office3d/chairModel.ts`: o cabeçalho e as alturas das peças derivadas de `SEAT_TOP`, exportadas (ex.: `ARM_TOP`, `BACK_CENTER_Y`, `BACK_BOTTOM`, `BACK_TOP`, `COLUMN_TOP`).
- `src/renderer/src/office3d/officePlan.ts`: os comentários `:8-9` e `:69-73`. Só se o executor não alcançar o teclado, `KEYBOARD_FRONT` (`:76`) ou `SEAT_FRONT` (`:74`).
- `src/renderer/src/office3d/reach.ts`: exportar uma função de diagnóstico da IK (ex.: `reachInfo`) que diz se alcançou e dá o ângulo do antebraço, sem mudar a conta de `solve`.
- `src/renderer/src/office3d/gestures.ts`: `napDesk` e as ações sentadas que baterem no tampo.
- `src/renderer/src/office3d/reactions.ts`: só se alguma reação bater.
- `src/renderer/src/office3d/seatedPose.test.ts`: usar as alturas exportadas por `chairModel.ts` no lugar dos números fixos.
- `src/renderer/src/office3d/seatedReach.test.ts` (**novo**): o teste de ergonomia por avatar.
- `src/renderer/src/office3d/agentCast.test.ts` e um helper de teste novo (ex.: `src/renderer/src/office3d/testGlb.ts`, no padrão do `testBrowserApi.ts` que já existe): mover `readGlb`/`buildScene` para lá e usá-los nos dois testes.
- `src/renderer/src/office3d/layout.ts`: o mapa Manager → cadeira no `Office3DLayout` (e no `EMPTY_LAYOUT`) e a cabeceira com memória.
- `src/renderer/src/office3d/meetingRoom.ts`: `meetingSpots` passa a receber as posições das cadeiras dos Managers.
- `src/renderer/src/office3d/scene.ts`: guardar a última fila da TV e refazer `setVenues` também no `sync`.
- `src/renderer/src/office3d/crowd.ts`: em `upsert`, se o `home` de um `fixed` mudou mais de 5 cm, o modo volta a `init`.
- `src/renderer/src/office3d/destinations.test.ts`: os testes de regressão da cadeira dupla.
- `smartfone-remote/www/`: regerado por `npm run phone:build`, só nas condições da etapa 8.

---

# Handoff: altura da mesa (a cadeira no padrão) e uma cadeira por agente na sala de reunião

## Objetivo

O usuário vê os agentes do Escritório 3D digitando com a mão "lá embaixo" e acha a mesa baixa. O diagnóstico mostrou que **a mesa já está no padrão** (tampo a 0,775 m) e **a cadeira é que está alta** (assento a 0,59 m, braços a ~0,80 m, acima do tampo). Por isso o braço estica inteiro para baixo até o teclado: 8 de 9 avatares nem alcançam.

Entregar:
1. o assento da cadeira no padrão (**0,46 m**), com a cadeira 3D inteira derivada dele, os braços abaixo do tampo e a pose sentada refeita: pés no chão, mãos no teclado com o antebraço quase horizontal, cochilo e reações sem atravessar nada;
2. um teste de ergonomia por avatar, para isso não voltar;
3. o fim de **dois agentes sentados na mesma cadeira da sala de reunião**: a cabeceira com memória, a fila da TV com as cadeiras reais dos Managers e o "home novo levanta o agente";
4. a verificação completa: typecheck, testes, build, as fotos de antes e de depois e o app do celular.

## Como trabalhar

- **Declare as etapas como plano** (TodoWrite/TaskCreate) **antes de começar**, um item por etapa, na ordem abaixo e cada um começando pelo id entre colchetes. Ex.: `[diagnostico] Conferir o diagnóstico no código e tirar as fotos de antes`.
- **Pasta do plano:** `D:\agent-code-replay\runs\a1-novo-r1\agent-code\planning\agent-code\plano-20261006-1026` (cards em `cards/`). Consulte pontualmente quando um detalhe faltar aqui. **Não replaneje**: o plano está fechado. O que a evidência contradisser vira "DESVIO DO PLANO:" (abaixo).
- **Tempo de cada etapa (obrigatório):**
  - ao começar cada etapa, registre a sua estimativa com `mcp__entregas__entrega_estimar` e escreva no chat: `Etapa N — <título>: estimativa do plano X min (prazo), minha estimativa Z min`;
  - ao concluir, consulte `mcp__entregas__entrega_tempo` e escreva: `levou Y min de trabalho (dentro/fora do prazo)` e, se passou, o motivo;
  - o prazo é a estimativa do plano. A sua não muda o prazo, e o tempo que vale é o medido pelo app.
- **Autonomia** (card `decisao-autonomia-handoff`):
  - **Perguntas: nenhuma.** Decida pelos cards e por este texto.
  - **Permissões: permitir tudo, exceto o destrutivo.** Destrutivo aqui: git reset/checkout/restore/stash/clean; apagar arquivos que não são seus; push; mexer em `package*.json` ou lockfile; rodar `phone:build` com mudanças de outra conversa em `src/phone/**` ainda não commitadas.
  - Por quê: é ajuste visual de um app desktop local, sem produção, dados reais, deploy, dinheiro nem integração externa, e o harness de fotos é isolado.
- **Avaliação contínua (avisa, não para):**
  - (a) Antes de cada etapa, rode `git status --short` e `git diff --stat -- <arquivos da etapa>`, compare com a seção Arquivos acima e leia o bloco OUTRAS_CONVERSAS. Se outra conversa mexeu num arquivo seu, se o código mudou desde o planejamento (a linha não bate, o símbolo sumiu) ou se uma premissa de card não vale mais, escreva no chat uma linha que começa com `ATENÇÃO: ` dizendo o que mudou e o que vai fazer. Não reverta nada de ninguém: adapte e siga.
  - (b) Se uma decisão do plano for contradita pela evidência, escreva uma linha que começa com `DESVIO DO PLANO: ` com o que encontrou e o que fez, e siga.
  - (c) Ao fechar cada etapa, um autocheck de 3 linhas em texto livre, sem nota: `Pode quebrar: …`, `Não testei: …`, `Olhe isto: …`.
  - (d) O relatório final tem a seção **"Atenções"**, com todas as linhas ATENÇÃO e DESVIO DO PLANO.
  - (e) Nada disso é pergunta: avise e siga.
- **Pronto é o que foi rodado e visto.** Typecheck e testes verdes não bastam. Rode o app (harness) e olhe as fotos. O que não conseguir validar de verdade, diga que não validou.
- **Regras do repositório** (AGENTS.md):
  - arquivos com menos de 500 linhas;
  - commit sem `Co-Authored-By`;
  - nada de arquivo de trabalho na raiz;
  - `npm run build` também compila o binário .NET (precisa do dotnet SDK).

## Estado no momento do handoff (10/10/2026)

- Branch `master`, HEAD `8c89585`, árvore limpa e nenhum outro agente trabalhando. Confira de novo ao começar.
- **Os arquivos de _sandbox citados nos cards NÃO existem mais**: `docs/spec/plano-20261006-1026/_sandbox/measure.test.ts` e `cadeiras.test.ts` (a pasta `docs/spec/plano-20261006-1026/` não existe). Não os procure. A lógica deles está descrita aqui (etapas 3 e 7), e os resultados estão nas mídias abaixo.
- `docs/spec/*/_sandbox/` está no `.gitignore` (`.gitignore:52`). Use `docs/spec/plano-20261006-1026/_sandbox/fotos/` para guardar as fotos de antes e de depois, fora do commit.

## Mídias (abra com Read: o Read lê texto; imagem e PDF ele mostra de verdade)

- [Texto] 8ffc37-medidas.txt — D:\agent-code-replay\runs\a1-novo-r1\agent-code\planning\agent-code\plano-20261006-1026\midia\8ffc37-medidas.txt
  As medidas do boneco e dos 9 avatares com o assento a 0,59 e a 0,46, em cm em relação ao tampo: ombro, cotovelo, punho, quanto falta para o teclado, ângulo do antebraço, se alcança, altura do joelho e do quadril. É a referência de "antes" e de "esperado" das etapas 6 e 7.
- [Texto] c913ed-cadeiras.txt — D:\agent-code-replay\runs\a1-novo-r1\agent-code\planning\agent-code\plano-20261006-1026\midia\c913ed-cadeiras.txt
  A saída da reprodução dos cenários A e B da cadeira dupla (quem senta onde, a cada passo). É o "vermelho" esperado da etapa 3.

## Etapas e estimativas

| # | Etapa | Estimativa (min de agente) |
|---|---|---|
| 1 | diagnostico | 5 |
| 2 | altura-padrao | 5 |
| 3 | diagnostico-cadeira-dupla | 5 |
| 4 | assento-exclusivo | 35 |
| 5 | ajuste-cadeira | 20 |
| 6 | ajuste-pose | 45 |
| 7 | teste-ergonomia | 15 |
| 8 | verificacao | 30 |
| | **Total deste prompt** | **160 min (2 h 40 min)** |

---

### 1. [diagnostico] Conferir o diagnóstico no código e tirar as fotos de antes

Card: [[Diagnóstico: a mesa está no padrão, a cadeira é que está alta]].

Confirme no código os números do diagnóstico (abaixo) e, **antes de mudar qualquer linha**, tire as fotos de antes com o harness isolado:
- `node scripts/office-agents/app-harness.mjs --desks`: as 24 mesas, com o boneco e com o avatar;
- `node scripts/office-agents/app-harness.mjs --poses`: um agente em cada assento (mesa, cochilo na mesa, reunião, sofá).

O harness sobe uma cópia DEV do app com pasta, HOME e banco temporários e grava as capturas numa pasta temporária (o caminho sai no relatório, campo `tmp`). Copie as capturas para `docs/spec/plano-20261006-1026/_sandbox/fotos/antes/`.

Aceite: os números abaixo batem com o código (ou cada diferença tem uma linha ATENÇÃO) e as capturas de `--desks` e `--poses` estão em `docs/spec/plano-20261006-1026/_sandbox/fotos/antes/`.
Verificar com: `Grep` de `SEAT_HEIGHT`, `DESK_HEIGHT`, `MONITOR_Y` e `0.795` em `src/renderer/src/office3d/`; `ls docs/spec/plano-20261006-1026/_sandbox/fotos/antes/`; abrir 2 ou 3 capturas com Read.
Decidido:
- Os números esperados:
  - `DESK_HEIGHT = 0.75` (`officePlan.ts:63`), tampo a `DESK_TOP` = 0,775 (`reach.ts:12`), faixa ABNT NBR 13966 de 720–750 mm: a mesa está no padrão;
  - `SEAT_HEIGHT.chair = 0.59` (`poses.ts:316`), ~13 cm acima do padrão (NBR 13962, 420–520 mm);
  - braços da cadeira a 0,795 (`chairModel.ts:76`), acima do tampo;
  - do assento ao tampo, 18,5 cm (o certo é ~27–30 cm).
- O monitor (`MONITOR_Y = 1.12`) não muda: com o assento a 0,46 os olhos ficam a ~1,25 m e o centro da tela ~13 cm abaixo deles, como recomendado.
- Se o harness não subir (porta, electron-vite, Playwright), registre em "Não testei" e siga. Não instale nada global.

### 2. [altura-padrao] Aplicar as alturas padrão: a mesa fica, o assento desce para 0,46

Cards: [[Mesa fica como está; assento da cadeira desce para ~0,46 m]] e [[Baixar a cadeira ao padrão em vez de subir a mesa]] (sugestão aceita pelo usuário).

Troque `SEAT_HEIGHT.chair` de `0.59` para `0.46` (`poses.ts:316`) e atualize o comentário `:312-315`.

Aceite: `SEAT_HEIGHT` é `{ chair: 0.46, sofa: 0.6, desk: 0.775 }`; `DESK_HEIGHT` continua 0.75; `poses.test.ts` e `agentPoses.test.ts` passam.
Verificar com: `npx vitest run src/renderer/src/office3d/poses.test.ts src/renderer/src/office3d/agentPoses.test.ts`.
Decidido:
- O assento pode ficar entre **0,44 e 0,48** se a pose pedir, mas **nunca fora de 0,42–0,52** (NBR 13962).
- A mesa, o monitor, as divisórias, o teclado, os objetos da mesa, o console da Central e a mesa da reunião **não mudam**. O sofá (`SEAT_HEIGHT.sofa`) e a beira da mesa (`SEAT_HEIGHT.desk`) também não: estão fora do pedido.
- Todas as cadeiras de escritório (24 estações e sala de reunião) usam a mesma constante e descem juntas.
- É **esperado** que `seatedPose.test.ts` falhe entre esta etapa e a 6: as alturas da cadeira e a pose ainda são as antigas. Não "conserte" o teste agora.
- `poses.test.ts:105` e `agentPoses.test.ts:50` comparam com `SEAT_HEIGHT.chair + …` e acompanham sozinhos.

### 3. [diagnostico-cadeira-dupla] Reproduzir a cadeira dupla num teste (vermelho)

Cards: [[Diagnóstico: dois agentes na mesma cadeira da sala de reunião]] e [[Cadeiras da sala de reunião: uma por agente]] (item 4).

Escreva em `destinations.test.ts` os testes de regressão que reproduzem os dois furos e veja-os **falhar** no código atual. Use `model`, `world` e `run` (`destinations.test.ts:10-32`); para o layout novo, use `layoutOffice(modelNovo, layoutAnterior)` e depois `crowd.upsert` de cada personagem, como o `world` faz. A checagem comum é um helper `semCadeiraDupla(crowd)`: agrupa os cérebros sentados (`sit === 1 && seat === 'chair'`) pela posição (x, z) arredondada a 1 cm e exige que nenhuma posição tenha 2 chaves.

- **Cenário A, fila velha:**
  1. `conv:a` está ao lado da TV e `conv:b` espera sentado. `crowd.setVenues(meetingSpots([{key:'conv:a',call:true},{key:'conv:b',call:true}], <sem Managers>))` põe b na cabeceira (4,25; −5,40).
  2. Entra um Manager `conv:p` (`placement: { kind: 'destination', papel: 'reuniao-cabeceira' }`) num layout novo: ele recebe `managerSeat(0)`, a mesma cabeceira.
  3. Hoje a fila não é refeita, e b e p acabam na mesma cadeira.
- **Cenário B, o Manager que muda de cadeira sem levantar:**
  1. Os Managers p1 e p2 estão sentados nas cadeiras 0 e 1.
  2. p1 sai de cena: o plano dele foi enviado, `offstage: true` no modelo.
  3. No layout novo, p2 vira o Manager 0, mas `crowd.upsert` só troca o `home` e p2 continua sentado na cadeira 1.
  4. Entra p3, que vira o Manager 1, e p2 e p3 acabam na cadeira 1.
- Os casos extras do card: um Manager sai e outro chega; dois chamados esperando com dois Managers; o chamado atendido (a fila anda).

Aceite: os testes novos existem e, no código atual, os cenários A e B falham pela cadeira dupla (a mensagem mostra as duas chaves na mesma posição, como no anexo `c913ed-cadeiras.txt`).
Verificar com: `npx vitest run src/renderer/src/office3d/destinations.test.ts` (os novos vermelhos pelo motivo certo, os antigos verdes).
Decidido:
- Como o teste chega ao conserto da cena: o conserto da fila (etapa 4) mora em `scene.ts`, que o teste não instancia. Por isso o teste chama **as mesmas funções puras** que a cena vai chamar: `meetingSpots(fila, cadeirasDosManagers(layout))`, com um helper puro exportado de `meetingRoom.ts` ou de `layout.ts`. Escreva o teste já com essa assinatura. Ele falha (ou nem compila) até a etapa 4.
- O teste existente "quem espera na sala não toma a cadeira dele" (`destinations.test.ts:207-209`) continua valendo. Ajuste só a chamada, se a assinatura de `meetingSpots` mudar.

### 4. [assento-exclusivo] Uma cadeira por agente na sala de reunião

Cards: [[Cadeiras da sala de reunião: uma por agente]] e [["Colisões" é só a cadeira ou também quem se atravessa andando?]] (resolvida).

1. **Cabeceira com memória** (`layout.ts:363-366`). O Manager que já tinha cadeira fica com ela, lida do layout anterior (`prev`), como as mesas (`:197-206`) e o lounge (`:275-291`) já fazem. Quem chega pega a primeira cadeira livre na ordem de `MANAGER_CHAIRS`. O layout passa a guardar o mapa Manager → índice da cadeira, que entra no `Office3DLayout` (`:129-136`), no `EMPTY_LAYOUT` (`:155`) e no retorno de `layoutOffice` (`:265`). Assim, um Manager sair não faz os outros trocarem de lugar.
2. **A fila da TV usa as cadeiras reais dos Managers e é refeita a cada layout.**
   - `meetingSpots` (`meetingRoom.ts:77`) recebe as **posições** das cadeiras ocupadas pelos Managers, não a contagem.
   - A cena guarda a última fila recebida no `onRoom` (`scene.ts:131`) e chama `crowd.setVenues(meetingSpots(fila, cadeiras))` também no `sync()` (`scene.ts:160`), quando o layout muda.
   - O `setVenues` já ignora quem não mudou (`sameSpot`).
   - Se um Manager chega numa cadeira em que alguém da fila esperava, quem espera vai para a próxima livre: o Manager tem prioridade.
3. **`home` mudou, o cérebro vai para o novo** (`crowd.ts:303`). Em `upsert`, se o personagem é `fixed` (Manager, PO, memória) e o `home` novo está a mais de 5 cm do antigo, faça `b.mode = 'init'`, como o `setVenues` já faz (`crowd.ts:237`). Ele levanta e anda até o lugar novo. É a rede de proteção para qualquer lugar fixo dado por contador.

Aceite: os testes da etapa 3 passam (cenários A, B e extras, sem cadeira dupla depois de cada passo) e os testes antigos de `destinations`, `layout` e `life` continuam verdes.
Verificar com: `npx vitest run src/renderer/src/office3d/destinations.test.ts src/renderer/src/office3d/layout.test.ts src/renderer/src/office3d/life.test.ts src/renderer/src/office3d/brain.test.ts`.
Decidido:
- **Nome do mapa:** `managerOf` **não**. Esse nome já existe em `src/renderer/src/office/adapter/model.ts:164` com outro sentido (implementação → planejamento). Use `managerChairOf: Record<string, number>` (a chave do personagem → o índice em `MANAGER_CHAIRS`), no padrão de `deskOf`. O card dava `managerOf` só como exemplo.
- **Fora do escopo** (decisão do usuário, 06/10/2026, leitura "Só lugares"): o desvio entre agentes que andam. Hoje eles se atravessam ao andar e isso continua. Não mexa em `nav.ts`, em `crowdPath.ts` nem na navegação por causa disso.
- **Onde não há furo:** as mesas e o lounge (já têm memória) e o sofá do cochilo e a estante (reserva do `book`, `crowd.ts:385-397`). Não mexa neles.
- **O PO e a memória:** continuam por contador (`layout.ts:355-360`). O item 3 já os protege. Não precisa dar memória a eles.
- Nenhum destes arquivos é tocado pela parte da altura (etapas 5 e 6).

### 5. [ajuste-cadeira] Refazer a cadeira 3D no assento padrão, toda derivada de SEAT_TOP

Card: [[Cadeira 3D inteira derivada do assento]].

Com o assento a 0,46, cada peça desce junto:
- a **coluna a gás** (`chairModel.ts:65`, hoje com topo a ~0,475) atravessaria o assento novo, cujo estofado começa a `SEAT_TOP - 0.14` ≈ 0,32. Encurte-a até a base do estofado;
- o **encosto** (`:62`, centro a 0,88) e o **suporte do encosto** (`:67`, 0,66) descem a mesma distância que o assento (`0.59 - SEAT_TOP`);
- os **braços** (`:75-76`, colunas a 0,68 e apoio a 0,795) ficam ~0,20–0,22 m acima do assento (topo a ~0,66–0,68), **abaixo da face de baixo do tampo** (`DESK_HEIGHT - 0.025` = 0,725);
- a base de 5 pés, os rodízios, `CHAIR_HALF_W`, `CHAIR_BASE_R` e `CHAIR_CENTER_Z` **não mudam**: são o obstáculo da navegação e o recuo.

Exporte de `chairModel.ts` as alturas calculadas a partir de `SEAT_TOP` (ex.: `ARM_TOP`, `ARM_BOTTOM`, `BACK_CENTER_Y`, `BACK_BOTTOM`, `BACK_TOP`, `COLUMN_TOP`) e use-as em `seatedPose.test.ts` no lugar dos números fixos: `backFront` com 0.88 (`:23`), faixas 0.58–1.18 (`:39-42`) e braços 0.775–0.815 (`:43-44`). Atualize os comentários: o cabeçalho de `chairModel.ts` (assento a 0,59, braços a 0,80), o do `SEAT_TOP` (`:17`), `officePlan.ts:8-9` e `officePlan.ts:69-73`.

Aceite: nenhum número de altura fixo sobra nas peças que acompanham o assento. Um `it` novo (em `seatedPose.test.ts` ou no teste da etapa 7) prova que o topo dos braços está abaixo de `DESK_HEIGHT - 0.025` e que o topo da coluna está em `SEAT_TOP - 0.14` ou abaixo. `party.ts:57` acompanha sozinho, porque usa `SEAT_TOP`.
Verificar com: `npx vitest run src/renderer/src/office3d/seatedPose.test.ts -t "cadeira"` (ou o nome do `it` novo); `Grep` de `0.88|0.795|0.68|0.66` em `chairModel.ts` sem nenhuma altura solta.
Decidido:
- A largura, a profundidade e o raio das peças não mudam: só a altura.
- `BACK_TILT` fica como está.
- Se as specs de colisão de `seatedPose.test.ts` ainda falharem por causa da pose, é a etapa 6. Aqui só a geometria e as constantes.

### 6. [ajuste-pose] Ajustar a pose sentada ao assento novo

Card: [[Pose sentada no assento novo: pés no chão e mãos no teclado]].

1. **Pernas** (`sitLower`, ramo da cadeira, `poses.ts:362-377`). Hoje a pose é a da cadeira alta: coxa quase horizontal, calcanhar erguido e ponta do pé no chão. No assento novo: coxa ~horizontal, canela perto da vertical e **pé apoiado no chão**. Quem tem canela longa pode ficar com um pouco de ponta de pé: o joelho vai de 46 a 57 cm do chão e o quadril fica a ~55 cm. O padrão de "pé apoiado" já está no sofá (`poses.ts:346`: coxa por `acos((hip - (b.ankleY + SHIN*cos(tilt))) / THIGH)`). Mantenha o `vary` (cada um senta do seu jeito) e os joelhos sob o tampo (`seatedPose.test.ts:138`). Atualize o comentário de `:326-327` e o de `:362-364` ("Cadeira (alta, a do mockup)").
2. **Mãos no teclado** (`typing`/`reach`, `reach.ts`). A IK usa `SEATED_HIP = SEAT_HEIGHT.chair + 0.075` e acompanha sozinha. Exigência: **nenhum avatar com o braço esticado inteiro** em `type` (lean 0.1) e `typeFast` (lean 0.16) e o **antebraço entre −20° e +20°** da horizontal. O **executor** fica ~2 cm curto a 0,46 (braço curto do modelo). Escolha o **menor** ajuste:
   - aproximar o teclado (`KEYBOARD_FRONT`, `officePlan.ts:76`; o `KEYS_AHEAD` deriva dele);
   - ou aproximar a cadeira (`SEAT_FRONT`, `officePlan.ts:74`): com o joelho mais baixo, sobra espaço sob o tampo;
   - ou o assento dentro de 0,44–0,48.

   O teste "joelhos sob o tampo" tem de continuar passando.
3. **Cochilo na mesa** (`napDesk`, `gestures.ts:289-301`). Os ângulos foram feitos para o assento antigo. Reajuste para a cabeça deitar nos braços sobre o tampo, sem atravessar.
4. **Ações e reações sentadas** (readScreen, drum, sip, web, assist e as reações de `reactions.ts`, com o `seatedClamp` em `:68-96`). O tampo agora fica mais perto do peito: as duas specs de colisão de `seatedPose.test.ts` têm de passar. Reajuste os ângulos que baterem.
5. **Clipes sentados do Mixamo** (`motionPick.ts:73-84`, máscara `upper`). Não passam pelo teste de colisão. Confira nas fotos (etapa 8) que os braços não atravessam a borda da mesa.
6. **Sala de reunião:** a mesma cadeira e a mesma conta. Confira quem senta lá (foto `--poses`).

Aceite: as duas specs de colisão de `seatedPose.test.ts` passam com o assento novo. `poses`, `agentPoses` e `motion` passam. Pela conta da etapa 7, todos os avatares alcançam o teclado com o antebraço em ±20°.
Verificar com: `npx vitest run src/renderer/src/office3d/seatedPose.test.ts src/renderer/src/office3d/poses.test.ts src/renderer/src/office3d/agentPoses.test.ts src/renderer/src/office3d/motion.test.ts` (o `seatedPose.test.ts` leva até 2 min).
Decidido:
- O valor esperado de cada avatar com o assento a 0,46 está em `8ffc37-medidas.txt` (mídia acima): antebraço de −18° a +14°, 8 de 9 alcançam, e o executor fica 2 cm curto.
- Se for útil, escreva já a conta da etapa 7 para calibrar o ajuste; o tempo conta nesta etapa.
- Não mude a conta do `solve`.
- `reach.ts` soma `+0.075` ao assento (`SEATED_HIP`); `sitLower` soma `SIT_ON.chair = 0.09`. A diferença de 1,5 cm é antiga e não é deste plano. Só unifique se for preciso para a pose fechar e, nesse caso, escreva "DESVIO DO PLANO:".

### 7. [teste-ergonomia] Teste de regressão: cada avatar alcança o teclado com o antebraço quase horizontal

Card: [[Teste de ergonomia por avatar]].

Crie `src/renderer/src/office3d/seatedReach.test.ts`:
- abre cada GLB de `resources/office-agents` (`executor`, `critico`, `navegador-de-codigo`, `memoria`, `po`, `vigia`, `subagente`, `principal`, `central`) **sem o GLTFLoader**, como o `agentCast.test.ts`, passa pelo `prepareAvatar` e usa `t.metrics` e a escala `t.fit` (`agentBody.ts:47`). Mova `readGlb`/`buildScene` de `agentCast.test.ts` para um helper de teste compartilhado (ex.: `testGlb.ts`) em vez de copiar;
- testa também o boneco (`BODY` de `poses.ts`) nas escalas 1 e 0,85;
- sentado na cadeira da estação, com a IK do `reach.ts` (lean 0.1 do `type` e 0.16 do `typeFast`), exige:
  - (a) o punho no alvo do teclado (`DESK_TOP + 0.055`, `KEYS_AHEAD`) **sem o braço esticado inteiro**;
  - (b) o antebraço entre **−20° e +20°** da horizontal;
  - (c) o quadril acima do assento e o joelho abaixo da face de baixo do tampo (`DESK_HEIGHT - 0.025`), com a pose de `sitLower(…, 'chair', …)`;
- confere também as constantes: o assento entre **0,42 e 0,52** (NBR 13962) e o tampo entre **0,72 e 0,78**.

A conta, exportada do `reach.ts` (ex.: `reachInfo(y, ahead, lean, scale, b)`) para o teste não copiar a fórmula, reproduz o `solve` (`reach.ts:30-41`):
- `pelvis = SEATED_HIP + b.hipDrop * scale`;
- `fz = ahead/scale − b.shoulderY·sin(lean)` e `fy = b.shoulderY·cos(lean) − (y − pelvis)/scale`;
- `dist = hypot(fz, fy)`, `L = b.upperArm + b.forearm`;
- **alcança** quando `dist ≤ L − 0.01/scale`, uma folga de 1 cm (em `solve`, `dist ≥ L − 1e-3` é o braço esticado e preso no limite);
- com `e` (a dobra do cotovelo) e o braço em relação à vertical `θ1 = atan2(fz, fy) − atan2(L2·sin e, L1 + L2·cos e)`, o antebraço fica a `θ1 + e` da vertical para baixo; o **ângulo do antebraço com a horizontal** é `(θ1 + e) − π/2` (positivo = a mão acima do cotovelo).

Aceite: `seatedReach.test.ts` passa para o boneco (escalas 1 e 0,85) e para os 9 GLBs, com o assento atual. E prova que pega o problema: com `SEAT_HEIGHT.chair` de volta a 0.59, temporariamente, ele **falha** (vermelho); de volta ao valor novo, passa (verde).
Verificar com: `npx vitest run src/renderer/src/office3d/seatedReach.test.ts src/renderer/src/office3d/agentCast.test.ts`, mais o ciclo vermelho/verde descrito no Aceite (desfaça a troca temporária e confira com `git diff`).
Decidido:
- A Central entra no teste, como manda o card ("cada GLB"), mesmo trabalhando em pé no console: a 0,46 ela fica a −18°. Se ela for a única a passar de ±20° depois do ajuste do executor, tire-a do teste com uma linha "DESVIO DO PLANO:" dizendo por quê, sem afrouxar a faixa para todos.
- Se faltar um GLB em `resources/office-agents`, pule só ele (`it.runIf(existsSync(...))`, como o `agentCast.test.ts`).

### 8. [verificacao] Verificar tudo: comandos, fotos, sala de reunião e celular

Cards: [[Verificação e critérios de aceite]] e [[Risco: outra implementação mexendo no app do celular]].

1. `npm run typecheck`, `npm test` e `npm run build`.
2. Fotos de depois: `node scripts/office-agents/app-harness.mjs --desks` e `--poses`, copiadas para `docs/spec/plano-20261006-1026/_sandbox/fotos/depois/`. Abra as de antes e as de depois com Read e compare:
   - as mãos no teclado na altura do cotovelo;
   - os braços da cadeira abaixo do tampo;
   - os pés no chão;
   - o cochilo com a cabeça nos braços;
   - a sala de reunião;
   - os clipes sentados do Mixamo sem braço atravessando a borda;
   - o que fica sobre o assento na festa (`party.ts:57`), se aparecer.
3. Sala de reunião sem cadeira dupla: o teste de regressão passa. No app isolado (harness com `--keep`), se der para montar o cenário (enviar um plano e abrir outro planejamento, com um chamado esperando, se houver), confira que cada agente fica na sua cadeira. Se o harness não permitir montar Managers, diga em "Não testei", sem afirmar que foi visto no app.
4. Celular: `npm run phone:build` regera `smartfone-remote/www/` (5 arquivos versionados), que vai no commit. **Só rode** se `git status --short src/phone package.json package-lock.json` estiver limpo. Se houver mudanças de outra conversa ali, não rode: escreva "ATENÇÃO:" e deixe o `phone:build` para quando ela commitar.
5. Commit único no fim, no branch atual, com mensagem no padrão do repo (ex.: `feat(escritorio): cadeira no padrão (assento 0,46), pose sentada e uma cadeira por agente na sala de reunião`). Entram **só** os arquivos desta mudança: `src/renderer/src/office3d/**` e, se rodou, `smartfone-remote/www/`. Sem `Co-Authored-By`, sem push e sem subir versão nem instalador.

Aceite: os comandos do item 1 terminam com exit 0; as fotos de antes e de depois estão nas duas pastas, com a comparação descrita no chat; os 8 critérios de aceite abaixo foram checados um a um, com evidência ou com o motivo de não ter checado; o commit contém só os arquivos desta mudança.
Verificar com: `npm run typecheck && npm test && npm run build`; `ls docs/spec/plano-20261006-1026/_sandbox/fotos/antes docs/spec/plano-20261006-1026/_sandbox/fotos/depois`; `git show --stat HEAD`.
Decidido:
- Se `npm test` falhar em teste de outra área (ex.: `src/phone/**/pcs.test.ts`, de outra conversa), não é desta mudança: avise no chat e não "conserte".
- Sem o dotnet SDK, o `npm run build` falha no binário de controle do Windows. Nesse caso rode `npx electron-vite build` para provar a parte web e diga que o build completo não rodou.
- O critério 8 (o usuário confere no PC e no celular) é do usuário. Entregue os caminhos das fotos e diga o que olhar.

---

## Requisitos (resumo dos cards)

- **Assento a 0,46** (faixa permitida 0,44–0,48; nunca fora de 0,42–0,52). A mesa a 0,75, com o tampo a 0,775. O monitor, a mesa da reunião, o sofá e a beira da mesa não mudam.
- **Cadeira 3D inteira derivada de `SEAT_TOP`.** Os braços ~0,20–0,22 m acima do assento e abaixo de 0,725; a coluna até a base do estofado; o encosto e o suporte descem junto; a base, os rodízios e as medidas de navegação ficam.
- **Pose sentada:** pés no chão, coxa ~horizontal, joelhos sob o tampo, mãos no teclado sem o braço esticado e com o antebraço em ±20°, cochilo sem atravessar, reações e ações sem bater no tampo.
- **Teste de ergonomia por avatar** (9 GLBs e o boneco nas escalas 1 e 0,85), com as constantes nas faixas da norma.
- **Uma cadeira por agente na sala de reunião:** a cabeceira com memória, a fila da TV com as cadeiras reais dos Managers e refeita a cada layout, o `home` novo levanta o `fixed` e o teste de regressão (cenários A, B e extras).

## Decisões (com o porquê)

- **Baixar a cadeira, não subir a mesa** (o usuário escolheu em 06/10/2026). Quem está fora do padrão é a cadeira (13 cm acima). Com o assento padrão o braço deixa de esticar (8 de 9 alcançam; o 9º precisa de um ajuste pequeno), os pés vão ao chão e o escritório fica com medidas reais. Subir a mesa obrigaria a subir o monitor, as divisórias, o teclado, os objetos e a mesa da reunião, e deixaria a mesa com altura de balcão (~0,87 m), fora do padrão.
- **Só os lugares, não o desvio ao andar** (o usuário escolheu "Só lugares"). A cadeira dupla tem causa provada e correção barata. O desvio entre quem anda mexe na navegação inteira, tem risco de engarrafar nos corredores e custa por quadro com 20–30 agentes. Fica para outro planejamento.
- **Autonomia:** nenhuma pergunta; permitir tudo, exceto o destrutivo (veja "Como trabalhar").

## Sugestões (com a fonte)

- [[Baixar a cadeira ao padrão em vez de subir a mesa]], **aceita**. Fontes:
  - assento, ABNT NBR 13962 (mínimo de 420 mm do piso, curso de pelo menos 100 mm): https://www.gov.br/icmbio/pt-br/acesso-a-informacao/licitacoes-e-contratos/licitacoes/dispensas/exercicios-anteriores/2020/projeto_basico_dispensa_7_2020_poltronas_giratorias.pdf
  - mesa, ABNT NBR 13966:2008 (720/750 mm): https://www.trt7.jus.br/files/contas_publicas/licitacoes/pregao_eletronico/2025/PE_90026_2025/TERMO%20DE%20REFERENCIA%20ANEXO%20I%20-%20VALOR%20ESTIMADO%20E%20ESPECIFICACOES.pdf

## Ambiguidades resolvidas

- **"Colisões" é só a cadeira ou também quem se atravessa andando?** O usuário escolheu (06/10/2026) **só os lugares**: dois agentes no mesmo assento ou lugar fixo. O desvio entre agentes que andam fica **fora**: não implementar e não mexer na navegação por causa disso.

## Riscos

- **Outra conversa no app do celular.** Uma implementação de "Conexões múltiplas no app Android" mexia em `src/phone/**` e `package*.json` no mesmo repositório. Em 10/10 a árvore estava limpa, mas confira. Não reverta nem inclua no commit o que não é seu, e só rode `phone:build` com `src/phone/**` limpo.
- **O `seatedPose.test.ts` é lento** (até 2 min) **e fica vermelho entre as etapas 2 e 6**: é esperado.
- **Os clipes sentados do Mixamo não passam pelo teste de colisão.** Só a foto mostra se o braço atravessa a borda da mesa.
- **Executor e Central no limite:** o executor fica 2 cm curto e a Central a −18°. O ajuste para um pode empurrar o outro para fora; escolha o menor ajuste e confira os dois.
- **A diferença `SEATED_HIP` (+0,075) × `SIT_ON.chair` (+0,09)** é antiga. Não unifique sem precisar.
- **As fotos dependem do harness** (electron-vite dev, Playwright). Se ele falhar, diga o que não foi visto.

## Critérios de aceite (todos)

1. Sentado digitando, o boneco e os avatares que sentam ficam com as mãos no teclado na altura do cotovelo (antebraço quase horizontal), sem nenhum braço esticado.
2. Os braços da cadeira ficam abaixo do tampo e a coluna não atravessa o assento.
3. Os pés ficam no chão.
4. No cochilo na mesa, a cabeça fica sobre os braços no tampo e nada atravessa.
5. Quem senta na sala de reunião fica certo.
6. A sala de reunião fica sem cadeira dupla: o teste de regressão passa e, no app (harness), depois de enviar um plano e abrir outro planejamento, cada agente fica na sua cadeira (ou "Não testei", com o motivo).
7. Typecheck, testes (inclusive o `seatedReach.test.ts` novo) e build passam.
8. O usuário confere no PC e no celular: entregue as fotos de antes e de depois e diga o que olhar.

## Relatório final

- O que mudou, por arquivo.
- Os comandos rodados e o resultado (exit code, contagem de testes).
- Os caminhos das fotos de antes e de depois, com o que cada uma mostra.
- A tabela etapa → estimativa do plano → minha estimativa → tempo medido (dentro/fora do prazo, e o motivo).
- O hash do commit.
- A seção **"Atenções"**, com todas as linhas ATENÇÃO e DESVIO DO PLANO.
