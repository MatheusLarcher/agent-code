# Teste de acerto de skills — catálogo em níveis desligado × ligado (09/10/2026)

**Veredito:** com o interruptor ligado, o modelo acertou **menos**: 11/40 contra 12/40 com ele desligado. Pela regra combinada, o interruptor "Catálogo de skills em níveis" **fica desligado**. Esse já é o padrão (`DEFAULT_CONFIG.skillCatalog.tiered = false`), então não houve mudança de código.

**Skill que se perdeu:** `systematic-debugging` no pedido p04, rodada 2. O desligado carregou essa skill antes de agir; o ligado foi direto para o PowerShell. Foi a única perda. Nenhum pedido acertou só com o ligado.

Leia o veredito junto com a limitação: a diferença é de 1 execução em 40.
- `systematic-debugging` é de nível **médio**. Nos dois modos ela vai na mesma listagem nativa, com a mesma descrição, então a perda não vem de a skill ter sido escondida.
- Em todo o teste, o modelo carregou skill antes de agir só 3 vezes em 80. Com uma taxa tão baixa, 1 execução de diferença está dentro do ruído.
- O teste **não mostra** que o catálogo em níveis piora o acerto. Mostra que ele **não melhorou** o acerto. E a regra manda ficar com o desligado.

## Como foi medido

- **Onde:** uma cópia isolada do Agent Code, compilada deste repositório, com `AGENT_CODE_DEV_DATA_DIR` próprio, CDP na porta 9339 e as 44 skills do usuário copiadas para o cache dela. O app em uso não foi tocado. A cópia usou o login real (consumiu a conta).
- **Modelo:** Opus 5.5, esforço Alto, iguais nos dois modos. É o padrão do usuário. Numa sondagem anterior com Sonnet 5.5 médio, nenhuma skill foi carregada em nenhum modo.
- **Execuções:** 20 pedidos × 2 modos × 2 rodadas = 80. A rodada 1 foi desligado e depois ligado; a rodada 2, ligado e depois desligado, para não favorecer um modo pela ordem.
  - Cada execução usa uma conversa nova no sandbox (pasta vazia). O modo é trocado por `setConfig({ skillCatalog: { tiered } })`, que também liga ou desliga o kit ECC no cache.
  - Ao fim de cada execução, a conversa é parada e todas as sessões são descartadas.
- **O que chega ao modelo:** um proxy de log entre o app e `api.anthropic.com` (`ANTHROPIC_BASE_URL`) grava cada `tool_use` assim que ele chega.
  - Cada requisição é atribuída ao pedido pela sessão (`x-claude-code-session-id`) e pelo texto do 1º turno.
  - "Skill carregada" = chamada `Skill`, ou `Read` de um `.../skills/<nome>/SKILL.md`.
  - "Busca" = `mcp__skills__skills_buscar`/`skills_listar` ou `ToolSearch`.
- **Até a 1ª ação**, que é a medida principal:
  - Leitura exploratória **não** conta como ação: Read, Glob, Grep e Bash/PowerShell de uma lista fechada de comandos só de leitura (`ls`, `git status`, `Get-ChildItem`…). Esses comandos são liberados automaticamente.
  - Qualquer outra ferramenta, resposta final (`end_turn`) ou pergunta ao usuário encerra a execução. Comandos fora da lista são negados.
  - Teto de 8 chamadas ou 240 s.
  - Motivo da medida: nas primeiras sondagens, o modelo começava quase sempre com um `ls`/`git status` na pasta. Medido ao pé da letra, o teste daria 0 × 0.
- **Estrito**, que é a medida secundária: skills carregadas antes da 1ª ferramenta de qualquer tipo.
- **Acerto:**
  - Pedido com skill esperada: carregou pelo menos uma das esperadas antes da ação.
  - Pedido sem skill: não carregou nenhuma.
  - `verification-before-completion` e `using-superpowers` seriam neutras, mas não apareceram.
- **Execuções inválidas:** quando a resposta não vem (CLI caído) ou a requisição dá erro, a execução é repetida até 3 vezes.
  - O p03 ligado da rodada 1 pegou uma queda de rede da máquina: DNS e timeout para `api.anthropic.com` nas 3 tentativas. Ele foi refeito no fim, com a rede de volta.

## Os 20 pedidos e as skills esperadas (para conferir)

