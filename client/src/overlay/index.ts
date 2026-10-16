// The overlay's entry, bundled to worker/public/overlay.js by scripts/build-overlay.mjs and served by the Worker at
// BASE/overlay.js. The Vite plugin puts `<script type="module" src="BASE/overlay.js">` on the app's pages, after
// `window.__CANVAS_BUILD__` (project, branch, commit, base, corner).
import type { BuildInfo } from './capture.ts';
import { startOverlay, type CanvasHandle } from './overlay.ts';
import { shootElement, shootScreen, upload } from './shots.ts';

declare global {
    interface Window {
        __CANVAS_BUILD__?: BuildInfo;
        __canvas?: CanvasHandle;
    }
}

// Once per page, even if the script is added twice.
if (!window.__canvas) {
    window.__canvas = startOverlay(window.__CANVAS_BUILD__, { shooters: { shootElement, shootScreen }, upload });
}
