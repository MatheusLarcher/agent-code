<!-- prompt 1 -->
# Handoff — Altura da mesa muito baixa (plano-20261006-1026)

## Arquivos

Abra TODOS os arquivos de "Ler antes de começar" numa única resposta, com as leituras em paralelo. Não reexplore o que a lista cobre; use Grep/Glob só para o que faltar. As linhas são pista: o código pode ter mudado desde o planejamento.

Raiz do projeto: `D:\agent-code-replay\a1\agent-code` (conferido no commit 8c89585, árvore limpa em 10/10/2026).

### Ler antes de começar
- `AGENTS.md`: regras do repositório (arquivos com menos de 500 linhas, commit sem `Co-Authored-By`, typecheck/test/build).
- `src/renderer/src/office3d/poses.ts:310-378`: `SeatKind`, `SEAT_HEIGHT` (`:316`, `chair: 0.59`), `SIT_ON` (`:319`) e `sitLower` (`:331`). O ramo da cadeira (`:362-377`) faz "calcanhar erguido, ponta do pé no chão".
- `src/renderer/src/office3d/chairModel.ts:1-79`: a cadeira 3D inteira. `SEAT_TOP = SEAT_HEIGHT.chair` (`:18`); `CHAIR_CENTER_Z`, `BACK_TILT`, `CHAIR_HALF_W` e `CHAIR_BASE_R` (`:20-25`); as peças (`:59-79`): estofado `:61` (o único que segue `SEAT_TOP`), encosto `:62` (0,88 fixo), coluna `:65` (centro 0,27, altura 0,41), suporte do encosto `:67` (0,66), braços `:75-76` (0,68 e 0,795).
- `src/renderer/src/office3d/reach.ts:1-77`: `DESK_TOP` (`:12`), `SEATED_HIP` (`:13`), `KEYS_AHEAD` (`:15`), `solve` (`:30`, privada; o braço estica inteiro quando `d` é limitado a `L1+L2` em `:35`), `reach` (`:44`) e `typing` (`:68`).
- `src/renderer/src/office3d/officePlan.ts:1-79`: o cabeçalho desatualizado (`:8-9`, "assento perto de 0,36 m"), `DESK_HEIGHT = 0.75` (`:63`), `MONITOR_Y` (`:67`), o comentário dos braços a 0,80 (`:69-73`), `SEAT_FRONT = 0.95` (`:74`) e `KEYBOARD_FRONT = 0.45` (`:76`).
- `src/renderer/src/office3d/seatedPose.test.ts:1-148`: o teste de colisão sentado. Repete números da cadeira antiga: `backFront` com 0,88 (`:23`), as faixas do encosto 0,58–1,18 (`:39-42`) e os braços 0,775–0,815 (`:43-44`). A spec da pose (`:123-147`) espera "ponta do pé no chão".
- `src/renderer/src/office3d/gestures.ts:36-44` e `:289-301`: `type`/`typeFast` chamam `typing` com lean 0,1 (`:39`) e 0,16 (`:43`); o `napDesk` tem ângulos fixos (`:289-301`).
- `src/renderer/src/office3d/reactions.ts:50-90`: as reações sentadas usam `SEATED_HIP` (`:56`) e `SEAT_HEIGHT.chair` (`:88`).
- `src/renderer/src/office3d/motionPick.ts:73-84`: os clipes sentados do Mixamo (só tronco e braços).
- `src/renderer/src/office3d/party.ts:57`: o que fica sobre o assento na festa usa `SEAT_TOP` (acompanha sozinho).
- `src/renderer/src/office3d/decorBack.ts:45` e `:141`: a sala de reunião usa `officeChairGeometries()` e a mesa em `DESK_HEIGHT` (é corrigida junto).
- `src/renderer/src/office3d/agentCast.test.ts:40-70` e `:160-165`: abre os GLB de `resources/office-agents` sem o GLTFLoader e passa pelo `prepareAvatar` (`t.metrics`).
- `src/renderer/src/office3d/agentRest.ts:39-60` e `:94`: `AvatarTemplate` (`metrics`; `fit` = a escala do PERSONAGEM com aquele modelo) e `prepareAvatar`.
- `src/renderer/src/office3d/agentPoses.test.ts:50` e `src/renderer/src/office3d/poses.test.ts:105`: expectativas relativas a `SEAT_HEIGHT.chair`, que devem acompanhar sozinhas.
- `src/renderer/src/office3d/layout.ts:129-155`, `:180-266` e `:269-376`:
  - `:129-155`: `Office3DLayout` (com `deskOf` e `islandOf`) e `EMPTY_LAYOUT` (`:155`).
  - `:180-266`: `layoutOffice(model, prev)`; as mesas têm memória (`:197-206`).
  - `:269-376`: `placeCharacters`. O lounge tem memória (`:275-291`), o offstage não ocupa lugar (`:317-319`) e a cabeceira NÃO tem memória (`:363-366`, `managerSeat(counters.manager++)`).
