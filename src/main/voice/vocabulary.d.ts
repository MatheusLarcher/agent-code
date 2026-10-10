// Texto embutido no bundle pelo Vite (hotwords.ts importa o vocabulário de reforço).
declare module '*.txt?raw' {
  const text: string
  export default text
}
