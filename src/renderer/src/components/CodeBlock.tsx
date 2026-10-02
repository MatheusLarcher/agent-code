import { useMemo } from 'react'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import python from 'highlight.js/lib/languages/python'
import markdown from 'highlight.js/lib/languages/markdown'
import yaml from 'highlight.js/lib/languages/yaml'
import diff from 'highlight.js/lib/languages/diff'
import powershell from 'highlight.js/lib/languages/powershell'
import csharp from 'highlight.js/lib/languages/csharp'
import sql from 'highlight.js/lib/languages/sql'
// VS Code's "Dark+" palette — so highlighted code reads exactly like the editor.
import 'highlight.js/styles/vs2015.css'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('python', python)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('powershell', powershell)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('sql', sql)

const SUPPORTED = new Set(hljs.listLanguages())

/** Map a file extension (lowercase, no dot) to a highlight.js language. */
export function extToLang(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json',
    html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
    css: 'css', scss: 'css', less: 'css',
    py: 'python',
    md: 'markdown', markdown: 'markdown',
    yml: 'yaml', yaml: 'yaml',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    ps1: 'powershell', psm1: 'powershell',
    cs: 'csharp',
    sql: 'sql'
  }
  return map[ext] || ''
}

/**
 * HTML realçado pelo hljs (o código já sai escapado) na linguagem dada; sem
 * linguagem registrada, a detecção automática. null se o realce falhar — quem
 * chama mostra o texto puro. É o realce único do app: o CodeBlock e o editor do
 * monitor do Escritório 3D (office3d/codeScreen) usam esta lista de linguagens.
 */
export function highlightCode(code: string, language?: string): string | null {
  try {
    if (language && SUPPORTED.has(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value
    }
    return hljs.highlightAuto(code).value
  } catch {
    return null
  }
}

/** A syntax-highlighted code block (VS Code colors). Falls back to plain text
 *  if the language can't be highlighted. */
export function CodeBlock({ code, language }: { code: string; language?: string }): JSX.Element {
  const html = useMemo(() => highlightCode(code, language), [code, language])
  return (
    <pre className="code-block hljs">
      {html != null ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
    </pre>
  )
}