- `src/renderer/src/office3d/meetingRoom.ts:1-102`: `WAIT_CHAIRS`, `MANAGER_CHAIRS` (`:51`), `managerSeat` (`:70`), `meetingSpots(order, managers = contagem)` (`:77`) e `sameSpot` (`:100`).
- `src/renderer/src/office3d/scene.ts:129-131` e `:160-240`: o `onRoom` chama `setVenues` com a CONTAGEM de Managers (`:131`); `sync` (`:160`) chama `syncCharacters`, que chama `crowd.upsert` (`:222`); depois vem `projectors.feed` (`:200`).
- `src/renderer/src/office3d/projectors.ts:203-214`: `emitRoom` só emite a fila quando chamados ou testes mudam.
- `src/renderer/src/office3d/crowd.ts:228-239` e `:272-306`: `setVenues` (lugar novo → `mode = 'init'`, `:237`) e `upsert` (no cérebro existente só troca `home`, `:303`).
- `src/renderer/src/office3d/brain.ts:172-177`, `:268-274` e `:472-477`: `decide` (role fixed → modo `'fixed'`), `enterMode('fixed')` (o Manager senta no `home`) e `stepBrain` (só entra no modo quando o modo muda).
- `src/renderer/src/office3d/engine.ts:237`: `layoutOffice(model, this.layout)`. O layout anterior é o `prev`.
- `src/renderer/src/office3d/destinations.test.ts:1-32` e `:189-254`: os helpers `model`/`world`/`run`; o Manager à cabeceira (`:189-211`, com `meetingSpots([...], 1)` em `:208`); o chamado e a fila da TV (`:213-254`).
- `scripts/office-agents/app-harness.mjs:1-35`: o harness isolado, com as flags `--desks`, `--poses` e `--keep`. Imprime `capturas: <pasta>` (`:338`). A pasta temporária não é apagada.

### Editar/criar
- `src/renderer/src/office3d/poses.ts`: `SEAT_HEIGHT.chair` de 0.59 para 0.46 e o comentário `:312-315`; no ramo da cadeira do `sitLower`, o pé passa a ficar apoiado no chão; o comentário `:362`.
- `src/renderer/src/office3d/chairModel.ts`: todas as alturas das peças derivadas de `SEAT_TOP`; exportar as alturas (ex.: `ARM_TOP`, `BACK_CENTER_Y`); refazer o cabeçalho.
- `src/renderer/src/office3d/officePlan.ts`: os comentários `:8-9` e `:69-73`. `KEYBOARD_FRONT`/`SEAT_FRONT` mudam só se o executor precisar (etapa 6).
- `src/renderer/src/office3d/reach.ts`: exportar a conta que diz se o punho alcançou o alvo e o ângulo do antebraço, para o teste, sem mudar o comportamento.
- `src/renderer/src/office3d/gestures.ts`: o `napDesk` e os ângulos das ações sentadas que baterem no tampo.
- `src/renderer/src/office3d/reactions.ts`: os ângulos das reações sentadas, só se o teste acusar colisão.
- `src/renderer/src/office3d/seatedPose.test.ts`: usar as alturas exportadas da cadeira; pé apoiado; uma spec da geometria da cadeira.
- `src/renderer/src/office3d/seatedReach.test.ts` (NOVO): a ergonomia por avatar.
- `src/renderer/src/office3d/layout.ts`: `managerOf` em `Office3DLayout` e em `EMPTY_LAYOUT`; a cabeceira com memória.
- `src/renderer/src/office3d/meetingRoom.ts`: `meetingSpots` passa a receber as cadeiras ocupadas pelos Managers (posições); um helper que tira essas cadeiras do layout.
- `src/renderer/src/office3d/scene.ts`: guardar a última fila e refazer o `setVenues` no `sync`.
- `src/renderer/src/office3d/crowd.ts`: se o `home` de um personagem fixed muda mais de 5 cm, `mode = 'init'`.
- `src/renderer/src/office3d/destinations.test.ts`: os testes de regressão das cadeiras.
- `smartfone-remote/www/`: regenerado por `npm run phone:build` (etapa 8).

## Objetivo

Hoje os agentes do Escritório 3D digitam com a mão "lá embaixo" e a mesa parece baixa. O diagnóstico mostrou que a **mesa já está no padrão** (tampo a 0,775 m). Quem está alta é a **cadeira**: assento a 0,59 m, braços a ~0,80 m, acima do tampo. Com isso o braço estica para baixo até o teclado, e 8 de 9 avatares nem alcançam. Esta implementação:
1. baixa o assento para o padrão (0,46 m) e refaz a cadeira 3D inteira a partir dele;
2. ajusta a pose sentada: pés no chão, mãos no teclado na altura do cotovelo, cochilo e reações sem atravessar o tampo;
3. cria um teste de ergonomia por avatar, para o problema não voltar;
4. corrige **dois agentes sentados na mesma cadeira da sala de reunião**;
5. verifica no app (harness isolado) e regera o app do celular.

## Como trabalhar (obrigatório)

