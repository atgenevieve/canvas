import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import canvas from '@atgenevieve/canvas/vite';

export default defineConfig({
    plugins: [react(), canvas({ project: 'canvas-example', target: process.env.CANVAS_TARGET })],
});