Os pedidos são mensagens reais dos transcripts, com o texto do jeito que foi digitado. As esperadas são as skills que deveriam ser carregadas antes de agir; confira se concorda. Níveis:
- **médio** = esperada de nível médio;
- **baixo** = esperada de nível baixo, que no modo ligado só aparece pelo nome, por categoria;
- **nenhuma** = pedido que não deveria carregar skill.

Origem das esperadas:
- todas são skills do usuário, presentes nos dois modos;
- exceção 1: `git-workflow`, que só existe no kit ECC (modo ligado);
- exceção 2: `security-review`, que é embutida do CLI.

| Pedido | Nível | Skills esperadas | Texto |
|---|---|---|---|
| p01 | médio | `brag`, `brag-slim`, `copywriting`, `hyperframes-cli`, `media-use` | cria um video comercial desse app, ele é gratis eopensource, pode densenvolver tudo sem conhecimento de AI, o video é curto e chamativo. use as melhores skill pra criar o roteiro e depos crie o video com esse roteiro |
| p02 | médio | `brag`, `brag-slim`, `copywriting` | gera um video comercial desse sistema, antes de fazer o video liste os pontos q podemos destacar desse sistema, encontre o melhor publico pra ele, e depos gere o video com base nesse prompt |
| p03 | médio | `copywriting`, `brag`, `brag-slim` | gera um video comercial desse sitema, faz um prompt primeiro pra esse video, faça apenas o prompt |
| p04 | médio | `systematic-debugging` | na conversa Implementação: Mapa interativo com navegação sempre q eu vou continuaar ela, o agent code cracka, preciso q vc descubra o motivo e resolva |
| p05 | médio | `systematic-debugging` | o consumo do modelo as vezes volta pra 0 do nada sendo q é um informação falsa, verifica o motivo e corrije |
| p06 | médio | `systematic-debugging` | ta tando esse erro pra gerar o apk: Iniciando build do APK… Verificando toolchain Android… Instalando dependências… Error: Command failed: gradlew.bat assembleDebug — Execution failed for task ':app:mergeDebugResources' |
| p07 | médio | `copywriting` | precisamos melhorar o readme antes de publicar, preciso dele mas voltado pro publico no perfil q usar esse tipo de app |
| p08 | médio | `3d-print-modeling` | esse suporte é pro bmcu, eu preciso q vc mude ele pra ser suporte pra ptfe, essa boca dele hoje encaixa na maquina, ai a ideia é prender ela na maquina e tobos ptfe os 4 tupos passam por ele |
| p09 | médio | `brainstorming`, `writing-plans` | Adicionar opção de ouvir em áudio as mensagens comentadas pelo agent, em todos os chats |
| p10 | médio | `systematic-debugging` | tem alguma cosia na minha maquina q ta fechando o agent code, verifique oq é |
| p11 | baixo | `security`, `vulnerability-scanner`, `supply-chain-security`, `web-security`, `security-review` | verifica se tem algo confidencia nesse codigo pq vou subir no githb publico |
| p12 | baixo | `git-commit`, `git-workflow` | tem alguns codigo nao comitados, preciso q vc entenda oq e e comite |
| p13 | baixo | `git-commit`, `git-workflow` | depos q terminar de comit e push. gera o build tbm |
| p14 | baixo | `ui-ux-designer`, `web-design-guidelines` | fique observando o escritorio, vc acha q visualemnte podemos melhorar ele? me de sojestão |
| p15 | baixo | `git-commit`, `git-workflow` | depos pode sibir pra landing pag na vps e comit e push |
| p16 | nenhuma | — | Preciso de um farol bi led forte H4, procura no AliExpress um barato pra mim q seja confiável |
| p17 | nenhuma | — | verifica na minha maquina, quais pastas tao muito grande, faz uma busca rapida |
| p18 | nenhuma | — | Serena: encontra definições e referências via LSP, sem ler o arquivo inteiro. oq é LSP? |
| p19 | nenhuma | — | apaga o sonnet 5 do agent code, deixa só o 5.5 |
| p20 | nenhuma | — | como funciona mcp? tbm preciso q o agent code tenha mcp pra algum mandar comando direto pra ele, quando eu uso mcp do claude, eu consigo enviar chamadas pro claude, ou só o claude q chama e os apps respodondem? |