- **Declare as etapas como plano** (TodoWrite ou TaskCreate), uma por item, cada item começando pelo id da etapa entre colchetes, na ordem abaixo (ex.: "[ajuste-cadeira] Refazer a cadeira 3D no assento padrão").
- **A pasta do plano é consulta pontual, sem replanejar:** `D:\agent-code-replay\runs\a1-novo-r2\agent-code\planning\agent-code\plano-20261006-1026` (os cards em .md e `midia/`). Não mude o roteiro nem os cards.
- **Autonomia** (card `decisao-autonomia-handoff`):
  - **Perguntas:** nenhuma. Onde os cards não cobrem, escolha o menor ajuste, avise e siga.
  - **Permissões:** permitir tudo, exceto destrutivo. Pode editar `src/renderer/src/office3d/**` e rodar typecheck, testes, build, o harness isolado e `phone:build`.
  - **Não pode:** reverter ou descartar mudança alheia (`git checkout/restore/reset/stash/clean`), mexer em `package.json` ou nos lockfiles, instalar pacote global, dar push, nem fechar ou reiniciar o app que o usuário está usando.
  - **Por quê:** a mudança é visual e local, sem produção, dados reais, deploy, dinheiro nem integração externa.
- **Tempo de cada etapa:**
  - Ao começar a etapa, registre a sua estimativa com `mcp__entregas__entrega_estimar` e escreva: "Etapa N — <título>: estimativa do plano X min (prazo), minha estimativa Z min".
  - Ao concluir, consulte `mcp__entregas__entrega_tempo` e escreva: "levou Y min de trabalho (dentro/fora do prazo)". Se passou do prazo, diga o motivo.
  - O prazo é a estimativa do plano. A sua não o muda, e o tempo que vale é o medido pelo app.
- **Avaliação contínua (avisa, não para):**
  - (a) Antes de cada etapa, rode `git status --short` e `git diff --stat` dos arquivos que ela vai tocar, compare com a seção Arquivos e leia o bloco OUTRAS_CONVERSAS. Se outra conversa mexeu num arquivo seu, se o código mudou desde o planejamento (linha não bate, símbolo sumiu) ou se uma premissa de card não vale mais, escreva no chat uma linha que começa com "ATENÇÃO: " dizendo o que mudou e o que vai fazer. Não reverta nada de ninguém; adapte e siga.
  - (b) Se a evidência contradiz uma decisão do plano, escreva uma linha que começa com "DESVIO DO PLANO: " com o que encontrou e o que fez, e siga.
  - (c) Ao fechar cada etapa, faça um autocheck de 3 linhas, em texto livre e sem nota: "Pode quebrar: …", "Não testei: …", "Olhe isto: …".
  - (d) O relatório final tem a seção **"Atenções"**, com todas as linhas ATENÇÃO e DESVIO DO PLANO.
  - (e) Nada disso é pergunta: avise e siga.
- **Pronto de verdade:** typecheck e teste verdes não bastam. Antes de dizer "pronto", rode o harness e olhe as fotos (Read nas imagens). O que não conseguir validar de fato, diga que não validou; nunca afirme que funciona sem ter visto.
- **Limite de linhas:** `crowd.ts` já tem **500 linhas** e `scene.ts` tem **499**, e o AGENTS.md pede arquivos com menos de 500. Não os deixe crescer: ponha a lógica nova em `meetingRoom.ts` (puro) ou num helper pequeno e compense as linhas.

## Etapas e estimativas

| # | Etapa | Estimativa (min de trabalho do agente) |
|---|---|---|
| 1 | [diagnostico] Diagnóstico: a mesa já está no padrão; a cadeira alta obriga o braço a esticar | 5 |
| 2 | [altura-padrao] Decidir as alturas padrão da mesa (tampo) e do assento | 5 |
| 3 | [diagnostico-cadeira-dupla] Diagnóstico: dois agentes na mesma cadeira da sala de reunião | 5 |
| 4 | [assento-exclusivo] Cadeira exclusiva na sala de reunião + teste de regressão | 35 |
| 5 | [ajuste-cadeira] Refazer a cadeira 3D no assento padrão, tudo derivado do SEAT_TOP | 20 |
| 6 | [ajuste-pose] Ajustar a pose sentada ao assento novo | 45 |
| 7 | [teste-ergonomia] Teste de regressão de ergonomia por avatar | 15 |
| 8 | [verificacao] Verificar: typecheck, testes, build, fotos, sala de reunião, celular | 30 |
| | **Total deste prompt** | **160 min (2 h 40 min)** |

As etapas 1 a 3 foram resolvidas no planejamento. Aqui elas são curtas: **confirmar a premissa no código**, **tirar as fotos de antes**, **registrar a linha de base** e **escrever o teste que reproduz o bug**, tudo antes de mexer no código de produção.

## Mídias do plano (abra com Read; são texto)

- [Texto] 8ffc37-medidas.txt — `D:\agent-code-replay\runs\a1-novo-r2\agent-code\planning\agent-code\plano-20261006-1026\midia\8ffc37-medidas.txt`: as medidas por avatar (boneco nas escalas 1 e 0,85 e os 9 GLB), com assento a 0,59 × 0,46. Por avatar: ombro, cotovelo e punho em relação ao tampo, quanto falta até o teclado, o ângulo do antebraço, se alcança, e a altura do joelho e do quadril. É a calibração da etapa 7.
- [Texto] c913ed-cadeiras.txt — `D:\agent-code-replay\runs\a1-novo-r2\agent-code\planning\agent-code\plano-20261006-1026\midia\c913ed-cadeiras.txt`: a saída da reprodução dos cenários A e B da cadeira dupla, com as coordenadas das cadeiras (cabeceira 0 = 4,25; −5,40; cadeira 1 = 7,98; −5,40).

