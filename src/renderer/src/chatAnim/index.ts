/** Animações reutilizáveis do chat: o portão (só o que chegou ao vivo), BlurText e CountUp. */
import './chatAnim.css'

export { AnimGateProvider, prefersReducedMotion, useAnimGate, useFreshOnce, type AnimGate } from './animGate'
export { BlurText } from './BlurText'
export { CountUp } from './CountUp'
export { MAX_WORDS, rehypeBlurWords, type BlurWordsState } from './blurWords'
