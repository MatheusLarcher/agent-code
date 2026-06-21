// Catalog of Android device presets for the preview frame. Each model's portrait
// screen resolution (px) + density is applied to the emulator (adb wm size/density)
// so the preview shows that device's real screen size, wrapped in a bezel.
// Shared between the renderer (selector + frame) and main (applying the size).

export type DeviceType = 'phone' | 'tablet'

export interface AndroidDeviceModel {
  id: string
  name: string
  type: DeviceType
  /** Portrait screen size in physical pixels. */
  width: number
  height: number
  /** Screen density (dpi) — applied with `wm density`. */
  dpi: number
  /** Release year — used to keep the most recent model when two share a resolution. */
  year: number
}

// Full catalog (may contain several devices with the same resolution). The visible
// list (DEVICE_OPTIONS) is deduplicated by resolution; `findDevice` still resolves
// any id so the agent can reference a specific model.
export const ANDROID_DEVICES: AndroidDeviceModel[] = [
  // ----- phones -----
  { id: 's26-ultra', name: 'Galaxy S26 Ultra', type: 'phone', width: 1440, height: 3120, dpi: 505, year: 2026 },
  { id: 's24-ultra', name: 'Galaxy S24 Ultra', type: 'phone', width: 1440, height: 3120, dpi: 501, year: 2024 },
  { id: 'oneplus-12', name: 'OnePlus 12', type: 'phone', width: 1440, height: 3168, dpi: 510, year: 2024 },
  { id: 'pixel-8-pro', name: 'Pixel 8 Pro', type: 'phone', width: 1344, height: 2992, dpi: 489, year: 2023 },
  { id: 's24', name: 'Galaxy S24', type: 'phone', width: 1080, height: 2340, dpi: 416, year: 2024 },
  { id: 'a55', name: 'Galaxy A55', type: 'phone', width: 1080, height: 2340, dpi: 390, year: 2024 },
  { id: 'redmi-note-13', name: 'Redmi Note 13', type: 'phone', width: 1080, height: 2400, dpi: 395, year: 2024 },
  { id: 'pixel-8', name: 'Pixel 8', type: 'phone', width: 1080, height: 2400, dpi: 428, year: 2023 },
  { id: 'moto-g84', name: 'Moto G84', type: 'phone', width: 1080, height: 2400, dpi: 393, year: 2023 },
  // ----- tablets -----
  { id: 'tab-s9', name: 'Galaxy Tab S9', type: 'tablet', width: 1600, height: 2560, dpi: 274, year: 2023 },
  { id: 'pixel-tablet', name: 'Pixel Tablet', type: 'tablet', width: 1600, height: 2560, dpi: 276, year: 2023 },
  { id: 'tab-a9-plus', name: 'Galaxy Tab A9+', type: 'tablet', width: 1200, height: 1920, dpi: 206, year: 2023 },
  { id: 'lenovo-p11', name: 'Lenovo Tab P11', type: 'tablet', width: 1200, height: 2000, dpi: 220, year: 2022 }
]

export const DEFAULT_DEVICE_ID = 's26-ultra'

/** One device per resolution — the most recent (highest year; ties keep the first
 *  listed). Preserves the order in which each resolution first appears. */
export function uniqueByResolution(list: AndroidDeviceModel[]): AndroidDeviceModel[] {
  const best = new Map<string, AndroidDeviceModel>()
  const order: string[] = []
  for (const d of list) {
    const key = `${d.width}x${d.height}`
    const cur = best.get(key)
    if (!cur) {
      best.set(key, d)
      order.push(key)
    } else if (d.year > cur.year) {
      best.set(key, d)
    }
  }
  return order.map((k) => best.get(k)!)
}

/** Deduplicated list shown in the UI selector and the agent's model list. */
export const DEVICE_OPTIONS: AndroidDeviceModel[] = uniqueByResolution(ANDROID_DEVICES)

export function findDevice(id: string): AndroidDeviceModel | undefined {
  return ANDROID_DEVICES.find((d) => d.id === id)
}

/** The visible model whose resolution matches w×h (for syncing the selector). */
export function deviceForResolution(width: number, height: number): AndroidDeviceModel | undefined {
  return DEVICE_OPTIONS.find((d) => d.width === width && d.height === height)
}
