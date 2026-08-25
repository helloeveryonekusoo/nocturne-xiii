export type CardCounts = Record<number, number>;

export interface SavedPreset {
  id: string;
  name: string;
  counts: CardCounts;
}

export const STARTER_COUNTS: CardCounts = Object.fromEntries(
  Array.from({ length: 13 }, (_, index) => [index + 1, index < 8 ? 2 : 1]),
);

const STORAGE_KEY = 'nocturne-xiii-presets-v1';

export function readPresets(): SavedPreset[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as SavedPreset[];
  } catch {
    return [];
  }
}

export function writePresets(presets: SavedPreset[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

export function validateCounts(counts: CardCounts, playerCount: number) {
  const total = Object.values(counts).reduce((sum, value) => sum + Math.max(0, Math.floor(value)), 0);
  if (total < playerCount + 2) return `${playerCount}人で遊ぶにはカードが${playerCount + 2}枚以上必要です。`;
  if (Object.values(counts).some((value) => value < 0 || !Number.isInteger(value))) return '枚数は0以上の整数にしてください。';
  return '';
}

export function exportPreset(preset: SavedPreset) {
  const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${preset.name || 'nocturne-preset'}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