**Importante:** os cards citam `docs/spec/plano-20261006-1026/_sandbox/measure.test.ts` e `cadeiras.test.ts`. Esses arquivos **não existem nesta máquina** (a pasta está no `.gitignore` e não foi criada aqui). Use as receitas deste prompt e os números das duas mídias acima.

## Decisões (com o porquê)

- **[[Mesa fica como está; assento da cadeira desce para ~0,46 m]]** (o usuário escolheu em 06/10/2026):
  - **Mesa:** `DESK_HEIGHT` continua 0.75 (tampo a 0,775 m). Não mudam o monitor (`MONITOR_Y`), as divisórias, os objetos da mesa nem o console da Central.
  - **Assento:** `SEAT_HEIGHT.chair` passa de 0.59 para **0.46**. Pode ir de 0,44 a 0,48 se a pose pedir, mas **nunca sair de 0,42–0,52** (NBR 13962).
  - **Braços da cadeira:** ~0,20–0,22 m acima do assento (~0,66–0,68 m), **abaixo do tampo**, cuja face de baixo fica a 0,725.
  - **Fora do pedido:** `SEAT_HEIGHT.sofa` e `SEAT_HEIGHT.desk` NÃO mudam.
  - **Por quê:** é a cadeira que está 13 cm acima do padrão, não a mesa. Com o assento padrão, o tampo fica na altura do cotovelo, 8 de 9 avatares alcançam o teclado, os pés vão ao chão, e mexe em menos peças do que subir a mesa.
  - **Alcance:** todas as cadeiras de escritório da cena (24 estações e a sala de reunião) usam o mesmo modelo e a mesma constante, então descem juntas.
- **Autonomia** (`decisao-autonomia-handoff`): sem perguntas; tudo permitido, exceto o destrutivo. Ver "Como trabalhar".

## Sugestão aceita (com fonte)

- **[[Baixar a cadeira ao padrão em vez de subir a mesa]]** (status: aceita).
  - O pedido original era subir a mesa. A sugestão foi manter a mesa e baixar o assento a ~0,46 m.
  - Subir a mesa obrigaria a subir o monitor, as divisórias, o teclado, os objetos e a mesa da reunião, e deixaria tudo com altura de balcão (~0,87 m), fora do padrão.
  - Fontes:
    - assento, ABNT NBR 13962 (mínimo de 420 mm): https://www.gov.br/icmbio/pt-br/acesso-a-informacao/licitacoes-e-contratos/licitacoes/dispensas/exercicios-anteriores/2020/projeto_basico_dispensa_7_2020_poltronas_giratorias.pdf
    - mesa, ABNT NBR 13966:2008 (720/750 mm): https://www.trt7.jus.br/files/contas_publicas/licitacoes/pregao_eletronico/2025/PE_90026_2025/TERMO%20DE%20REFERENCIA%20ANEXO%20I%20-%20VALOR%20ESTIMADO%20E%20ESPECIFICACOES.pdf

## Ambiguidade resolvida

- **[["Colisões" é só a cadeira ou também quem se atravessa andando?]]**: o usuário escolheu **"Só lugares"** (06/10/2026).
  - Este plano corrige dois agentes no mesmo assento ou no mesmo lugar fixo.
  - O desvio entre agentes que andam (hoje eles se atravessam) fica **FORA**. Não implemente e não mexa na navegação (`nav.ts`, `brain*.ts`, desvio local) por causa disso.

## Riscos

- **Outra conversa no mesmo repositório** ([[Risco: outra implementação mexendo no app do celular]]):
  - No planejamento, a implementação de "Conexões múltiplas no app Android" tinha mudanças não commitadas em `src/phone/**` e `package*.json`. Em 10/10 a árvore estava limpa e nenhum agente trabalhava.
  - Antes do `phone:build`, rode `git status --short`. Se houver mudança alheia não commitada em `src/phone/**` ou `package*.json`, NÃO rode o `phone:build` (o bundle levaria código pela metade). Escreva "ATENÇÃO: …" e deixe para depois.
  - Nunca inclua no commit nem reverta arquivos que não são desta mudança.
  - Se um teste de fora do `office3d` falhar no `npm test` (ex.: `pcs.test.ts`), não é desta mudança: relate, não "conserte".
- **O `seatedPose.test.ts` leva até 2 min.** Durante as etapas, rode só os arquivos de teste do `office3d`; a suíte inteira fica para a etapa 8.
- **Os clipes sentados do Mixamo** (`motionPick.ts:74`, máscara do tronco) não passam pelo teste de colisão. Só a foto mostra se o braço atravessa a borda da mesa.
- **O executor tem braço curto:** com o assento a 0,46 ele fica 2 cm curto (antebraço −16°). É preciso um ajuste pequeno (etapa 6).
- **Tamanho de arquivo:** `crowd.ts` (500) e `scene.ts` (499) já estão no limite.
- **`npm run build`** também compila o binário .NET (precisa do dotnet SDK). Se o SDK faltar, relate; não contorne.
- **O harness** precisa do chromium do Playwright (o `postinstall`). Se faltar, relate.

---

