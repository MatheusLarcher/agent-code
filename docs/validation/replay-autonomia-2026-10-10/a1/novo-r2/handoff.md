<!-- prompt 1 -->
# Handoff — Altura da mesa muito baixa (cadeira no padrão + uma cadeira por agente na sala de reunião)

## Arquivos

Abra TODOS os arquivos de "Ler antes de começar" numa única resposta, com as leituras em paralelo. Não reexplore o que a lista cobre; use Grep/Glob só para o que faltar. As linhas são pista: o código pode ter mudado desde o planejamento.

Caminhos relativos à raiz do projeto `D:\agent-code-replay\a1\agent-code`. Conferidos no commit `8c89585` (árvore limpa em 10/10/2026).

### Ler antes de começar
- `src/renderer/src/office3d/poses.ts:310-378`: `SEAT_HEIGHT` (316, `chair: 0.59`), `SIT_ON` (319, cadeira 0,09), `sitLower` (331) e o ramo da cadeira (362-377, calcanhar erguido e ponta do pé no chão).
- `src/renderer/src/office3d/chairModel.ts:1-79`: a cadeira inteira. Só o estofado do assento usa `SEAT_TOP` (61). Os outros números são fixos: encosto 0.88 (62), coluna 0.27/0.41 (65), suporte do encosto 0.66 (67), colunas dos braços 0.68 (75) e apoio dos braços 0.795 (76).
- `src/renderer/src/office3d/reach.ts:1-77`: `DESK_TOP` (12), `SEATED_HIP = SEAT_HEIGHT.chair + 0.075` (13), `KEYS_AHEAD` (15), o `solve` privado com o objeto `ik` reaproveitado (21, 30-41; o braço é encurtado na 35), `reach` (44) e `typing` (68-77).
- `src/renderer/src/office3d/officePlan.ts:1-80`: o cabeçalho (8-9, "assento perto de 0,36 m", desatualizado), `DESK_HEIGHT = 0.75` (63), `MONITOR_Y` (67), o comentário dos braços a 0,80 (69-73), `SEAT_FRONT = 0.95` (74) e `KEYBOARD_FRONT = 0.45` (76).
- `src/renderer/src/office3d/seatedPose.test.ts:1-148`: o teste de colisão da pose sentada. Repete números da cadeira: `backFront` com 0.88 (23), faixas do encosto 0.58–1.18 (39-42) e braços 0.775–0.815 (43-44). As ações sentadas estão na 49 e as reações na 50.
- `src/renderer/src/office3d/gestures.ts:289-301`: `napDesk`, com ângulos fixos "buscados no rig".
- `src/renderer/src/office3d/reactions.ts:71`: as reações sentadas, que usam a borda do tampo (`SEAT_FRONT`).
- `src/renderer/src/office3d/motionPick.ts:70-143`: os clipes sentados do Mixamo (máscara `upper`, 135-143). Eles não passam pelo teste de colisão.
- `src/renderer/src/office3d/agentCast.test.ts:1-186`: como abrir os GLB sem o GLTFLoader e passar pelo `prepareAvatar`, e a tabela `CAST` dos 9 papéis (45-55).
- `src/renderer/src/office3d/agentRest.ts:39-60` e `:94`: `AvatarTemplate` (com `metrics` e `fit`) e `prepareAvatar`.
- `src/renderer/src/office3d/layout.ts:129-155`, `:180-266` e `:269-376`: `Office3DLayout` (`deskOf`, 135) e `EMPTY_LAYOUT` (155); as mesas com memória via `prev` (197-206); o lounge com memória (275-291); a cabeceira SEM memória, `managerSeat(counters.manager++)` (363-366); os agentes fora de cena (317-319).
- `src/renderer/src/office3d/meetingRoom.ts:1-102`: `WAIT_CHAIRS` (42), `MANAGER_CHAIRS` (51), `managerSeat` (70), `meetingSpots(order, managers = 0)` (77, exclui as cadeiras dos Managers pela contagem) e `sameSpot` (100).
- `src/renderer/src/office3d/scene.ts:129-131` e `:160-241`: o `onRoom` passa a contagem de Managers (131); o `sync` (160) e o `syncCharacters` com o `crowd.upsert` (222). **O arquivo tem 499 linhas.**
- `src/renderer/src/office3d/crowd.ts:228-306`: `setVenues` (232-239, faz `mode = 'init'` na 237) e `upsert` (272-306, no personagem existente só faz `Object.assign` do `home`, na 303). **O arquivo tem 500 linhas.**
- `src/renderer/src/office3d/brain.ts:177`, `:452-453` e `:472-484`: o modo `fixed` só reage a troca de modo (`if (m !== b.mode) enterMode`, 477).
- `src/renderer/src/office3d/projectors.ts:203-214`: `emitRoom`. A fila da TV só avisa quando a assinatura (chamados e testes) muda.
- `src/renderer/src/office3d/destinations.test.ts:1-32` e `:189-254`: os helpers `world()`/`run()`, o teste do Manager "quem espera na sala não toma a cadeira dele" (207-209) e o dos chamados (213-253).
- `src/renderer/src/office3d/party.ts:56-57`: o objeto sobre o assento usa `SEAT_TOP` e acompanha sozinho.
- `src/renderer/src/office3d/decorBack.ts:141-142`: a mesa da sala de reunião, em `DESK_HEIGHT` (não muda).
- `scripts/office-agents/app-harness.mjs:1-35`: o harness isolado e os modos `--desks`, `--poses` e `--keep`.

