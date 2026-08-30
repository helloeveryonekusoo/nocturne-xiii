export type CardCounts = Record<number, number>;

export interface SavedPreset {
  id: string;
  name: string;
  counts: CardCounts;
}

export const CARD_RANKS = [...Array.from({ length: 13 }, (_, index) => index + 1), 0];

export const STARTER_COUNTS: CardCounts = {
  ...Object.fromEntries(Array.from({ length: 13 }, (_, index) => [index + 1, index < 8 ? 2 : 1])),
  0: 1,
};

const STORAGE_KEY = 'nocturne-xiii-presets-v1';

export function readPresets(): SavedPreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const presets = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as SavedPreset[];
    return presets.map((preset) => ({ ...preset, counts: normalizeCounts(preset.counts) }));
  } catch {
    return [];
  }
}

export function normalizeCounts(counts: CardCounts): CardCounts {
  return Object.fromEntries(CARD_RANKS.map((rank) => [rank, Math.max(0, Math.floor(Number(counts?.[rank]) || 0))]));
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