### 1. [diagnostico] Confirmar no código a premissa da altura e tirar as fotos de ANTES
Card: [[Diagnóstico: a mesa está no padrão, a cadeira é que está alta]] (medidas no [Texto] 8ffc37-medidas.txt acima).
- Só leitura. Confirme: `officePlan.ts:63` `DESK_HEIGHT = 0.75`; `reach.ts:12` `DESK_TOP = DESK_HEIGHT + 0.025`; `poses.ts:316` `chair: 0.59`; `chairModel.ts:76` o apoio do braço em y 0,795; `chairModel.ts:65` a coluna com centro 0,27 e altura 0,41 (topo ~0,475).
- Tire as fotos de ANTES, sem nenhuma edição: `node scripts/office-agents/app-harness.mjs --desks` e depois `node scripts/office-agents/app-harness.mjs --poses`. Cada um imprime `capturas: <pasta>`. Anote as duas pastas no chat: elas serão comparadas na etapa 8.

Aceite: as cinco constantes conferidas (ou uma linha ATENÇÃO para a que mudou) e duas pastas de fotos de ANTES (`--desks` e `--poses`) com o caminho escrito no chat.
Verificar com: Grep nas cinco linhas acima; a linha `capturas:` de cada execução do harness; Read de uma foto de cada pasta.
Decidido: o harness sobe uma cópia DEV isolada (pasta, HOME e banco temporários) e não toca no app em uso, então pode rodar sem perguntar. As fotos de antes pertencem à verificação, mas têm de ser tiradas aqui, antes de qualquer mudança. Se o boot do harness estourar os 5 min, esse é o motivo a relatar.

### 2. [altura-padrao] Fixar os números-alvo e registrar a linha de base verde
Cards: [[Mesa fica como está; assento da cadeira desce para ~0,46 m]] e [[Baixar a cadeira ao padrão em vez de subir a mesa]].
- Sem editar código. Escreva no chat os alvos:
  - assento 0,46 (faixa de ajuste 0,44–0,48, limite 0,42–0,52);
  - tampo continua a 0,775;
  - braços a SEAT_TOP + 0,20–0,22, abaixo de 0,725;
  - sofá e beira da mesa não mudam.
- Rode `npm run typecheck` e `npm test` na árvore intocada e registre a linha de base: o exit code e quais testes falham, se algum falhar. É ela que separa depois "quebrei" de "já estava quebrado".

Aceite: os alvos e a linha de base (typecheck: exit code; npm test: totais de passou/falhou e o nome de cada teste que já falhava) estão escritos no chat antes de qualquer edição.
Verificar com: a saída de `npm run typecheck` e de `npm test`.
Decidido: a mesa não muda, porque já está no padrão (NBR 13966). Mudar a mesa seria desvio do plano. O monitor também não muda: com o assento a 0,46, os olhos ficam a ~1,25 m e o centro da tela ~13 cm abaixo deles, que é o recomendado.

### 3. [diagnostico-cadeira-dupla] Reproduzir as duas cadeiras duplas num teste que falha (vermelho)
Card: [[Diagnóstico: dois agentes na mesma cadeira da sala de reunião]] (saída em [Texto] c913ed-cadeiras.txt acima).
- Em `destinations.test.ts`, crie um `describe` novo com os cenários A e B, usando os helpers `model`/`world`/`run`. O teste reproduz o que a cena faz a cada layout: `layoutOffice(modelo, layoutAnterior)`, depois `crowd.upsert` de cada personagem, depois `crowd.setVenues(...)` com a fila atual (hoje `meetingSpots(fila, nº de Managers)`, como `scene.ts:131`). A fila só é reaplicada quando ELA muda (`projectors.ts:203-214`).
  - **Cenário A (fila velha):**
    1. Dois chamados, a e b; b espera sentado na cabeceira (4,25; −5,40).
    2. Abre um planejamento: o Manager `conv:p` (`placement: { kind: 'destination', papel: 'reuniao-cabeceira' }`) recebe `managerSeat(0)`, a mesma cadeira.
    3. A fila não muda, então ninguém a reaplica.
    4. Resultado esperado hoje: `conv:b` e `conv:p` sentados na mesma cadeira.
  - **Cenário B (o Manager troca de cadeira e não levanta):**
    1. Managers p1 e p2 sentados nas cadeiras 0 e 1 (rode o crowd até sentarem).
    2. O plano de p1 é enviado (`offstage: true` no modelo de p1). No layout novo, p2 vira o Manager 0 (`home` = cadeira 0), mas o cérebro continua na cadeira 1, porque o modo `fixed` não é refeito.
    3. Entra p3 e vira o Manager 1, cadeira 1.
    4. Resultado esperado hoje: `conv:p2` e `conv:p3` na cadeira (7,98; −5,40).
- **Asserção:** depois de cada passo (rodando o crowd ~20–30 s), agrupe os cérebros sentados (`seat === 'chair'` e `sit` ≈ 1) por posição (x, z arredondados a 2 casas) dentro da sala de reunião e exija que **nenhuma posição tenha dois agentes**.

Aceite: os dois testes novos existem e **falham** no código atual, e a mensagem mostra a cadeira dupla (A: `conv:b` + `conv:p` em 4,25; −5,40. B: `conv:p2` + `conv:p3` em 7,98; −5,40).
Verificar com: `npx vitest run src/renderer/src/office3d/destinations.test.ts`.
Decidido: o `cadeiras.test.ts` do _sandbox não existe aqui; refaça os cenários pela descrição acima. Ponha num helper local do teste a chamada que espelha a cena (ex.: `venues(layout, fila)`); na etapa 4 só esse helper muda de assinatura. Não corrija nada nesta etapa: o vermelho prova o bug.

