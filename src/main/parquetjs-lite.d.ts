declare module 'parquetjs-lite' {
  class ParquetSchema {
    constructor(schema: Record<string, unknown>)
  }
  class ParquetWriter {
    static openFile(schema: ParquetSchema, path: string): Promise<ParquetWriter>
    appendRow(row: object): Promise<void>
    close(): Promise<void>
  }
  class ParquetReader {
    static openFile(path: string): Promise<ParquetReader>
    getCursor(): { next(): Promise<Record<string, unknown> | null> }
    close(): Promise<void>
  }

  const parquet: {
    ParquetSchema: typeof ParquetSchema
    ParquetWriter: typeof ParquetWriter
    ParquetReader: typeof ParquetReader
  }

  export default parquet
}
