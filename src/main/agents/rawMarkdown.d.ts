// Texto embutido no bundle pelo Vite (agentRules.ts importa resources/agent.md).
declare module '*.md?raw' {
  const text: string
  export default text
}