### 4. [assento-exclusivo] Uma cadeira por agente na sala de reunião
Cards: [[Cadeiras da sala de reunião: uma por agente]] e [["Colisões" é só a cadeira ou também quem se atravessa andando?]].
1. **Cabeceira com memória** (`layout.ts:363-366`):
   - `Office3DLayout` ganha `managerOf: Record<string, number>`: chave do Manager → índice em `MANAGER_CHAIRS`, como o `deskOf`. Ponha `managerOf: {}` no `EMPTY_LAYOUT` (`:155`).
   - Primeiro passe: o Manager que já tinha cadeira em `prev.managerOf` fica com ela, se continua em cena.
   - Segundo passe: quem chega pega a primeira livre na ordem de `MANAGER_CHAIRS`.
   - Quem está offstage não ocupa cadeira. Um Manager sair não faz os outros trocarem de lugar.
2. **A fila da TV usa as cadeiras reais dos Managers e é refeita a cada layout:**
   - `meetingSpots` (`meetingRoom.ts:77`) passa a receber as POSIÇÕES das cadeiras ocupadas pelos Managers, não a contagem. Crie em `meetingRoom.ts` um helper puro que tira do layout as cadeiras dos personagens com `spot === 'manager'`.
   - A cena guarda a última fila recebida no `onRoom` e também chama `crowd.setVenues(meetingSpots(fila, cadeiras))` no `sync()`, depois do `syncCharacters`.
   - O `setVenues` já ignora quem não mudou (`sameSpot`). Quem esperava numa cadeira que um Manager tomou vai para a próxima livre.
   - Atualize a chamada `meetingSpots([...], 1)` de `destinations.test.ts:208` para a nova assinatura, mantendo a asserção.
3. **Se o `home` muda, o cérebro vai para o novo** (`crowd.ts:303`): se o `home` de um cérebro com `role === 'fixed'` (Manager, PO, memória) muda mais de 5 cm, faça `b.mode = 'init'`, como o `setVenues` faz em `:237`. Ele levanta e anda até o lugar novo. É a rede de proteção para os lugares dados por contador.
4. **Testes:** os cenários A e B da etapa 3 ficam verdes. Some a eles:
   - um Manager sai e outro chega;
   - dois chamados esperando com dois Managers;
   - o chamado atendido (a fila anda).

   Em todos, nenhuma cadeira com dois agentes. Os testes que já existem em `destinations.test.ts` continuam passando, inclusive "quem espera na sala não toma a cadeira dele".

Aceite: os testes A, B e os três casos novos passam; a suíte do `office3d` está verde (a altura ainda não mudou); `crowd.ts` e `scene.ts` não passam de 500 linhas.
Verificar com: `npx vitest run src/renderer/src/office3d`; `npm run typecheck`; `wc -l src/renderer/src/office3d/crowd.ts src/renderer/src/office3d/scene.ts`.
Decidido:
- A mudança de assinatura do `meetingSpots` é permitida.
- O desvio entre agentes que andam está FORA (decisão do usuário). Não mexa na navegação.
- Essa parte não toca em nenhum arquivo da parte da altura (cadeira 3D e pose).
- Se `crowd.ts`/`scene.ts` precisarem de linhas, mova a lógica para `meetingRoom.ts` e enxugue.

### 5. [ajuste-cadeira] Refazer a cadeira 3D no assento padrão, tudo derivado do SEAT_TOP
Card: [[Cadeira 3D inteira derivada do assento]].
- `poses.ts:316`: `chair: 0.46`, e atualize o comentário `:312-315`.
- `chairModel.ts`: cada peça desce junto com o assento.
  - **Coluna a gás** (`:65`): encurte até a base do estofado (`SEAT_TOP − 0.14`, ~0,32 m), sem atravessar o assento.
  - **Encosto** (`:62`, centro 0,88) e **suporte do encosto** (`:67`, 0,66): descem a mesma distância que o assento (0,59 − SEAT_TOP).
  - **Braços** (`:75-76`): o topo do apoio fica a SEAT_TOP + 0,20–0,22 (~0,66–0,68), abaixo de 0,725; as colunas dos braços acompanham.
  - **Não mudam:** a base de 5 pés, os rodízios, `CHAIR_HALF_W`, `CHAIR_BASE_R` e `CHAIR_CENTER_Z` (são o obstáculo da navegação e o recuo).
  - Exporte as alturas calculadas (ex.: `ARM_TOP`, `ARM_BOTTOM`, `BACK_CENTER_Y`, `BACK_H`) e refaça o cabeçalho (hoje fala em assento a 0,59 e braços a 0,80).
- `seatedPose.test.ts`: troque os números repetidos pelas alturas exportadas: `backFront` com 0,88 (`:23`), as faixas do encosto 0,58–1,18 (`:39-42`) e os braços 0,775–0,815 (`:43-44`). Acrescente uma spec curta da geometria: o topo dos braços abaixo de `DESK_HEIGHT − 0.025` e o topo da coluna ≤ a base do estofado.
- Comentários: `officePlan.ts:8-9` e `:69-73`, e `poses.ts:362` ("Cadeira (alta, a do mockup)").
- O `party.ts:57` usa `SEAT_TOP` e acompanha sozinho; confira na foto da etapa 8.

