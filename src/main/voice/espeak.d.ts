// @echogarden/espeak-ng-emscripten ships no typings; phonemize.ts narrows the
// module shape it actually uses.
declare module '@echogarden/espeak-ng-emscripten' {
  const createModule: () => Promise<unknown>
  export default createModule
}