### Editar/criar
- `src/renderer/src/office3d/poses.ts`: `SEAT_HEIGHT.chair` de 0.59 para 0.46; o comentário de 312-315; o ramo da cadeira de `sitLower` com o pé apoiado no chão; o comentário da 362-364.
- `src/renderer/src/office3d/chairModel.ts`: todas as alturas das peças derivadas de `SEAT_TOP`, exportadas (ex.: `ARM_TOP`, `BACK_CENTER_Y`); o cabeçalho.
- `src/renderer/src/office3d/officePlan.ts`: os comentários de 8-9 e 69-73. `KEYBOARD_FRONT` só se o executor precisar (etapa 6).
- `src/renderer/src/office3d/reach.ts`: exportar a conta do alcance (se alcançou e o ângulo do antebraço) sem mudar o resultado de `reach`/`typing`.
- `src/renderer/src/office3d/gestures.ts`: `napDesk` e as ações sentadas que baterem no tampo.
- `src/renderer/src/office3d/reactions.ts`: os ângulos que baterem no tampo, se o teste acusar.
- `src/renderer/src/office3d/seatedPose.test.ts`: usar as constantes exportadas do `chairModel` em vez dos números repetidos.
- `src/renderer/src/office3d/seatedReach.test.ts` (**novo**): ergonomia por avatar.
- `src/renderer/src/office3d/layout.ts`: o mapa `managerOf` no `Office3DLayout` e no `EMPTY_LAYOUT`; a cabeceira com memória.
- `src/renderer/src/office3d/meetingRoom.ts`: `meetingSpots` passa a receber as cadeiras ocupadas pelos Managers (posições, não a contagem).
- `src/renderer/src/office3d/scene.ts`: guardar a última fila e refazer `setVenues` também no `sync` (sem passar de 500 linhas).
- `src/renderer/src/office3d/crowd.ts`: no `upsert`, se o `home` de um `fixed` mudar mais de ~5 cm, o modo vai para `init` (sem passar de 500 linhas).
- `src/renderer/src/office3d/destinations.test.ts`: os testes de regressão da cadeira dupla e as chamadas de `meetingSpots` (80, 94, 208, 219, 243, 249) na assinatura nova.
- `smartfone-remote/www/`: regerado por `npm run phone:build` (etapa 8, com a condição do risco).

---

## Objetivo

O usuário reclamou que a mesa do escritório 3D está baixa: o agente digita com a mão "lá embaixo". O diagnóstico mostrou que **a mesa já está no padrão** (tampo a 0,775 m) e **a cadeira está 13 cm acima do padrão** (assento a 0,59 m, braços acima do tampo). O braço estica inteiro para baixo até o teclado: 8 dos 9 avatares nem alcançam. A entrega:
1. o assento da cadeira desce para o padrão (~0,46 m), a cadeira 3D é refeita em função do assento e a pose sentada é ajustada: pés no chão, mãos no teclado com o antebraço quase horizontal, cochilo e reações sem atravessar o tampo;
2. um teste de ergonomia por avatar, para o problema não voltar;
3. **uma cadeira por agente na sala de reunião**: hoje dois agentes chegam a sentar na mesma cadeira (pedido do usuário: "colisões").

## Como trabalhar (obrigatório)

- **Plano:** declare as 8 etapas abaixo como plano (TodoWrite/TaskCreate). Cada item começa pelo id da etapa entre colchetes, ex.: `[ajuste-cadeira] Refazer a cadeira 3D no assento padrão`. Siga a ordem.
- **Pasta do plano:** `D:\agent-code-replay\runs\a1-novo-r2\agent-code\planning\agent-code\plano-20261006-1026`. Consulte os cards de lá pontualmente quando precisar de um detalhe. **Não replaneje**: o plano está decidido.
- **Tempo de cada etapa:** ao começar, registre sua estimativa com `mcp__entregas__entrega_estimar` e escreva no chat: "Etapa N — <título>: estimativa do plano X min (prazo), minha estimativa Z min". Ao concluir, consulte `mcp__entregas__entrega_tempo` e escreva: "levou Y min de trabalho (dentro/fora do prazo)" e, se passou, o motivo. O prazo é a estimativa do plano; a sua não o muda, e o tempo que vale é o medido pelo app.
- **Avaliação contínua (avisa, não para):**
  - (a) Antes de cada etapa, rode `git status --short` e `git diff --stat` dos arquivos que ela vai tocar, compare com a seção Arquivos e leia o bloco OUTRAS_CONVERSAS. Se outra conversa mexeu num arquivo seu, se o código mudou desde o planejamento (a linha não bate, o símbolo sumiu) ou se uma premissa de card não vale mais, escreva no chat uma linha que começa com "ATENÇÃO: " dizendo o que mudou e o que vai fazer. Não reverta nada de ninguém; adapte e siga.
  - (b) Se a evidência contradisser uma decisão do plano, escreva uma linha que começa com "DESVIO DO PLANO: " com o que encontrou e o que fez, e siga.
  - (c) Ao fechar cada etapa, faça um autocheck de 3 linhas, em texto livre e sem nota: "Pode quebrar: …", "Não testei: …", "Olhe isto: …".
  - (d) O relatório final tem a seção **"Atenções"**, com todas as linhas ATENÇÃO e DESVIO DO PLANO.
  - (e) Nada disso é pergunta: avise e siga.