Aceite: `SEAT_HEIGHT.chair === 0.46`; em `chairModel.ts` nenhuma altura de peça feita para o assento de 0,59 fica fixa (todas saem de `SEAT_TOP`, exceto a base e os rodízios); a spec nova da geometria passa; o typecheck está verde.
Verificar com: `npm run typecheck`; `npx vitest run src/renderer/src/office3d/seatedPose.test.ts`. A spec da geometria passa; as specs de pose que falharem ficam listadas no chat e são resolvidas na etapa 6.
Decidido: só a cadeira de escritório muda. O sofá e a beira da mesa ficam. A sala de reunião usa o mesmo `officeChairGeometries()` (`decorBack.ts:45`) e desce junto, sem código a mais.

### 6. [ajuste-pose] Pose sentada no assento novo: pés no chão e mãos no teclado
Card: [[Pose sentada no assento novo: pés no chão e mãos no teclado]].
1. **Pernas** (`sitLower`, ramo da cadeira, `poses.ts:362-377`):
   - Coxa ~horizontal, canela perto da vertical e **pé apoiado no chão**. Quem tem canela longa pode ficar com um pouco de ponta de pé. Os joelhos dos avatares ficam de 46 a 57 cm do chão.
   - Mantenha o `vary` (cada um senta do seu jeito) e os joelhos sob o tampo.
   - Na spec da pose (`seatedPose.test.ts:123-147`), troque "ponta do pé no chão (calcanhar erguido)" por pé apoiado e mantenha o resto.
2. **Mãos no teclado** (`reach.ts`):
   - A IK já usa `SEATED_HIP = SEAT_HEIGHT.chair + 0.075` e acompanha sozinha.
   - Exigência: **nenhum avatar com o braço esticado inteiro** em `type` (lean 0,1) e `typeFast` (lean 0,16), e o antebraço entre −20° e +20° da horizontal.
   - O executor fica 2 cm curto. Faça o menor ajuste que resolve, nesta ordem de preferência: aproximar o teclado (`KEYBOARD_FRONT`, `officePlan.ts:76`) ou a cadeira (`SEAT_FRONT`, `:74`), ou o assento dentro de 0,44–0,48. Mantenha o teste "joelhos sob o tampo".
3. **Cochilo na mesa** (`napDesk`, `gestures.ts:289-301`): os ângulos foram buscados para o assento antigo. Reajuste para a cabeça deitar sobre os braços cruzados no tampo, sem atravessar.
4. **Ações e reações sentadas** (readScreen, drum, sip, web, assist e as reações de `reactions.ts`): o tampo agora fica mais perto do peito. As duas specs de colisão do `seatedPose.test.ts` têm de continuar passando; reajuste os ângulos que baterem.
5. **Clipes sentados do Mixamo** (`motionPick.ts:74-84`): não passam pelo teste de colisão. Confira na foto que os braços não atravessam a borda da mesa.
6. **Sala de reunião:** é a mesma cadeira e a mesma conta. Confira quem senta lá (Manager e quem espera a vez).

Aceite:
- todas as specs do `seatedPose.test.ts` passam, com a spec da pose exigindo pé apoiado no chão;
- `poses.test.ts` e `agentPoses.test.ts` passam;
- nas fotos do `--poses`: pés no chão, mãos no teclado com o antebraço quase horizontal, cochilo com a cabeça sobre os braços no tampo, sala de reunião certa e nenhum braço atravessando a borda da mesa.

Verificar com: `npx vitest run src/renderer/src/office3d`; `node scripts/office-agents/app-harness.mjs --poses` e Read das fotos.
Decidido:
- O monitor e a mesa não mudam.
- Se o assento precisar sair de 0,46, fique em 0,44–0,48 e escreva "DESVIO DO PLANO: …" com o valor e o motivo.
- Escolha o menor ajuste para o executor e diga qual foi.

### 7. [teste-ergonomia] Teste de ergonomia por avatar
Card: [[Teste de ergonomia por avatar]].
- **Teste novo:** `src/renderer/src/office3d/seatedReach.test.ts`.
  - Abra cada GLB de `resources/office-agents` (hoje: principal, executor, critico, navegador-de-codigo, memoria, po, vigia, subagente, central) sem o GLTFLoader, como faz o `agentCast.test.ts`, e passe pelo `prepareAvatar`. Use `t.metrics` como `b` e `t.fit` como `scale`.
  - Teste também o boneco (`BODY`) nas escalas 1 e 0,85.
  - Reaproveite o leitor de GLB do `agentCast.test.ts`; extraí-lo para um helper compartilhado é permitido.
- **Para cada um, sentado na estação, com a conta da IK do `reach.ts`** (lean 0,1 do `type` e 0,16 do `typeFast`), exija:
  - (a) o punho no alvo do teclado (`DESK_TOP + 0.055`, `KEYS_AHEAD`) **sem o braço esticado inteiro**;
  - (b) o antebraço entre −20° e +20° da horizontal;
  - (c) o quadril acima do assento e o joelho abaixo da face de baixo do tampo.
