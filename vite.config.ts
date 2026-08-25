import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS
    ? `/${process.env.GITHUB_REPOSITORY?.split('/')[1] || 'nocturne-xiii'}/`
    : '/',
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [react(), sites()],
});