## Resultados

Como ler cada célula: ✅/❌ = acerto, depois as skills carregadas antes da ação, entre parênteses o número de leituras exploratórias, e depois da seta a 1ª ação. "limite" = bateu o teto de 8 chamadas só lendo.

| Pedido | Nível | Desligado r1 | Desligado r2 | Ligado r1 | Ligado r2 |
|---|---|---|---|---|---|
| p01 | médio | ❌ nenhuma → Bash | ❌ nenhuma → Bash | ❌ nenhuma → PowerShell | ❌ nenhuma → Bash |
| p02 | médio | ✅ brag (4 leit.) → PowerShell | ❌ nenhuma (1 leit.) → AskUserQuestion | ✅ brag (1 leit.) → Bash | ❌ nenhuma (1 leit.) → AskUserQuestion |
| p03 | médio | ❌ nenhuma (1 leit.) → respondeu | ❌ nenhuma (1 leit.) → respondeu | ❌ nenhuma (1 leit.) → respondeu | ❌ nenhuma (1 leit.) → respondeu |
| p04 | médio | ❌ nenhuma (1 leit.) → PowerShell | ✅ systematic-debugging → PowerShell | ❌ nenhuma → PowerShell | ❌ nenhuma (1 leit.) → PowerShell |
| p05 | médio | ❌ nenhuma (2 leit.) → PowerShell | ❌ nenhuma (9 leit.) → limite | ❌ nenhuma (2 leit.) → PowerShell | ❌ nenhuma (1 leit.) → PowerShell |
| p06 | médio | ❌ nenhuma (1 leit.) → Bash | ❌ nenhuma (2 leit.) → PowerShell | ❌ nenhuma (1 leit.) → PowerShell | ❌ nenhuma (2 leit.) → Bash |
| p07 | médio | ❌ nenhuma (1 leit.) → Bash | ❌ nenhuma (2 leit.) → PowerShell | ❌ nenhuma (1 leit.) → Bash | ❌ nenhuma (1 leit.) → Bash |
| p08 | médio | ❌ nenhuma → forgia_conversa | ❌ nenhuma → forgia_conversa | ❌ nenhuma → forgia_conversa | ❌ nenhuma → forgia_conversa |
| p09 | médio | ❌ nenhuma (4 leit.) → AskUserQuestion | ❌ nenhuma (4 leit.) → PowerShell | ❌ nenhuma (2 leit.) → PowerShell | ❌ nenhuma (3 leit.) → PowerShell |
| p10 | médio | ❌ nenhuma → PowerShell | ❌ nenhuma → PowerShell | ❌ nenhuma → PowerShell | ❌ nenhuma → PowerShell |
| p11 | baixo | ❌ nenhuma (1 leit.) → respondeu | ❌ nenhuma (2 leit.) → respondeu | ❌ nenhuma (1 leit.) → respondeu | ❌ nenhuma (2 leit.) → respondeu |
| p12 | baixo | ❌ nenhuma (1 leit.) → Bash | ❌ nenhuma (1 leit.) → Bash | ❌ nenhuma (1 leit.) → Bash | ❌ nenhuma (2 leit.) → PowerShell |
| p13 | baixo | ❌ nenhuma (1 leit.) → respondeu | ❌ nenhuma (1 leit.) → respondeu | ❌ nenhuma (1 leit.) → respondeu | ❌ nenhuma (1 leit.) → respondeu |
| p14 | baixo | ❌ nenhuma → windows_list_windows | ❌ nenhuma → windows_list_windows | ❌ nenhuma → windows_list_windows | ❌ nenhuma → windows_list_windows |
| p15 | baixo | ❌ nenhuma (1 leit.) → respondeu | ❌ nenhuma (1 leit.) → respondeu | ❌ nenhuma (1 leit.) → respondeu | ❌ nenhuma (1 leit.) → Bash |
| p16 | nenhuma | ✅ nenhuma → browser_navigate | ✅ nenhuma → browser_navigate | ✅ nenhuma → browser_navigate | ✅ nenhuma → browser_navigate |
| p17 | nenhuma | ✅ nenhuma → PowerShell | ✅ nenhuma → PowerShell | ✅ nenhuma → PowerShell | ✅ nenhuma → PowerShell |
| p18 | nenhuma | ✅ nenhuma → respondeu | ✅ nenhuma → respondeu | ✅ nenhuma → respondeu | ✅ nenhuma → respondeu |
| p19 | nenhuma | ✅ nenhuma → PowerShell | ✅ nenhuma (2 leit.) → PowerShell | ✅ nenhuma (2 leit.) → PowerShell | ✅ nenhuma (5 leit.) → PowerShell |
| p20 | nenhuma | ✅ nenhuma → respondeu | ✅ nenhuma → respondeu | ✅ nenhuma → respondeu | ✅ nenhuma → respondeu |

