/**
 * Resumo de testes no fim de uma saída de Bash/PowerShell (vitest, jest,
 * pytest, go test) — PURO. O evento `test-result` de events.ts usa isto.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
/** vitest: "      Tests  1 failed | 38 passed (39)". */
const VITEST = /^[ \t]*Tests[ \t]{2,}(.+?)[ \t]*\(\d+\)[ \t]*$/gm
/** jest: "Tests:       1 failed, 23 passed, 24 total". */
const JEST = /^[ \t]*Tests:[ \t]+(.+)$/gm
/** pytest: "==== 1 failed, 17 passed, 2 warnings in 0.91s ====" (ou sem os "=", no -q). */
const PYTEST = /^[= \t]*((?:\d+ [a-z]+, )*\d+ [a-z]+) in [\d.]+s\b/gm
/** go test -v: "--- PASS: TestX"; sem -v, as linhas de pacote "ok"/"FAIL". */
const GO_CASE = /^[ \t]*--- (PASS|FAIL):/gm
const GO_OK = /^ok[ \t]+\S+[ \t]+(?:\(cached\)|[\d.]+s)/gm
const GO_FAIL = /^FAIL[ \t]+\S+[ \t]+(?:[\d.]+s|\[build failed\]|\[setup failed\])/gm

const lastMatch = (re: RegExp, text: string): string | null => [...text.matchAll(re)].pop()?.[1] ?? null
const num = (re: RegExp, s: string): number => Number(re.exec(s)?.[1] ?? 0)
const counts = (line: string | null): { passed: number; failed: number } | null =>
  line !== null && /\d+ (passed|failed)/.test(line) ? { passed: num(/(\d+) passed/, line), failed: num(/(\d+) failed/, line) } : null

/** Resumo de vitest, jest, pytest ou go test no fim de uma saída; null sem resumo. */
export function parseTestSummary(output: string): { passed: number; failed: number } | null {
  const text = output.slice(-20_000).replace(ANSI, '')
  const hit = counts(lastMatch(VITEST, text)) ?? counts(lastMatch(JEST, text))
  if (hit) return hit
  const py = lastMatch(PYTEST, text)
  // pytest: erro de coleta/fixture conta como falha.
  if (py && /\d+ (passed|failed|errors?)\b/.test(py)) return { passed: num(/(\d+) passed/, py), failed: num(/(\d+) failed/, py) + num(/(\d+) errors?\b/, py) }
  const cases = [...text.matchAll(GO_CASE)].map((m) => m[1])
  if (cases.length > 0) return { passed: cases.filter((c) => c === 'PASS').length, failed: cases.filter((c) => c === 'FAIL').length }
  const [ok, fail] = [GO_OK, GO_FAIL].map((re) => [...text.matchAll(re)].length)
  return ok + fail > 0 ? { passed: ok, failed: fail } : null
}