- **Pronto é verificado, não suposto:** typecheck e testes verdes não bastam. Antes de dizer "pronto", rode o app (o harness isolado) e olhe as fotos. O que não der para exercitar, diga explicitamente que não foi exercitado. Ao usuário só cabe o julgamento estético.

## Autonomia — card [[Autonomia da implementação]] (`decisao-autonomia-handoff`)

- **Perguntas:** nenhuma. Siga os cards e avise com ATENÇÃO/DESVIO DO PLANO em vez de perguntar.
- **Permissões:** permitir tudo, exceto destrutivo.
- **Continua proibido sem perguntar:** reverter, descartar ou incluir no commit mudanças de outras conversas (`git checkout/restore/reset/stash/clean`); parar ou reiniciar o app em uso; dar push; mexer em `package.json` ou lockfiles; instalar pacote global.

## Mídias do plano (abra com Read)

- [Texto] 8ffc37-medidas.txt — D:\agent-code-replay\runs\a1-novo-r2\agent-code\planning\agent-code\plano-20261006-1026\midia\8ffc37-medidas.txt: as medidas do boneco (escalas 1 e 0,85) e dos 9 avatares com o assento a 0,59 e a 0,46. Para cada um: ombro e cotovelo acima do tampo, quanto falta até o teclado, ângulo do antebraço, se alcança, joelho e quadril. **É a referência numérica das etapas 6 e 7.**
- [Texto] c913ed-cadeiras.txt — D:\agent-code-replay\runs\a1-novo-r2\agent-code\planning\agent-code\plano-20261006-1026\midia\c913ed-cadeiras.txt: a saída da reprodução dos cenários A e B da cadeira dupla (quem senta onde a cada passo). **É a referência da etapa 4.**

(Imagem e PDF o Read mostra de verdade; estes dois são texto.)

**Atenção:** os protótipos `docs/spec/plano-20261006-1026/_sandbox/measure.test.ts` e `cadeiras.test.ts`, citados nos cards, **não existem mais em disco** (o `_sandbox` é ignorado pelo git e não foi preservado). Reconstrua a conta e os cenários a partir dos cards e das duas mídias acima. A conta está descrita na etapa 7 e os cenários na etapa 4.

## Decisões (com o porquê)

- **A mesa fica como está e o assento da cadeira desce para ~0,46 m** (card [[Mesa fica como está; assento da cadeira desce para ~0,46 m]]). `DESK_HEIGHT` continua 0.75 e não mudam monitor, divisórias, objetos da mesa nem o console da Central. `SEAT_HEIGHT.chair` vai a **0.46**. Pode ficar entre 0,44 e 0,48 se a pose pedir, **nunca fora de 0,42–0,52** (faixa da NBR 13962). Os braços da cadeira ficam ~0,20–0,22 m acima do assento (~0,66–0,68 m), abaixo do tampo. O sofá (`SEAT_HEIGHT.sofa`) e a beira da mesa (`SEAT_HEIGHT.desk`) **não mudam**. *Por quê:* quem está fora do padrão é a cadeira; com o assento padrão, 8 de 9 avatares alcançam o teclado (o 9º precisa de um ajuste pequeno) e os pés vão ao chão; e custa menos que subir a mesa e tudo o que está sobre ela. Todas as cadeiras (24 estações e sala de reunião) usam o mesmo modelo e a mesma constante, então descem juntas.
- **"Colisões" = só lugares** (ambiguidade resolvida, abaixo). Corrige dois agentes no mesmo assento ou no mesmo lugar fixo. O desvio entre agentes que andam fica **fora**.
- **Autonomia:** padrão autônomo (acima). *Por quê:* projeto local, visual, sem produção, dados reais nem dinheiro.

## Sugestões aceitas (com fonte)

