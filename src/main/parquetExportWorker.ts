import { parentPort } from 'node:worker_threads'
import { exportConversationsParquet } from './conversationParquet'
import type { ParquetExportRequest } from './parquetExport'

/**
 * O export diário em parquet fora do thread principal (ver parquetExport.ts): a
 * codificação de dezenas de MB de conversa travava o main. Um pedido por worker;
 * quem o criou o termina quando o app fecha.
 */
parentPort?.once('message', (request: ParquetExportRequest) => {
  exportConversationsParquet(request.cacheDir, request.conversations, request.memoryDir, request.source, new Date(request.now))
    .then((path) => parentPort?.postMessage({ ok: true, path }))
    .catch((error: unknown) => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }))
})
