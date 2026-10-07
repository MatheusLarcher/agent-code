/**
 * Material do avatar GLB, um por agente (clone do material do modelo: as
 * texturas são as mesmas e o programa do shader também). Duas mudanças no
 * shader do MeshStandardMaterial, por onBeforeCompile:
 *
 * - Tingimento: o canal R da textura de metal/rugosidade (o glTF não usa;
 *   G = rugosidade, B = metal) é a máscara da roupa principal, gravada pelo
 *   pipeline (scripts/office-agents). Nos texels marcados a cor vira a do
 *   agente (a do projeto, agentBody.setShirtColor; a Central, `seedColor`) vezes o brilho relativo do texel
 *   (luma ÷ luma média da roupa): o tricô, as dobras e as sombras pintadas
 *   continuam. https://rohinknight.com/posts/Color-Swapping-ThreeJS/
 * - Brilho limitado: rugosidade mínima e quase nada de metal (a calça não vira
 *   couro).
 *
 * O ambiente do PBR vem por material (`envMap`), não por `scene.environment`:
 * o resto do escritório não muda.
 */
import type { Color, MeshStandardMaterial, Texture } from 'three'

/** Rugosidade mínima e metal máximo (o PBR do modelo sem a cara de couro/plástico). */
export const MIN_ROUGHNESS = 0.6
export const MAX_METALNESS = 0.08
/**
 * Força do ambiente (RoomEnvironment) nos agentes: só um respiro nas sombras. As luzes da sala já
 * iluminam o modelo como iluminam o boneco; com 0,55 o ambiente somava por cima e o agente saía leitoso.
 */
export const ENV_INTENSITY = 0.1
/** Luma média (linear) da roupa quando o modelo não traz `tintMeanLuma` nos extras do material. */
const DEFAULT_LUMA = 0.12

export interface TintUniforms {
  tintColor: { value: Color }
  tintLuma: { value: number }
}

const DECL = 'uniform vec3 tintColor;\nuniform float tintLuma;\n'

const TINT = `#include <map_fragment>
#ifdef USE_ROUGHNESSMAP
  float tintMask = smoothstep( 0.35, 0.65, texture2D( roughnessMap, vRoughnessMapUv ).r );
  float tintL = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  vec3 tinted = tintColor * clamp( tintL / max( tintLuma, 1e-3 ), 0.0, 2.5 );
  diffuseColor.rgb = mix( diffuseColor.rgb, tinted, tintMask );
#endif`

/** Patch do fragment shader (puro: string → string; testável). */
export function patchTintShader(fragment: string): string {
  return DECL + fragment
    .replace('#include <map_fragment>', TINT)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = max( roughnessFactor, ${MIN_ROUGHNESS.toFixed(3)} );`)
    .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\nmetalnessFactor = min( metalnessFactor, ${MAX_METALNESS.toFixed(3)} );`)
}

/** O material do agente: clone do modelo, cor da roupa `color` (linear), ambiente `env` (ou nenhum). */
export function agentMaterial(base: MeshStandardMaterial, color: Color, env: Texture | null): MeshStandardMaterial {
  const m = base.clone()
  const luma = Number(base.userData.tintMeanLuma)
  const u: TintUniforms = { tintColor: { value: color.clone() }, tintLuma: { value: Number.isFinite(luma) && luma > 0 ? luma : DEFAULT_LUMA } }
  m.userData.tint = u
  m.envMap = env
  m.envMapIntensity = ENV_INTENSITY
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u)
    shader.fragmentShader = patchTintShader(shader.fragmentShader)
  }
  // Todos os agentes no mesmo programa (os uniforms são de cada material).
  m.customProgramCacheKey = () => 'agent-tint-v1'
  return m
}
