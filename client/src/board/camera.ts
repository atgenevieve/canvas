// The board's camera: cam.x, cam.y is the world point at the viewport's top left, cam.z the zoom. World units are the
// app's CSS pixels, so a phone frame is 390 wide in the world whatever the zoom. Pure, so it's tested on its own.

export interface Cam {
    x: number;
    y: number;
    z: number;
}

export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

export const MIN_Z = 0.05;
export const MAX_Z = 4;
export const FIT_PAD = 56;

export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

/** The world point at the middle of a viewport vw × vh. */
export function center(cam: Cam, vw: number, vh: number): { x: number; y: number } {
    return { x: cam.x + vw / 2 / cam.z, y: cam.y + vh / 2 / cam.z };
}

/** The camera that puts world point c at the middle of the viewport, at zoom c.z. */
export function fromCenter(c: { x: number; y: number; z: number }, vw: number, vh: number): Cam {
    return { z: c.z, x: c.x - vw / 2 / c.z, y: c.y - vh / 2 / c.z };
}

/** Pan by dx, dy screen pixels (content moves the other way). */
export function panBy(cam: Cam, dx: number, dy: number): Cam {
    return { x: cam.x + dx / cam.z, y: cam.y + dy / cam.z, z: cam.z };
}

/** Zoom by factor, keeping the world point under screen point px, py where it is. */
export function zoomAt(cam: Cam, px: number, py: number, factor: number): Cam {
    const z = clamp(cam.z * factor, MIN_Z, MAX_Z);
    return { z, x: cam.x + px / cam.z - px / z, y: cam.y + py / cam.z - py / z };
}

export function toWorld(cam: Cam, px: number, py: number): { x: number; y: number } {
    return { x: cam.x + px / cam.z, y: cam.y + py / cam.z };
}

export function toScreen(cam: Cam, wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - cam.x) * cam.z, y: (wy - cam.y) * cam.z };
}

/** The camera that shows box r whole, centred, no bigger than maxZ. */
export function fitBox(r: Box, vw: number, vh: number, maxZ = 1, pad = FIT_PAD): Cam {
    const z = clamp(Math.min((vw - 2 * pad) / Math.max(r.w, 1), (vh - 2 * pad) / Math.max(r.h, 1), maxZ), MIN_Z, MAX_Z);
    return fromCenter({ x: r.x + r.w / 2, y: r.y + r.h / 2, z }, vw, vh);
}

/** The box around all of them; null for none. */
export function bounds(boxes: Box[]): Box | null {
    if (!boxes.length) return null;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const x of boxes) {
        l = Math.min(l, x.x);
        t = Math.min(t, x.y);
        r = Math.max(r, x.x + x.w);
        b = Math.max(b, x.y + x.h);
    }
    return { x: l, y: t, w: r - l, h: b - t };
}

/** A wheel's zoom factor: deltaY in pixels, capped so a mouse notch and a trackpad feel alike. */
export function wheelFactor(deltaY: number): number {
    return Math.exp(-clamp(deltaY, -40, 40) * 0.01);
}
