# Migração PostgreSQL com parada segura e reinício

## Objetivo

Tornar a troca entre SQLite e PostgreSQL uma transição de processo completa. A migração não deve coexistir com agents ativos nem deixar leases da instalação anterior bloqueando o autosave.

## Fluxo

1. Ao solicitar a migração, o processo principal verifica se há sessões de agent abertas.
2. Se houver, uma confirmação nativa informa quantos agents serão interrompidos. Cancelar não altera o backend.
3. Após a confirmação, as sessões são encerradas, seus leases são liberados e o renderer descarrega as gravações pendentes.
4. A origem é copiada e verificada no destino antes de o backend autoritativo ser confirmado.
5. O Electron agenda o próprio relançamento e encerra o processo atual pelo fluxo normal de flush e fechamento.
6. Na abertura seguinte, a instalação invalida leases antigos pertencentes a ela. Uma trava de instância única impede dois processos principais da mesma instalação de escreverem ao mesmo tempo.

## Falhas e segurança

- O cancelamento do usuário não inicia a transição.
- Falha antes da confirmação do novo backend mantém a origem ativa.
- Leases de outras instalações nunca são removidos automaticamente.
- O relançamento só acontece após uma migração confirmada.
- Um script PowerShell em `scripts/start-agent-code.ps1` oferece inicialização consistente fora do Electron e reutiliza o `start.bat` existente.

## Validação

- Testes direcionados de leases e persistência PostgreSQL.
- Testes do renderer e contratos IPC afetados.
- Typecheck, suíte completa, build Electron/.NET e `git diff --check`.
- Inicialização real do aplicativo e confirmação de que apenas uma instância principal permanece ativa.
