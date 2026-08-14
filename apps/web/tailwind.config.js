/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: 'var(--ink)',
        paper: 'var(--paper)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        line: 'var(--line)',
        'line-strong': 'var(--line-strong)',
        muted: 'var(--muted)',
        'muted-2': 'var(--muted-2)',
        'muted-3': 'var(--muted-3)',
        accent: 'var(--accent)',
        'accent-ink': 'var(--accent-ink)',
        'accent-soft': 'var(--accent-soft)',
        'accent-line': 'var(--accent-line)',
        amber: 'var(--amber)',
        expected: 'var(--v-expected)',
        flaky: 'var(--v-flaky)',
        unverified: 'var(--v-unverified)',
        realbug: 'var(--v-realbug)',
      },
      fontFamily: {
        display: ['Archivo', 'Helvetica', 'system-ui', 'sans-serif'],
        sans: ['Archivo', 'Helvetica', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      letterSpacing: { label: '0.16em', tight2: '-0.03em' },
      borderRadius: { xl2: '14px' },
      boxShadow: {
        panel: '0 1px 2px rgba(0,0,0,.04), 0 8px 24px -12px rgba(0,0,0,.12)',
        glow: '0 0 0 1px var(--accent-soft), 0 0 24px -4px var(--accent-soft)',
      },
      keyframes: {
        'pulse-ring': { '0%': { boxShadow: '0 0 0 0 var(--accent-soft)' }, '70%': { boxShadow: '0 0 0 8px transparent' }, '100%': { boxShadow: '0 0 0 0 transparent' } },
        'fade-up': { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'scan': { '0%,100%': { opacity: '.35' }, '50%': { opacity: '1' } },
      },
      animation: {
        'pulse-ring': 'pulse-ring 1.6s ease-out infinite',
        'fade-up': 'fade-up .35s cubic-bezier(.2,.7,.2,1) both',
        'scan': 'scan 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
