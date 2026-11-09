// Skins. Plum & Gold is the default; Classic Navy is the palette it replaced.
//
// The colours live in index.css, per data-theme. This only decides which one is
// on. The choice is saved with the person's settings, and copied to localStorage
// because /skin-boot.js has to apply it before first paint, before any request
// could answer.
import { api } from './api';

export const SKINS = [
  { id: 'plum-gold', name: 'Plum & Gold', themeColor: '#1B0F20' },
  { id: 'classic-navy', name: 'Classic Navy', themeColor: '#0B111E' },
] as const;

export type SkinId = (typeof SKINS)[number]['id'];

export const DEFAULT_SKIN: SkinId = 'plum-gold';
const STORAGE_KEY = 'josi.skin';

export function isSkin(value: unknown): value is SkinId {
  return SKINS.some(skin => skin.id === value);
}

export function currentSkin(): SkinId {
  const applied = document.documentElement.getAttribute('data-theme');
  return isSkin(applied) ? applied : DEFAULT_SKIN;
}

export function applySkin(id: SkinId): void {
  document.documentElement.setAttribute('data-theme', id);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', SKINS.find(skin => skin.id === id)!.themeColor);
  // Private windows and blocked storage throw. The skin still applies for now.
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* nothing to keep it in */ }
}

/** The person's saved skin wins over this browser's copy of it. */
export async function syncSkin(): Promise<void> {
  const result = await api.get<{ settings?: { skin?: string | null } }>('/persona/settings').catch(() => null);
  const saved = result?.settings?.skin;
  if (isSkin(saved) && saved !== currentSkin()) applySkin(saved);
}

export async function saveSkin(id: SkinId): Promise<void> {
  applySkin(id);
  await api.put('/persona/settings', { skin: id });
}
