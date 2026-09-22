/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter var', 'Inter', 'Segoe UI Variable Text', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['Cascadia Code', 'Cascadia Mono', 'Consolas', 'ui-monospace', 'monospace']
      },
      colors: {
        // Local Note palette: deep slate base with a warm amber "recording"
        // accent and a cool teal for AI/derived content.
        ink: {
          50: '#f5f7fa',
          100: '#e9edf3',
          200: '#cfd8e3',
          300: '#a7b6c9',
          400: '#7186a0',
          500: '#4e6480',
          600: '#3a4d66',
          700: '#2b3a4d',
          800: '#1d2836',
          900: '#141d27',
          950: '#0b1118'
        },
        ember: {
          300: '#ffc46b',
          400: '#ffab3d',
          500: '#f78f1e',
          600: '#d9700d'
        },
        signal: {
          300: '#7fe3d0',
          400: '#40cdb6',
          500: '#1fb39c',
          600: '#128f7e'
        }
      },
      boxShadow: {
        panel: '0 1px 2px rgba(11,17,24,0.06), 0 8px 24px -12px rgba(11,17,24,0.25)'
      }
    }
  },
  plugins: []
}
