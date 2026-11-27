# Agent Code Homol — o que foi feito neste fork

Versão: **0.1.195** (27/11/2026). Base: snapshot do repositório original na **0.1.191** (commit `2d12c35`).
Este documento resume, para quem mantém o repositório original, o que esta branch traz de diferente e como
experimentar. Decisões internas, planos de implementação e a arquitetura nova de memórias (ainda em validação)
ficam fora desta branch.

## Como experimentar sem mexer no Agent Code instalado

A branch gera uma segunda instalação, a **Agent Code Homol**, que convive com o Agent Code original:

- `npm run package:homol` → `dist/AgentCode-Homol-setup.exe` (o `package:win` e o build original não mudam).
- Nome, atalho, pasta de instalação, dados (`%APPDATA%\agent-code-homol`, `Documentos\agent-code-homol`),
  banco (porta 45442), ponte do celular, extensão do Chrome e AVD do Android **próprios**. As duas abrem juntas.
- O que continua compartilhado: o login do Claude e as transcrições em `~\.claude`.
- Detalhes: `docs/HOMOL.md`. Na Homol a atualização é **manual** (o "Verificar atualização" diz de onde baixar,
  sem consultar o feed — o repositório do fork é privado e o feed responderia 404).
- O app se apresenta como **"Agent Code Homol"** (barra lateral e título da janela).

### Trazer as conversas do Agent Code original
- **Configurações › Dados › Importar conversas do Agent Code:** lista as conversas do app original deste computador
  (lidas numa **cópia** do banco, num Postgres temporário: o original não é tocado e pode ficar aberto); você marca
  e elas entram ao lado das da Homol, sem duplicar.
- **Automático** (ligado por padrão, a cada 30 min): conversas novas entram; as que mudaram no original são
  atualizadas só se não foram mexidas na Homol (senão, conflito e a da Homol fica); apagadas na Homol não voltam.
  As **memórias que essas conversas usaram** vêm junto: iguais ou quase iguais são puladas, mesmo caminho com texto
  diferente não é sobrescrito, as novas entram marcadas `origem: importada do Agent Code`. Relatório em
  `%APPDATA%\agent-code-homol\importacao\`.
- Como o histórico que o Claude usa para retomar fica em `~\.claude` (compartilhado), a conversa importada continua
  de onde parou.

## O que mudou, por área

### Custo e velocidade
- **Ajudantes enxutos** (PO, memorista, vigia, título, curador): rodavam com o ambiente inteiro do Claude Code
  (~53 mil tokens cada). Agora 4–10 mil. "oi": 219 mil → 72 mil tokens no total.
- **Ferramentas sob demanda:** engenharia reversa (~170 ferramentas), Android (12) e Chrome só entram na conversa
  quando o pedido precisa; o agente liga sozinho (`app_ativar_engenharia_reversa`, `app_ativar_android`…).
  Em projeto Android, o Android já nasce ligado.
- **Catálogo de skills uma vez só** por conversa (~9,3 mil → ~0,1 mil tokens) e instruções fixas 27% menores.
- **Escolha de memórias** pelo Sonnet 5.5, em paralelo com a preparação do envio; teto de memórias por turno.
- **Início da resposta:** 1º texto 17,4 s → 7,2 s no Windows (mesma bateria, 3 repetições).

### Memórias
- **Memorista novo:** antes de gravar, vê as ~10 memórias **mais parecidas** com o turno (antes via só as 40
  primeiras do índice) e a lista de temas; **complementa** a memória do mesmo assunto em vez de criar outra.
  Grava no cabeçalho tema, datas, importância, "gatilhos" (jeitos de o usuário pedir aquilo) e termos;
  o corpo segue completo. No uso real: 12 criadas / 13 complementadas (o anterior: 29 / 6).
- **Bibliotecário** (novo): de hora em hora, fora da conversa, põe memórias soltas no tema certo, junta as
  quase idênticas (aposenta, nunca apaga) e completa datas e gatilhos das antigas. Começa **só mostrando o que
  faria** (relatório em `%APPDATA%\<app>\bibliotecario\`); "Organizar de verdade" em Configurações › Memorista.
- **Memória "sempre":** marcada com `sempre: true` vai em toda conversa, uma vez.
- **Cofre com frase-senha:** com o banco na nuvem, os segredos só vão cifrados por uma frase do usuário.

### Uso no dia a dia
- **Aba Preview** no painel da direita (Yann): sites, markdown, planilhas, PowerPoint, JSON e código sem sair do
  app; botão Selecionar (aponta um trecho e manda para a mensagem) e arrastar arquivo.
- **Primeiros passos** na conversa vazia: conta e modelo, memórias, pasta de dados (OneDrive), ajudantes e voz —
  cada passo abre a aba certa das Configurações — e o 1º pedido com exemplos. "Já sei usar, pular".
- **Permissões seguidas** não somem mais (fila por conversa): a 2ª ficava escondida e o agente esperava minutos.
- **Pedido vago:** o agente pergunta antes de editar.
- **Lembrete do plano:** a 1ª edição sem plano passa, com o pedido no resultado, em vez de ser recusada.
- **Tela no limite de uso:** mostra só o cartão da espera, sem "trabalhando".
- **Botão de atualização** pisca quando há versão pronta.
- **Cartões do Quadro que esperam você:** o "Pode fazer" (ou o campo de resposta) aparece também no detalhe do
  cartão — antes, ao abrir, só havia "Dispensar cartão".
- Aviso de hook quebrado, comando de administrador com uma confirmação do Windows, "anexar print" mais tolerante,
  resposta do usuário sem cara de erro, tarefas dos agentes no Quadro, quadro de energia com "sem leitura".
- **Mac:** porte (Postgres, pastas, contas com login no Chaveiro, instalador `.dmg` sem assinatura).

## Medições no uso real (27/11, Windows — principal 0.1.185 × Homol)

| | Principal | Homol |
|---|---:|---:|
| Tokens dos ajudantes por pedido | 137 mil | 18 mil (−87%) |
| Idas ao modelo por pedido | 22 | 12,3 (−44%) |
| Contexto inicial (mediana) | 80 mil | 63 mil (−21%) |
| Resumos de contexto no meio da conversa | 72 | 3 |
| Falhas de hook | 256 | 0 |
| Tempo por pedido (mediana) | 51 s | 118 s* |

\* Ainda não comparável: a Homol foi usada em trabalho de tela (navegador e capturas) e o principal em análise e
código. Com ~47 pedidos na Homol, os números são indicativos.

## Ferramentas de medição incluídas
- `scripts/bateria/`: bateria de tarefas fixas no app real (instância isolada), com placar e repetições.
- `scripts/bateria/fumaca-memorias.mjs` e `fumaca-preview.mjs`: testes de fumaça do memorista/bibliotecário e do Preview.
- `scripts/analise-conversas/`: análise só-leitura das conversas reais e comparativo diário entre dois apps.
- `scripts/banco/principal-para-homol.ts`: leva o banco do app principal (cópia, só leitura) como backup que a
  Homol restaura em Configurações › Dados › Backups.

## Como validar
- `npm run typecheck` e `npx vitest run` (a suíte completa é pesada; `--maxWorkers=2` em máquina com pouca RAM).
- `npm run package:homol` e instalar o `AgentCode-Homol-setup.exe` ao lado do Agent Code.

## Fora desta branch (de propósito)
- A arquitetura nova de escolha de memórias (busca por grafo + IA de retaguarda): o código de medição existe, mas
  **não está ligado no app** e ainda não passou nas validações.
- Documentos de decisões, planos de implementação e especificações internas.