### Até a 1ª ação (medida principal)

| Grupo | Desligado | Ligado |
|---|---|---|
| Skill esperada, nível médio (p01–p10) | 2/20 | 1/20 |
| Skill esperada, nível baixo (p11–p15) | 0/10 | 0/10 |
| Sem skill (p16–p20) | 10/10 | 10/10 |
| **Total** | **12/40** | **11/40** |

### Estrito (antes da 1ª ferramenta de qualquer tipo)

| Grupo | Desligado | Ligado |
|---|---|---|
| Skill esperada, nível médio (p01–p10) | 1/20 | 0/20 |
| Skill esperada, nível baixo (p11–p15) | 0/10 | 0/10 |
| Sem skill (p16–p20) | 10/10 | 10/10 |
| **Total** | **11/40** | **10/40** |

### Outros números

| | Desligado | Ligado |
|---|---|---|
| Skills carregadas antes da ação (80 execuções) | 2 | 1 |
| Skill errada carregada | 0 | 0 |
| Buscas `skills_buscar`/`skills_listar` | — (ferramenta não existe) | **0** |
| Tamanho médio da 1ª requisição ao modelo | 260 KB | 243 KB (−17 KB, −6,5%) |
| Chamadas ao modelo por execução (média) | 2,1 | 2,0 |
| Execuções repetidas por falha de infraestrutura | 0 | 1 (p03 r1, queda de rede) |

## O que o teste mostra e o que não mostra

- **Nos dois modos, o modelo quase nunca carrega skill antes de agir.** Foram 3 vezes em 80. Ele explora a pasta, pergunta onde está o projeto ou usa direto a ferramenta do domínio: `forgia_conversa` para a peça 3D, `windows_list_windows` para "observar o escritório", o navegador para o AliExpress.
  - Isso já acontecia com o catálogo de hoje e não é efeito do interruptor.
- **Pedidos de nível baixo (p11–p15):** nenhum modo acertou nenhum.
  - Com o desligado, essas skills estavam na listagem, com descrição, e mesmo assim não foram usadas.
  - Com o ligado, o modelo **nunca** chamou `skills_buscar`.
  - Ou seja, o caminho "nome por categoria + busca" não foi exercitado por iniciativa do modelo. Esse caminho só foi verificado por chamada dirigida, na etapa 2 (a busca "botão salvar não faz nada" devolveu `click-path-audit` primeiro).
- **Pedidos sem skill (p16–p20):** os dois modos acertaram tudo. O ligado não fez o modelo carregar skill à toa.
- **Custo:** o ligado manda ~17 KB a menos por requisição (−6,5%), porque as baixas saem da listagem nativa. É o ganho que o recurso promete, mas não compensa a regra: ele não acertou mais.

## Limitações

- **A pasta vazia do sandbox não reproduz o projeto original.** Muitos pedidos falam "desse app" e o modelo gastou a 1ª ação procurando o projeto. Rodar nas pastas reais (agent-code, forgia) seria mais fiel. Não fiz porque a cópia usa as permissões reais do `~/.claude`, e uma ação liberada ali mexeria nos repositórios de verdade.
- **"Até a 1ª ação" depende da lista de comandos só de leitura.** Comando de leitura fora da lista (ex.: `Get-WinEvent`) contou como ação. O critério foi o mesmo nos dois modos.
- **Um modelo, um esforço, 2 rodadas.** Com uma taxa de acerto tão baixa, só uma amostra bem maior separaria os dois modos com segurança.
- **`mcp__forgia` está liberado no `settings.json` real.** Nas 4 execuções do p08, a chamada à Forgia (local) foi disparada antes da parada.
- **Ferramentas do teste ficaram fora do repositório** (driver CDP, proxy, scripts), na pasta temporária. Este relatório é o único arquivo novo.
