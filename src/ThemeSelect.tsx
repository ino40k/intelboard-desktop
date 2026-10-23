import { Palette } from 'lucide-react';
import { themes, type ThemeId } from './themes';
export function ThemeSelect({
  value,
  onChange,
}: {
  value: ThemeId;
  onChange: (theme: ThemeId) => void;
}) {
  return (
    <label className="theme-select">
      <Palette size={17} aria-hidden="true" />
      <span>Theme</span>
      <select
        aria-label="Color theme"
        value={value}
        onChange={(e) => onChange(e.target.value as ThemeId)}
      >
        {themes.map((theme) => (
          <option key={theme.id} value={theme.id}>
            {theme.name}
          </option>
        ))}
      </select>
    </label>
  );
}
