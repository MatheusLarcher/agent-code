// Prints the real inputs/outputs (name, element type, shape) of the Parakeet
// ONNX files, read straight from the protobuf graph — what parakeet.ts feeds
// must match this, not a guess. Downloads nothing: run the engine once (or
// scripts/voice/e2e.mjs) so the files are in the cache.
//   node scripts/voice/probe-parakeet.mjs [--cache <dir>]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { arg, defaultCache } from './lib.mjs'

const dir = join(arg('cache', defaultCache), 'istupakov', 'parakeet-tdt-0.6b-v3-onnx')
const ELEM = { 1: 'float32', 6: 'int32', 7: 'int64', 9: 'bool', 10: 'float16' }

function varint(buf, pos) {
  let v = 0n
  let shift = 0n
  for (;;) {
    const b = buf[pos++]
    v |= BigInt(b & 0x7f) << shift
    if (!(b & 0x80)) return [v, pos]
    shift += 7n
  }
}

/** Top-level fields of one protobuf message: [{ field, wire, value | bytes }]. */
function fields(buf, start = 0, end = buf.length) {
  const out = []
  let pos = start
  while (pos < end) {
    let key
    ;[key, pos] = varint(buf, pos)
    const field = Number(key >> 3n)
    const wire = Number(key & 7n)
    if (wire === 0) {
      let v
      ;[v, pos] = varint(buf, pos)
      out.push({ field, value: v })
    } else if (wire === 2) {
      let len
      ;[len, pos] = varint(buf, pos)
      const s = pos
      pos += Number(len)
      out.push({ field, start: s, end: pos })
    } else if (wire === 1) pos += 8
    else if (wire === 5) pos += 4
    else throw new Error(`wire type ${wire}`)
  }
  return out
}

const str = (buf, f) => buf.toString('utf8', f.start, f.end)

function valueInfo(buf, f) {
  const parts = fields(buf, f.start, f.end)
  const name = str(buf, parts.find((p) => p.field === 1))
  const type = parts.find((p) => p.field === 2)
  const tensor = type && fields(buf, type.start, type.end).find((p) => p.field === 1)
  if (!tensor) return `${name}: (não-tensor)`
  const tf = fields(buf, tensor.start, tensor.end)
  const elem = tf.find((p) => p.field === 1)?.value
  const shape = tf.find((p) => p.field === 2)
  const dims = shape
    ? fields(buf, shape.start, shape.end)
        .filter((p) => p.field === 1)
        .map((d) => {
          const df = fields(buf, d.start, d.end)[0]
          return df ? (df.field === 1 ? String(df.value) : str(buf, df)) : '?'
        })
    : []
  return `${name}: ${ELEM[Number(elem)] ?? elem} [${dims.join(', ')}]`
}

for (const file of ['nemo128.onnx', 'encoder-model.int8.onnx', 'decoder_joint-model.int8.onnx']) {
  const buf = readFileSync(join(dir, file))
  const graph = fields(buf).find((p) => p.field === 7)
  const g = fields(buf, graph.start, graph.end)
  console.log(`\n${file}`)
  for (const p of g.filter((p) => p.field === 11)) console.log('  in ', valueInfo(buf, p))
  for (const p of g.filter((p) => p.field === 12)) console.log('  out', valueInfo(buf, p))
}
