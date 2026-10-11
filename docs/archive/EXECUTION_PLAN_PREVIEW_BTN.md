# EXECUTION_PLAN — Botão de Preview para Arquivos Criados

## Prompt Original
> Quando o agent code criar um md ou arquivo parecido no meio do processo, colocar um botão ao lado dele para abrir um preview como se fosse uma nova aba (Visualizador de arquivo)

## Contexto / Decisões
- Atualmente, o componente `ToolCard` (`MessageList.tsx`) mostra ferramentas executadas. Para a ferramenta `Write`, já exibimos um botão "⬇️ Baixar" se o arquivo gerado tiver uma extensão de "deliverable" (`DOWNLOADABLE_EXTS`).
- O usuário deseja um botão novo: "👁️ Preview" (ou similar) que, ao ser clicado, vai abrir uma nova aba "Web" no painel embutido, mas acessando a URL local do arquivo (`file:///...`).
- O sistema de abas já suporta navegação por URL, mas a chamada IPC `browserNewTab` (e o respectivo wrapper `window.api.newTab`) não suportavam o repasse da URL (apenas o `kind` da aba).
- A solução aborda tanto a inclusão do botão na UI (`MessageList.tsx`) quanto a passagem de URL para a criação da aba de preview via IPC.
- Observação técnica: Para arquivos markdown (`.md`), o Chrome (Playwright) vai carregar e exibir o conteúdo cru (raw text) do arquivo ao navegar para a URL, o que deve ser suficiente para inspecionar o arquivo criado.

## Tarefas
- [x] **T1 — Modificar IPC no Frontend**:
  - Em `src/shared/ipc.ts`: Atualizar a interface ou documentação de `browserNewTab` (se aplicável, embora as definições de canais não tipem argumentos extras, a função no preload sim).
  - Em `src/preload/index.ts`: Modificar `newTab: (kind?: TabKind, url?: string) => ipcRenderer.invoke(Channels.browserNewTab, kind, url)`.
- [x] **T2 — Modificar IPC no Backend**:
  - Em `src/main/index.ts`: Atualizar o handler `ipcMain.handle(Channels.browserNewTab)` para receber o segundo parâmetro `url` e passá-lo para `getBrowser(activeConvId).newTab(kind ?? 'web', url)`.
- [x] **T3 — Atualizar ToolCard na Interface**:
  - Em `src/renderer/src/components/MessageList.tsx`: Em `ToolCard`, recuperar o caminho absoluto do arquivo para o comando `Write`, independentemente de ser um download válido (semelhante ao que é feito para `filePath`, mas aplicável a arquivos de texto/md).
  - Renderizar o botão de ação rápida "👁️ Preview" (ou apenas "Preview") ao lado (ou no lugar) da área onde o botão "Baixar" aparece.
  - Implementar a ação do botão para chamar `window.api.newTab('web', 'file:///' + absolutePath.replace(/\\/g, '/'))` (com sanitização de barras se necessário) e notificar ou lidar com erros.
- [x] **T4 — Validação via Terminal**:
  - Executar `npm run typecheck` para garantir que as assinaturas do TypeScript estão corretas nas camadas IPC.
  - Validar com testes e apontar testes manuais necessários.
