export const themes = [
  {
    id: 'dark',
    name: 'Original \u00b7 Default',
    mode: 'dark',
  },
  {
    id: 'light',
    name: 'Original Light',
    mode: 'light',
  },
  {
    id: 'navy',
    name: 'Deep Harbor',
    mode: 'dark',
  },
  {
    id: 'ember',
    name: 'Hearth',
    mode: 'dark',
  },
  {
    id: 'plum',
    name: 'Dusk',
    mode: 'dark',
  },
  {
    id: 'forest',
    name: 'Evergreen',
    mode: 'dark',
  },
  {
    id: 'graphite',
    name: 'Graphite',
    mode: 'dark',
  },
  {
    id: 'contrast',
    name: 'Carbon Contrast',
    mode: 'dark',
  },
  {
    id: 'tide',
    name: 'Low Tide',
    mode: 'dark',
  },
  {
    id: 'paper',
    name: 'Linen',
    mode: 'light',
  },
  {
    id: 'porcelain',
    name: 'Porcelain',
    mode: 'light',
  },
  {
    id: 'sage',
    name: 'Sage Journal',
    mode: 'light',
  },
] as const;
export type ThemeId = (typeof themes)[number]['id'];
export const themeMode = (id: string) => themes.find((t) => t.id === id)?.mode ?? 'dark';
export function readTheme(): ThemeId {
  try {
    const saved = localStorage.getItem('intelboard.theme');
    return themes.find((t) => t.id === saved)?.id ?? 'dark';
  } catch {
    return 'dark';
  }
}
