/** @type {import('tailwindcss').Config} */
export default {
     content: ['./index.html', './src/**/*.{js,jsx}'],
     theme: {
          extend: {
               colors: {
                    // Named for what they mean in this system, not for their hue:
                    // correctness, expected-conflict, and genuine fault.
                    ink: { DEFAULT: '#e8ebed', dim: '#8d97a0', faint: '#5b6472' },
               },
               fontFamily: {
                    sans: ['IBM Plex Sans', 'system-ui', 'sans-serif'],
                    mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
               },
          },
     },
     plugins: [],
};