- **Baixar a cadeira ao padrão em vez de subir a mesa** (card [[Baixar a cadeira ao padrão em vez de subir a mesa]], status aceita). Subir a mesa obrigaria a subir monitor, divisórias, teclado, objetos e a mesa da reunião, e deixaria o tampo com altura de balcão (~0,87 m), fora do padrão. Fontes:
  - assento: ABNT NBR 13962, mínimo de 420 mm do assento ao piso (https://www.gov.br/icmbio/pt-br/acesso-a-informacao/licitacoes-e-contratos/licitacoes/dispensas/exercicios-anteriores/2020/projeto_basico_dispensa_7_2020_poltronas_giratorias.pdf);
  - mesa: ABNT NBR 13966:2008, 720/750 mm (https://www.trt7.jus.br/files/contas_publicas/licitacoes/pregao_eletronico/2025/PE_90026_2025/TERMO%20DE%20REFERENCIA%20ANEXO%20I%20-%20VALOR%20ESTIMADO%20E%20ESPECIFICACOES.pdf).

## Ambiguidade resolvida

- **"Colisões" é só a cadeira ou também quem se atravessa andando?** O usuário escolheu (06/10/2026) **"Só lugares"**. Não implemente desvio entre agentes que andam e não mexa na navegação (`nav.ts`, `brain*.ts`) por causa disso.

## Etapas e estimativas

| # | Etapa | Estimativa do plano (min de agente) |
|---|---|---|
| 1 | [diagnostico] Confirmar o diagnóstico e tirar as fotos de antes | 5 |
| 2 | [altura-padrao] Aplicar a altura padrão do assento | 5 |
| 3 | [diagnostico-cadeira-dupla] Confirmar a causa da cadeira dupla | 5 |
| 4 | [assento-exclusivo] Cadeira exclusiva na sala de reunião | 35 |
| 5 | [ajuste-cadeira] Refazer a cadeira 3D derivada do `SEAT_TOP` | 20 |
| 6 | [ajuste-pose] Ajustar a pose sentada ao assento novo | 45 |
| 7 | [teste-ergonomia] Teste de ergonomia por avatar | 15 |
| 8 | [verificacao] Verificação, fotos, celular e commit | 30 |
| | **Total deste prompt** | **160 min (2 h 40 min)** |

---

### 1. [diagnostico] Diagnóstico: a mesa já está no padrão; a cadeira alta obriga o braço a esticar até o teclado

Cards: [[Diagnóstico: a mesa está no padrão, a cadeira é que está alta]] e a mídia `8ffc37-medidas.txt`.

O que fazer:
- Confira no código atual as premissas: `DESK_HEIGHT = 0.75` (`officePlan.ts:63`), `DESK_TOP = DESK_HEIGHT + 0.025` (`reach.ts:12`), `SEAT_HEIGHT.chair = 0.59` (`poses.ts:316`) e o apoio dos braços a 0.795 (`chairModel.ts:76`).
- **Tire as fotos de ANTES, antes de mexer em qualquer código:** `node scripts/office-agents/app-harness.mjs --desks` (as 24 mesas, com o boneco e com o avatar) e `node scripts/office-agents/app-harness.mjs --poses` (um agente em cada assento: mesa, cochilo na mesa, reunião, sofá). O harness grava as capturas numa pasta temporária. Copie-as para `D:/agent-code-replay/a1/agent-code/docs/spec/plano-20261006-1026/_sandbox/fotos/antes/` (o `docs/spec/*/_sandbox/` está no `.gitignore`).

Aceite: as quatro premissas conferem no código, ou há uma linha ATENÇÃO para cada uma que mudou, e as fotos de antes (`--desks` e `--poses`) estão em `_sandbox/fotos/antes/` e você as abriu com Read.
Verificar com: a saída dos dois comandos do harness; `ls D:/agent-code-replay/a1/agent-code/docs/spec/plano-20261006-1026/_sandbox/fotos/antes/`; Read de pelo menos uma foto de mesa e uma de pose.
Decidido: a mesa não muda; a cadeira está ~13 cm acima do padrão. O harness sobe uma cópia DEV com pasta, HOME e banco temporários e **não mexe no app em uso**. Se o harness falhar no ambiente, escreva ATENÇÃO com o erro e siga com os testes, mas depois **não afirme** comparação visual que não fez.

### 2. [altura-padrao] Decidir as alturas padrão da mesa (tampo) e do assento da cadeira

Cards: [[Mesa fica como está; assento da cadeira desce para ~0,46 m]] e [[Baixar a cadeira ao padrão em vez de subir a mesa]].

O que fazer: `SEAT_HEIGHT.chair` de 0.59 para **0.46** (`poses.ts:316`) e reescrever o comentário de `poses.ts:312-315` (assento padrão ~0,46, NBR 13962; tampo 0,775).

Aceite: `SEAT_HEIGHT` fica `{ chair: 0.46, sofa: 0.6, desk: 0.775 }`; `DESK_HEIGHT` e `MONITOR_Y` sem mudança; o typecheck passa.
Verificar com: `git diff src/renderer/src/office3d/poses.ts src/renderer/src/office3d/officePlan.ts` e `npm run typecheck`.
Decidido: o valor é 0,46; só sai para 0,44–0,48 se a pose da etapa 6 pedir, e nunca fora de 0,42–0,52. O sofá (0.6) e a beira da mesa (0.775) ficam. **Da etapa 2 até o fim da 6, o `seatedPose.test.ts` pode falhar, e isso é esperado:** não afrouxe as exigências dele, ele tem de passar ao fim da etapa 6.

### 3. [diagnostico-cadeira-dupla] Diagnóstico: dois agentes na mesma cadeira da sala de reunião

Cards: [[Diagnóstico: dois agentes na mesma cadeira da sala de reunião]], a mídia `c913ed-cadeiras.txt` e [["Colisões" é só a cadeira ou também quem se atravessa andando?]].

A causa tem dois caminhos que não se falam:
- **Cenário A, fila velha:** b espera sentado na cabeceira (4,25; −5,40). Abre um planejamento e o Manager novo recebe `managerSeat(0)`, a mesma cabeceira. A fila da TV só é refeita quando ela muda (`projectors.ts:209-212`), e a cena exclui as cadeiras dos Managers **pela contagem daquele instante** (`scene.ts:131`). Resultado: `conv:b + conv:p` na mesma cadeira.
- **Cenário B, Manager que muda de cadeira e não levanta:** p1 e p2 sentados nas cadeiras 0 e 1. O plano de p1 é enviado (p1 sai de cena) e p2 vira o Manager 0 (`home` = cadeira 0). Só que `crowd.upsert` (`crowd.ts:303`) só troca o `home`, e o cérebro em `fixed` só reage a troca de modo (`brain.ts:477`): **p2 continua na cadeira 1**. Abre outro planejamento, p3 vira o Manager 1 e vai para a cadeira 1. Resultado: `conv:p2 + conv:p3` na mesma cadeira (foi o caso que o usuário viu).
- **Onde não há furo:** mesas e lounge têm memória (`layout.ts:197-206` e `:275-291`). Sofá e estante usam a reserva do `book`. O furo B também vale para PO (kanban) e memória (estante), mas nesses o agente fica de pé.

Aceite: os quatro pontos da causa (`layout.ts:365` sem memória, `scene.ts:131` pela contagem, `crowd.ts:303` que só troca o `home`, `brain.ts:477`) conferem no código atual, ou há uma linha ATENÇÃO com o que mudou.
Verificar com: Read/Grep nesses quatro pontos e a comparação com `c913ed-cadeiras.txt`.
Decidido: escopo "só lugares". O protótipo `_sandbox/cadeiras.test.ts` não existe mais: os cenários A e B acima são a especificação do teste da etapa 4.

### 4. [assento-exclusivo] Cadeira exclusiva na sala de reunião: cabeceira com memória, fila da TV refeita com as cadeiras reais dos Managers, home novo levanta o agente e teste de regressão

Cards: [[Cadeiras da sala de reunião: uma por agente]] e [["Colisões" é só a cadeira ou também quem se atravessa andando?]].

O que fazer, nesta ordem (primeiro o teste vermelho):
1. **Teste de regressão** em `destinations.test.ts`, usando `world()`/`run()` e o caminho real: `layoutOffice(model, prev)` → `crowd.upsert` → `crowd.setVenues(meetingSpots(...))` → `crowd.step`. Cenários: A; B; um Manager sai e outro chega; dois chamados esperando com dois Managers; o chamado atendido (a fila anda). Depois de **cada passo**, exigir que **nenhuma cadeira tenha dois agentes sentados** (agentes com `sit === 1` a menos de ~0,1 m um do outro). Rode e veja falhar no código atual.
2. **Cabeceira com memória** (`layout.ts:363-366`): um mapa `managerOf: Record<string, number>` no `Office3DLayout`, como o `deskOf`, também no `EMPTY_LAYOUT` (`layout.ts:155`). Quem já tinha cadeira fica com ela. Quem chega pega a primeira livre na ordem de `MANAGER_CHAIRS`. Quem está fora de cena (`c.offstage`) não ocupa cadeira e libera a dele.
3. **A fila da TV usa as cadeiras reais dos Managers e é refeita a cada layout.** `meetingSpots` (`meetingRoom.ts:77`) recebe as posições das cadeiras ocupadas pelos Managers em vez da contagem. A cena guarda a última fila do `onRoom` e chama `setVenues(meetingSpots(fila, cadeiras))` também no `sync()`, quando o layout muda. O `setVenues` já ignora quem não mudou (`sameSpot`).
4. **O home mudou, o cérebro vai para o novo** (`crowd.ts:303`): se o `home` de um personagem `fixed` mudar mais de ~5 cm, o modo volta a `init`, como o `setVenues` faz na `crowd.ts:237`. Ele levanta e anda até o lugar novo. É a rede de proteção para todo lugar dado por contador (Manager, PO, memória).

Aceite: o teste novo falha com a correção desfeita e passa com ela (red-green); os testes existentes de `destinations`, `layout`, `offstage`, `officePlan` e `life` passam, inclusive "quem espera na sala não toma a cadeira dele" (`destinations.test.ts:207-209`, adaptado à assinatura nova); `scene.ts` e `crowd.ts` com no máximo 500 linhas.
Verificar com: `npx vitest run src/renderer/src/office3d/destinations.test.ts src/renderer/src/office3d/layout.test.ts src/renderer/src/office3d/offstage.test.ts src/renderer/src/office3d/officePlan.test.ts src/renderer/src/office3d/life.test.ts` (verde) e `wc -l src/renderer/src/office3d/scene.ts src/renderer/src/office3d/crowd.ts`. Para o vermelho, rode o teste novo antes da correção.
Decidido:
- `managerSeat(i)` continua existindo: `offstage.test.ts:57,103` e `officePlan.test.ts:194` usam `managerSeat(0)` (a 1ª implementação de um plano nasce no lugar do Manager).
- Atualize as chamadas de `meetingSpots` em `destinations.test.ts` (80, 94, 208, 219, 243, 249). O único chamador de produção é `scene.ts:131`.
- Conflito: se um Manager chega numa cadeira em que alguém da fila esperava, **o Manager fica com ela** e quem espera vai para a próxima livre.
- **Limite de 500 linhas** (AGENTS.md): `scene.ts` tem 499 e `crowd.ts` tem 500. Ponha a lógica no `meetingRoom.ts` (puro) e deixe nos dois só a ligação. Se ainda assim passar, extraia um helper para outro arquivo; não estoure o limite.
- Fora do escopo: desvio entre agentes que andam (hoje eles se atravessam, e continua assim).
- As etapas 5 a 7 não tocam nenhum arquivo desta.

### 5. [ajuste-cadeira] Refazer a cadeira 3D no assento padrão (coluna, braços abaixo do tampo, encosto), com tudo derivado do SEAT_TOP

Card: [[Cadeira 3D inteira derivada do assento]].

Ao baixar o assento, cada peça desce junto:
- a **coluna a gás** (`chairModel.ts:65`, topo hoje a ~0,475) atravessaria o assento novo, cujo estofado começa a ~0,32: encurte-a até a base do estofado;
- o **encosto** (`:62`, centro a 0,88) e o **suporte do encosto** (`:67`, 0,66) descem o mesmo que o assento (`SEAT_TOP − 0.59`);
- os **braços** (`:75-76`, colunas a 0,68 e apoio a 0,795) descem para ~0,20–0,22 m acima do assento (~0,66–0,68 m), **abaixo da face de baixo do tampo (0,725)**;
- a base de 5 pés, os rodízios, `CHAIR_HALF_W`, `CHAIR_BASE_R` e `CHAIR_CENTER_Z` **não mudam**: são o obstáculo da navegação e o recuo.

Exporte de `chairModel.ts` as alturas calculadas a partir de `SEAT_TOP` (ex.: `ARM_TOP`, `BACK_CENTER_Y`) e use-as no `seatedPose.test.ts`, no lugar dos braços 0,775–0,815 (43-44), das faixas do encosto 0,58–1,18 (39-42) e do 0,88 do `backFront` (23).

Aceite: nenhuma altura de peça fixa no `chairModel.ts` fora a base e os rodízios; o topo dos braços entre 0,66 e 0,68 com o assento a 0,46; o topo da coluna ≤ a base do estofado; o `seatedPose.test.ts` sem os números repetidos da cadeira; comentários atualizados.
Verificar com: `grep -n "0\.88\|0\.795\|0\.775\|0\.815\|0\.66\|0\.68" src/renderer/src/office3d/chairModel.ts src/renderer/src/office3d/seatedPose.test.ts` (sem literais da cadeira), `npm run typecheck` e `npx vitest run src/renderer/src/office3d/seatedPose.test.ts` (leva até 2 min; anote quais specs de pose ainda falham, que são a etapa 6).
Decidido:
- Comentários a atualizar: o cabeçalho de `chairModel.ts` (assento a 0,59, braços a 0,80); `officePlan.ts:8-9` ("assento perto de 0,36 m") e `:69-73` (braços a 0,80, acima do tampo); `poses.ts:362` ("Cadeira (alta, a do mockup)").
- `party.ts:57` acompanha sozinho via `SEAT_TOP`; confira na foto da etapa 8.
- A sala de reunião usa a mesma cadeira e desce junto.

### 6. [ajuste-pose] Ajustar a pose sentada ao assento novo: pés no chão, mãos no teclado sem esticar o braço, cochilo na mesa e reações sem atravessar o tampo

Card: [[Pose sentada no assento novo: pés no chão e mãos no teclado]].

1. **Pernas** (`sitLower`, ramo da cadeira, `poses.ts:362` em diante): coxa ~horizontal, canela perto da vertical e **pé apoiado no chão** (canela longa pode ficar com um pouco de ponta de pé). Vale para o boneco e para todos os avatares, cujos joelhos ficam de 46 a 57 cm do chão. Mantenha o `vary` (cada um senta do seu jeito) e os joelhos sob o tampo.
2. **Mãos no teclado** (`typing`/`reach`): a IK já usa `SEATED_HIP = SEAT_HEIGHT.chair + 0.075` e acompanha. Exigência: **nenhum avatar com o braço esticado inteiro** em `type` e `typeFast`, e o antebraço entre −20° e +20° da horizontal. Com o assento a 0,46, o **executor fica 2 cm curto** (antebraço −16°, braço curto do modelo; ver `medidas.txt`).
3. **Cochilo na mesa** (`napDesk`, `gestures.ts:289`): reajuste os ângulos para a cabeça deitar nos braços sobre o tampo, sem atravessar.
4. **Ações e reações sentadas** (readScreen, drum, sip, web, assist e as de `reactions.ts`): o tampo agora fica mais perto do peito. As specs de colisão do `seatedPose.test.ts` têm de passar; reajuste os ângulos que baterem.
5. **Clipes sentados do Mixamo** (sitIdle, sitTalk, sitDrink…, máscara `upper`, `motionPick.ts`): não passam pelo teste de colisão. Confira na foto que os braços não atravessam a borda da mesa.
6. **Sala de reunião:** mesma cadeira e mesma conta; confira quem senta lá.

Aceite: o `seatedPose.test.ts` passa inteiro (colisão das ações e reações sentadas, joelhos sob o tampo); pés no chão no ramo da cadeira; todos os avatares, inclusive o executor, alcançam o teclado sem o braço esticado; no `napDesk` a cabeça fica nos braços sobre o tampo.
Verificar com: `npx vitest run src/renderer/src/office3d/seatedPose.test.ts` (verde, até 2 min) e as fotos `node scripts/office-agents/app-harness.mjs --poses` e `--desks`, abertas com Read, olhando pés, mãos no teclado, cochilo, clipes do Mixamo e a sala de reunião.
Decidido:
- Para o executor, escolha o **menor ajuste**, sem quebrar "joelhos sob o tampo". Prefira aproximar o teclado (`KEYBOARD_FRONT`, `officePlan.ts:76`): ele só é usado por `reach.ts`, `decorIslands.ts:90-91` (desenho) e `seatedPose.test.ts`. Evite mexer em `SEAT_FRONT`, que move o lugar de sentar em `layout.ts:323`, a navegação em `furniture.ts:159,166,249`, `decorIslands.ts:61`, `reactions.ts:71` e `party.ts:56`. A outra opção é o assento entre 0,44 e 0,48.
- Não mude o sofá nem a beira da mesa.
- Fato do código, para não se confundir: `reach.ts` põe o quadril a assento + 0,075 e `sitLower` usa `SIT_ON.chair = 0.09` (`poses.ts:319`). Só mexa nisso se o teste ou a foto mostrar a mão fora do teclado por causa dessa diferença; se mexer, escreva DESVIO DO PLANO.

### 7. [teste-ergonomia] Teste de regressão: o boneco e cada avatar do elenco alcançam o teclado com o antebraço quase horizontal

Card: [[Teste de ergonomia por avatar]].

Teste novo `src/renderer/src/office3d/seatedReach.test.ts`:
- abre cada GLB de `resources/office-agents` (central, critico, executor, memoria, navegador-de-codigo, po, principal, subagente e vigia) sem o GLTFLoader, como o `agentCast.test.ts`, passa pelo `prepareAvatar` e usa `metrics` e `fit` do `AvatarTemplate` (`agentRest.ts:39-59`). Testa também o boneco (`BODY`), nas escalas 1 e 0,85;
- com o agente sentado na cadeira da estação e a IK do `reach.ts` (lean 0,1 do `type` e 0,16 do `typeFast`), exige:
  - (a) o punho no alvo do teclado **sem o braço esticado inteiro**;
  - (b) o antebraço entre −20° e +20° da horizontal;
  - (c) o quadril acima do assento e o joelho abaixo da face de baixo do tampo;
- confere as constantes: assento entre 0,42 e 0,52 (NBR 13962) e tampo entre 0,72 e 0,78.

Aceite: `seatedReach.test.ts` verde com as medidas novas e **vermelho** com `SEAT_HEIGHT.chair` temporariamente em 0,59 (red-green; depois restaure). Os ângulos batem com `medidas.txt` (±2°) para o assento a 0,59 e a 0,46, com o mesmo `KEYBOARD_FRONT` do anexo (0,45).
Verificar com: `npx vitest run src/renderer/src/office3d/seatedReach.test.ts`, verde e depois vermelho com 0,59; e `git diff --stat` mostrando que o 0,59 foi restaurado.
Decidido:
- O teste chama uma função **exportada do `reach.ts`** (ex.: o `solve` devolvendo também se alcançou e o ângulo do antebraço) em vez de copiar a fórmula. Não mude o resultado de `reach()`/`typing()` e não aloque por quadro: o `ik` é reaproveitado (`reach.ts:21`).
- **Alcançou** = `Math.hypot(fz, fy) <= L1 + L2 - 1e-3`, ou seja, o `solve` não precisou encurtar (`reach.ts:35`).
- **Antebraço:** `a = atan2(fz, fy) − atan2(L2·sin e, L1 + L2·cos e)` é o braço medido da vertical para baixo, no mundo, antes do `+ lean`. O antebraço medido da horizontal é `a + e − π/2` (positivo = mão acima do cotovelo). Confira a convenção contra `medidas.txt` (ex.: boneco escala 1: −15° com 0,59 e +14° com 0,46). Se divergir mais que 2°, revise a convenção antes de ajustar a pose.
- Se faltar um GLB no disco, faça como o `agentCast.test.ts`, que só abre os arquivos que existem.

### 8. [verificacao] Verificar: typecheck, testes, build, fotos do harness (--desks/--poses) antes e depois, sala de reunião sem cadeira dupla e o app do celular (phone:build)

Cards: [[Verificação e critérios de aceite]] e [[Risco: outra implementação mexendo no app do celular]].

O que fazer:
1. `npm run typecheck`, `npm test` (o `seatedPose.test.ts` leva até 2 min) e `npm run build` (inclui o binário .NET do controle do Windows e precisa do dotnet SDK). Leia a saída inteira e conte as falhas.
2. Fotos de DEPOIS: `node scripts/office-agents/app-harness.mjs --desks` e `--poses`, copiadas para `.../_sandbox/fotos/depois/`. Abra cada uma com Read e compare com as de antes: braços da cadeira abaixo do tampo, coluna sem atravessar o assento, pés no chão, mãos no teclado na altura do cotovelo, cochilo com a cabeça nos braços, sala de reunião certa e o objeto da festa (`party.ts`) sobre o assento.
3. Cadeira dupla no app: o teste da etapa 4 percorre o caminho real (layout → crowd → step). Se der para exercitar no harness (`--keep` deixa a cópia DEV aberta), faça. Se não, diga explicitamente que no app só foi verificado pelo teste.
4. Celular: `npm run phone:build` regera `smartfone-remote/www/` (a aba Escritório do celular usa o mesmo 3D), com a condição do risco abaixo.
5. Commit local, **sem push** e **sem trailer Co-Authored-By** (AGENTS.md), só com os arquivos desta mudança: `src/renderer/src/office3d/**` e, se o phone:build rodou, `smartfone-remote/www/`.
6. Mostre ao usuário as fotos de antes e depois lado a lado (os caminhos, ou um HTML de comparação no `_sandbox`), só para o julgamento estético.

Aceite:
1. Sentados digitando, o boneco e os avatares que sentam ficam com as mãos no teclado na altura do cotovelo (antebraço quase horizontal), sem nenhum braço esticado.
2. Os braços da cadeira ficam abaixo do tampo e a coluna não atravessa o assento.
3. Os pés ficam no chão.
4. No cochilo na mesa, a cabeça fica sobre os braços no tampo e nada atravessa.
5. Quem senta na sala de reunião fica certo.
6. Sala de reunião sem cadeira dupla: o teste de regressão passa, e no app ou está verificado ou está declarado como não exercitado.
7. typecheck, testes (inclusive `seatedReach.test.ts`) e build passam, com a saída mostrada.
8. O usuário recebe as fotos para a avaliação estética no PC; no celular, o `phone:build` passou (ou foi adiado pelo risco, com ATENÇÃO).

Verificar com: a saída de `npm run typecheck`, `npm test` e `npm run build`; as fotos em `_sandbox/fotos/antes/` e `_sandbox/fotos/depois/`; a saída de `npm run phone:build`; `git status --short` e `git show --stat HEAD`.
Decidido:
- **Risco da outra conversa** ("Conexões múltiplas no app Android"): no planejamento, a árvore tinha mudanças dela em `src/phone/**` e `package*.json`. Em 10/10/2026 a árvore estava limpa e o commit dela não aparece no log. Antes do `phone:build`, rode `git status --short`. Se houver `src/phone/**`, `package.json` ou `package-lock.json` alterados por outra conversa, **não rode `phone:build`** (o bundle levaria o código dela pela metade), escreva ATENÇÃO e commite sem o `www/`. Nunca reverta nem inclua esses arquivos.
- Se algum teste que não é desta mudança falhar (ex.: `pcs.test.ts`), avise o usuário; não "conserte".
- Não pare, reinicie nem derrube o app em uso: as fotos são só pelo harness isolado.
- Verificar que funciona é seu trabalho. Ao usuário cabe só o julgamento estético (aparência da cadeira e da pose).

---

## Riscos

- **Arquivos no limite de 500 linhas:** `scene.ts` (499) e `crowd.ts` (500). Veja a etapa 4.
- **Colisão da pose:** com o tampo mais perto do peito, reações e o `napDesk` podem atravessar o tampo. O `seatedPose.test.ts` pega as ações e reações; os clipes do Mixamo só a foto pega.
- **Executor de braço curto:** pode exigir o ajuste do `KEYBOARD_FRONT`, que desloca o teclado desenhado nas 24 mesas. Confira na foto.
- **Mudança de assinatura do `meetingSpots`:** quebra as chamadas do `destinations.test.ts`, que precisam ser atualizadas.
- **Outra conversa no app do celular:** veja a etapa 8.
- **Protótipos do _sandbox ausentes:** a conta e os cenários vêm dos cards e das mídias. Os números do `medidas.txt` são o gabarito.

## Critérios de aceite (resumo)

São os 8 critérios da etapa 8, mais: o teste de ergonomia vermelho com 0,59 e verde com o assento novo; o teste da cadeira dupla vermelho no código antigo e verde no novo; nenhum arquivo acima de 500 linhas; nenhum arquivo de outra conversa revertido ou commitado.

## Relatório final

1. O que mudou, por etapa, com o tempo medido de cada uma ("levou Y min", dentro/fora do prazo).
2. A saída resumida de typecheck, test, build e phone:build.
3. Os caminhos das fotos de antes e depois.
4. O que não foi exercitado de fato.
5. A seção **"Atenções"**, com todas as linhas ATENÇÃO e DESVIO DO PLANO.