- **Confira também as constantes:** assento entre 0,42 e 0,52 e tampo entre 0,72 e 0,78.
- **Não copie a fórmula:** exporte do `reach.ts` a conta que devolve, além de `fwd`/`elbow`, se alcançou (`d` não limitado a `L1+L2`) e o ângulo do antebraço. O comportamento em runtime não muda.
- **Calibração:** com o assento a 0,59, a sua conta tem de dar resultados próximos aos do [Texto] 8ffc37-medidas.txt (ex.: boneco escala 1 com antebraço −15°; 8 de 9 avatares não alcançam). Se divergir muito, escreva ATENÇÃO e siga com a conta do `reach.ts`.

Aceite: `seatedReach.test.ts` passa para o boneco (1 e 0,85) e para todos os GLB presentes. Prova vermelho/verde: com `SEAT_HEIGHT.chair` trocado temporariamente para 0.59, o teste FALHA; restaurado, passa.
Verificar com: `npx vitest run src/renderer/src/office3d/seatedReach.test.ts`, rodado nos dois estados (0.59 → falha; restaurado → passa), com as saídas no chat.
Decidido:
- O teste roda sobre os GLB que existem, sem quebrar se faltar algum, como o `agentCast.test.ts`.
- O critério 1 de aceite fala do boneco e dos 8 avatares que sentam. Testar os 9 GLB não atrapalha: a Central, com o assento a 0,46, fica com o antebraço em −18° e passa.

### 8. [verificacao] Verificação final, fotos de depois, celular e commit
Cards: [[Verificação e critérios de aceite]] e [[Risco: outra implementação mexendo no app do celular]].
- **Comandos:** `npm run typecheck`, `npm test` (o `seatedPose.test.ts` leva até 2 min) e `npm run build`. Compare com a linha de base da etapa 2.
- **Fotos de DEPOIS:** `node scripts/office-agents/app-harness.mjs --desks` e `--poses`. Abra com Read as fotos de antes (as pastas da etapa 1) e as de depois e descreva a diferença, par a par. No relatório, liste os caminhos de antes e de depois lado a lado, para o usuário conferir a estética.
- **Sala de reunião sem cadeira dupla:**
  - A prova é o teste de regressão verde.
  - No app, tente reproduzir com o harness (`--keep` + `scripts/office-agents/cdp-eval.mjs`; a demo tem um Manager): enviar um plano e abrir outro planejamento, com um chamado esperando se der.
  - Se o harness não permitir reproduzir esse fluxo, diga explicitamente que o fluxo no app real não foi validado; não afirme que foi.
- **Celular:**
  - Antes, rode `git status --short`. Se houver mudança alheia não commitada em `src/phone/**` ou `package*.json`, NÃO rode `phone:build`; escreva ATENÇÃO e relate.
  - Senão, rode `npm run phone:build`, que regera `smartfone-remote/www/`.
- **Commit:**
  - Um commit só com os arquivos desta mudança: `src/renderer/src/office3d/**` e, se o `phone:build` rodou, `smartfone-remote/www/`.
  - Mensagem no padrão do repo, ex.: `fix(escritorio): cadeira na altura padrão (assento 0,46), mãos no teclado e uma cadeira por agente na sala de reunião`.
  - Sem `Co-Authored-By`, sem push e sem mexer na versão.

Aceite: typecheck, test e build com exit 0 (ou só com falhas que já estavam na linha de base, listadas); as fotos de depois (`--desks` e `--poses`) gravadas e comparadas com as de antes; `phone:build` feito, ou pulado com a razão numa linha ATENÇÃO; um commit só com os arquivos desta mudança.
Verificar com: a saída dos três comandos; as pastas `capturas:` de antes e de depois; `git show --stat HEAD`; `git status --short`.
Decidido: o usuário confere a estética no PC e no celular. Confirmar que funciona é obrigação da implementação. Não suba nem reinicie o app em uso; use só o harness isolado.

## Critérios de aceite (todos)
1. Sentados digitando, o boneco e os 8 avatares que sentam ficam com as mãos no teclado na altura do cotovelo (antebraço quase horizontal, −20° a +20°), sem nenhum braço esticado.
2. Os braços da cadeira ficam abaixo do tampo e a coluna não atravessa o assento.
3. Os pés ficam no chão.
4. No cochilo na mesa, a cabeça fica sobre os braços no tampo e nada atravessa.
5. Quem senta na sala de reunião fica certo (mesma cadeira, mesma conta).
6. Sala de reunião sem cadeira dupla: o teste de regressão passa e, no app, depois de enviar um plano e abrir outro planejamento (com um chamado esperando, se houver), cada agente fica na sua cadeira. Se não deu para validar no app, diga.
7. Typecheck, testes (inclusive o novo `seatedReach.test.ts`) e build passam.
8. O usuário confere no PC e no celular (estética).

## Relatório final
- O que mudou, por etapa, com o tempo de cada uma: "levou Y min (dentro/fora do prazo)".
- As saídas de verificação (comandos e exit codes) e os caminhos das fotos de antes e de depois.
- O que não foi validado de fato.
- A seção **"Atenções"**, com todas as linhas ATENÇÃO e DESVIO DO PLANO.
