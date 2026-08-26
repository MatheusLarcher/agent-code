# Interop CommonJS do exportador Parquet

## Problema

`parquetjs-lite@0.8.7` publica apenas CommonJS, mas `conversationParquet.ts`
importa classes como exports ESM nomeados. O `electron-vite` mantém dependências
externas no bundle do processo main; por isso o build termina, mas o Electron
lança `Named export 'ParquetSchema' not found` durante o carregamento.

## Solução

Importar o namespace CommonJS pelo export default e desestruturar
`ParquetSchema`, `ParquetWriter` e `ParquetReader` nos consumidores. A declaração
local de tipos deve representar o mesmo export default. Não alterar a política
global de externalização nem empacotar a biblioteca.

## Validação

- typecheck;
- teste focado de escrita e leitura do Parquet;
- build;
- inicialização real do Electron, confirmando que o processo main permanece vivo
  e a janela responde.
