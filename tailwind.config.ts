// SamSpy — Tailwind config
// v0.1.0 (2026-11-17) — dark catalog theme
// v0.2.0 (2026-11-17) — light theme palette
import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Light catalog theme.
        ink: '#ffffff',      // card / input background
        panel: '#ffffff',    // panels
        edge: '#e6e6ec',     // borders
        accent: '#7c5cff',   // brand purple
        muted: '#6b6b7b',    // secondary text
      },
    },
  },
  plugins: [],
};

export default config;
