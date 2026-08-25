declare module 'parquetjs-lite' {
  export class ParquetSchema {
    constructor(schema: Record<string, unknown>)
  }
  export class ParquetWriter {
    static openFile(schema: ParquetSchema, path: string): Promise<ParquetWriter>
    appendRow(row: object): Promise<void>
    close(): Promise<void>
  }
  export class ParquetReader {
    static openFile(path: string): Promise<ParquetReader>
    getCursor(): { next(): Promise<Record<string, unknown> | null> }
    close(): Promise<void>
  }
}
