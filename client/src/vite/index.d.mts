// Types for `@atgenevieve/canvas/vite` (the plugin is plain JavaScript so apps can load it from node_modules).
import type { Plugin } from 'vite';

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface CanvasOptions {
    /** The project's name on its canvas, as in canvas.config.json. */
    project: string;
    /** Where the canvas Worker is routed on the app's host. Default "/__canvas". */
    base?: string;
    /** In `vite dev`, proxy `base` to this canvas (the deployed one, or http://localhost:8787 for wrangler dev). */
    target?: string;
    /** Where the overlay's toolbar sits. Default "bottom-right". */
    corner?: Corner;
}

/** What the plugin puts in `window.__CANVAS_BUILD__` for the overlay. */
export interface BuildInfo {
    project: string;
    branch: string | null;
    commit: string | null;
    base: string;
    corner: Corner;
}

export const DEFAULT_BASE: '/__canvas';
export const CORNERS: readonly Corner[];
export function gitInfo(cwd: string, env?: Record<string, string | undefined>): { branch: string | null; commit: string | null };
export function transformJsx(code: string, id: string, root: string): { code: string; map: import('magic-string').SourceMap } | null;
export default function canvas(options: CanvasOptions): Plugin;
