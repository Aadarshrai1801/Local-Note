/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './capture.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // One family, three weights. Nothing else.
        sans: ['Inter var', 'Inter', 'Segoe UI Variable Text', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['Cascadia Code', 'Cascadia Mono', 'Consolas', 'ui-monospace', 'monospace']
      },

      colors: {
        /**
         * Chrome: near-black to deep charcoal. This is the app shell, the
         * sidebar, the floating bar — everything that frames content.
         */
        ink: {
          50: '#f4f4f5',
          100: '#e4e4e7',
          200: '#c7c7cd',
          300: '#a1a1aa',
          400: '#71717a',
          500: '#52525b',
          600: '#3f3f46',
          700: '#27272a',
          800: '#1c1c1f',
          850: '#161618',
          900: '#111113',
          950: '#0b0b0d'
        },

        /**
         * The single saturated accent. Used only for the active/recording state
         * and primary calls to action — never for decoration. If two things on
         * screen are amber, one of them is wrong.
         */
        ember: {
          200: '#ffe0b0',
          300: '#ffc46b',
          400: '#ffab3d',
          500: '#f78f1e',
          600: '#d9700d',
          700: '#8a4708'
        },

        /**
         * Content canvas: the deliberately lighter surface for text-heavy areas
         * (note lists, transcripts, the dictionary). Dark chrome around a light
         * page keeps long-form text legible without going full light mode.
         */
        canvas: {
          DEFAULT: '#fafafa',
          raised: '#ffffff',
          sunken: '#f4f4f5',
          hairline: '#e4e4e7',
          text: '#18181b',
          muted: '#5c5c66',
          faint: '#8b8b95'
        },

        /**
         * AI-derived content (summaries, answers, briefs). Deliberately
         * desaturated: it should read as a different *kind* of content without
         * competing with the accent for attention.
         */
        signal: {
          300: '#aab6c6',
          400: '#8895a8',
          500: '#6c7a8d',
          600: '#55637a'
        },

        /** Destructive only. Never used as a second accent. */
        danger: {
          400: '#f87171',
          500: '#ef4444',
          600: '#dc2626'
        }
      },

      borderRadius: {
        // 12-20px shape language, plus pill.
        card: '16px',
        panel: '20px',
        control: '12px'
      },

      boxShadow: {
        // Soft, wide, low-opacity. No hard borders or heavy chrome.
        float: '0 8px 32px -8px rgba(0,0,0,0.55), 0 2px 8px -2px rgba(0,0,0,0.4)',
        overlay: '0 16px 48px -12px rgba(0,0,0,0.7), 0 4px 12px -4px rgba(0,0,0,0.5)',
        lift: '0 2px 8px -2px rgba(0,0,0,0.25)'
      },

      transitionTimingFunction: {
        // Physical, decelerating. Reads as motion with weight rather than
        // a mechanical linear slide.
        spring: 'cubic-bezier(0.22, 1, 0.36, 1)',
        snap: 'cubic-bezier(0.34, 1.4, 0.64, 1)'
      },

      transitionDuration: {
        150: '150ms',
        200: '200ms',
        250: '250ms'
      },

      keyframes: {
        'pulse-rec': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.55', transform: 'scale(0.92)' }
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' }
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        }
      },

      animation: {
        'pulse-rec': 'pulse-rec 1.6s ease-in-out infinite',
        'fade-up': 'fade-up 200ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'scale-in': 'scale-in 150ms cubic-bezier(0.22, 1, 0.36, 1) both',
        shimmer: 'shimmer 1.8s linear infinite'
      }
    }
  },
  plugins: []
}
