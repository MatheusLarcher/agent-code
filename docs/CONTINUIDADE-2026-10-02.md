# Continuidade — Central e Escritório 3D (02/10/2026)

Registro versionado para retomar o trabalho sem depender de `.superpowers/sdd/2026-10-02-02/` (ignorada pelo Git), de planejamento externo nem de conversas privadas. Distingue três camadas: **histórico** (o que foi o checkpoint parcial), **entregue e aprovado** (o que a continuação concluiu) e **pendente**. Funcionamento atual em [ARQUITETURA.md](ARQUITETURA.md#central--conversa-fixa-que-roteia-pedidos) e [REFERENCIA.md](REFERENCIA.md).

## Bases de código

- `d76572f` — checkpoint aprovado antes da continuação (casca da Central, índice, funções puras, monitor/seleção de mesa).
- `114c85e` — WIP enviado depois (despacho, merge entre PCs e editor do monitor em andamento); **não** era aceite.
- Continuação atual — **nada commitado após `114c85e`**: todo o trabalho abaixo está na árvore de trabalho da branch `checkpoint/2026-10-02-central-escritorio`.

## Entregue e aprovado (continuação)

Aprovações são vereditos do crítico no ledger, não deste documento.

- **T1/T1b/T2/T4 e monitor/seleção de mesa** — concluídos antes (conversa fixa `central`, índice com cache SWR, funções puras de cor/atividade/espelho, chat do monitor e seleção por `convId`).
- **T3 — decisor TypeSafe/IPC:** aprovado após correção do mascaramento. Resíduo: o mascaramento pode mascarar a mais e não garante remoção de segredos.
- **T5 — despacho, âncora/id preset, espelho, "não era aqui", adoção A1:** entregue e revisado; a rodada de correção tratou os pontos Important da primeira revisão. Limitação aceita abaixo (identidade de turno).
- **Merge entre PCs (MPC):** aprovado (0 Critical/0 Important, 7 Minor). Dono por device e mescla de `central.entries` por id em `centralMerge.ts`/`centralMergeStorage.ts`, substituindo o reaplicar do payload local inteiro.
- **T6 — tela v3** (pedido/aviso, blocos, linha de ações expansível, perguntas/permissões do destino, trilho, cores sem laranja, `← Central`, reuso no chat flutuante) e a fiação no App.
- **T7 + T7b — celular:** snapshot `RemoteConversation.central` em `/api/state`, `POST /api/central-choose` (401/409/400/200), UI do telefone, cartões de outro PC (`foreign`) sem ação, `self` para posse. Aprovados; APK não gerado.
- **Editor no monitor 3D + stream:** editor estilo VS Code com dados reais (abas, explorer, diff honesto conferido no disco, alternância Código | Chat), e `toolInputStream.ts` emitindo `filePath`/`oldText` só quando a string fechou. Aprovados; a leitura de disco é restrita no renderer e **não é fronteira de segurança**.

### Validação integrada — rodada final do supervisor sobre a árvore atual

`npm run typecheck`: exit 0 (node + web). `npm test -- --maxWorkers=2`: **424 arquivos / 5024 testes passaram; 10 arquivos / 67 testes ignorados**. `npm run build`: **exit 0** (inclui o binário .NET). `node --check` em `smartfone-remote/www/app.js`, `central.js` e `centralTurns.js`: ok. Isso prova que a árvore compila, testa e empacota; **não** mede a qualidade do roteamento. Rodadas anteriores (397/4734, 417/4939 etc.) eram diagnósticos da árvore em edição e não valem como verificação final; falhas pontuais vistas só sob carga com agentes em paralelo (`App.test.tsx`, `projectScope.test.ts`) não ocorreram na rodada final sem concorrência.

## O que falta

- **Calibração fase B — aguarda confirmação do usuário.** A fase A (harness fora do Electron, só leitura do export Parquet, sem DB real) gerou as candidatas e **parou**; a lista fica em arquivos de trabalho fora do Git (`calibration-candidates*`). Só após o usuário confirmar a lista roda a fase B (regras, tarefa→avulsa→volta, inglês × português, pisos 0,50–0,90; meta ≥95% por regra e ≤20% de perguntas). **Enquanto isso, piso 0,6 e instruções em inglês são defaults NÃO calibrados**; nenhuma precisão medida pode ser alegada, nem produto "concluído". Não confundir com o piso 0,20 do modo Automático.
- **Identidade de turno no main (limitação conhecida):** sem ela, em 3 casos de terminal tardio do turno parado o turno **seguinte** pode ser marcado como falho — nunca engolido em silêncio. Correção estrutural pendente.
- **Minors para triagem** (listas completas no workspace SDD, fora do Git). Os que tocam o usuário: eco de escrita no outro PC a cada gravação remota; entrada de tipo novo (build mais novo) tratada como apagada; teto de 400 entradas pode cortar pedido "perguntando" após ~200 turnos com A1; envio falho à Central pode apagar o texto no celular (`err.status` 0); `app.js` depende de `central.js` carregar; sem teste versionado de `central.js`/`centralTurns.js`; editor: arquivo de ~6000 linhas trava 116–235 ms na primeira abertura, pastas `secrets/`/`credentials/` fora do guard, rolagem/seguir; `storage.ts`, `remoteServer.ts`, `ipc.ts`, `app.js` acima de 500 linhas.
- **Nada commitado após `114c85e`:** commit/push só por decisão do usuário, depois da triagem.
