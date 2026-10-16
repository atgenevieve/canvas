// The screenshots in a real browser: shoots a fixture page with a private block, a password field, a fixed header and
// the canvas's own toolbar, then reads the pixels back. Run by hand (not part of `npm test`):
//
//   node client/test/shots.browser.mjs            # Chromium from /opt/pw-browsers/chromium, or CHROMIUM=<path>
//
// Writes the shots to a temp folder so you can look at them, and exits 1 if a check fails.
/* global document, window, createImageBitmap */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
    entryPoints: [path.join(here, '../src/overlay/shots.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'canvasShots',
    write: false,
    target: 'es2022',
});

// Fictional people only. Bright colours make leaks easy to spot: anything red, black or magenta in a private or UI
// area is a leak.
const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 16px/1.4 sans-serif; background: #ffffff; color: #000; }
  header { position: fixed; top: 0; left: 0; right: 0; height: 40px; background: #1d4ed8; color: #fff; }
  main { padding: 60px 20px 2000px; }
  #card { width: 320px; padding: 16px; border: 1px solid #ddd; }
  #secret { height: 120px; background: #ff0000; color: #000; font-weight: 700; font-size: 28px; }
  #secret::after { content: 'after-leak'; color: #000; }
  #pw { width: 200px; height: 30px; font-size: 24px; color: #000; background: #fff; border: 2px solid #888; }
  #toolbar { position: fixed; right: 0; bottom: 0; width: 120px; height: 60px; background: #ff00ff; }
  #wide { width: 3000px; height: 50px; background: #16a34a; }
</style></head><body>
  <header>Canvas test app</header>
  <main>
    <div style="height: 300px"></div>
    <div id="card">
      <p>Visible: Jordan Alvarez</p>
      <div id="secret" data-canvas-private>Ruth Adeyemi ruth@example.org 555-0142
        <img alt="" width="60" height="60" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="#000"/></svg>')}">
      </div>
      <input id="pw" type="password" value="hunter22hunter22">
    </div>
    <div id="wide"></div>
  </main>
  <div id="toolbar" data-canvas-ui>Comment</div>
</body></html>`;

const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok });
    console.info(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-shots-'));
try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
    await page.setContent(fixture);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => window.scrollTo(0, 200));

    const result = await page.evaluate(async () => {
        const { shootElement, shootScreen, PRIVATE_FILL } = window.canvasShots;
        const hex = PRIVATE_FILL.slice(1);
        const fill = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));

        async function read(blob) {
            const bmp = await createImageBitmap(blob);
            const c = document.createElement('canvas');
            c.width = bmp.width;
            c.height = bmp.height;
            const ctx = c.getContext('2d');
            ctx.drawImage(bmp, 0, 0);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let b64 = '';
            for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return { w: c.width, h: c.height, type: blob.type, data: btoa(b64), px: ctx.getImageData(0, 0, c.width, c.height) };
        }
        // Stats over a CSS-pixel box (inset a little, as lossy WebP blurs edges), at the shot's scale.
        function region(img, scale, box, inset = 3) {
            const x0 = Math.ceil((box.x + inset) * scale), y0 = Math.ceil((box.y + inset) * scale);
            const x1 = Math.floor((box.x + box.w - inset) * scale), y1 = Math.floor((box.y + box.h - inset) * scale);
            let maxDev = 0, dark = 0, n = 0;
            for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
                for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) {
                    const i = (y * img.w + x) * 4, d = img.px.data;
                    const dev = Math.max(...[0, 1, 2].map((k) => Math.abs(d[i + k] - fill[k])));
                    maxDev = Math.max(maxDev, dev);
                    if (d[i] + d[i + 1] + d[i + 2] < 200) dark++;
                    n++;
                }
            }
            return { maxDev, dark, n };
        }
        function count(img, test) {
            let n = 0;
            const d = img.px.data;
            for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2])) n++;
            return n;
        }
        const magenta = (r, g, b) => r > 200 && g < 60 && b > 200;
        const red = (r, g, b) => r > 200 && g < 60 && b < 60;
        const box = (el, origin) => {
            const r = el.getBoundingClientRect(), o = origin ? origin.getBoundingClientRect() : { left: 0, top: 0 };
            return { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
        };
        const card = document.getElementById('card');
        const secret = document.getElementById('secret');
        const pw = document.getElementById('pw');

        const el = await read(await shootElement(card));
        const elScale = el.w / card.getBoundingClientRect().width;
        const scr = await read(await shootScreen());
        const scrScale = scr.w / document.documentElement.clientWidth;
        const wide = await read(await shootElement(document.getElementById('wide')));
        const priv = await read(await shootElement(secret.querySelector('img')));
        const headerPx = (() => { const i = (Math.round(10 * scrScale) * scr.w + Math.round(300 * scrScale)) * 4; return Array.from(scr.px.data.slice(i, i + 3)); })();
        const pwBox = box(pw, card);
        return {
            el: { w: el.w, h: el.h, type: el.type, scale: elScale, data: el.data,
                  secret: region(el, elScale, box(secret, card)), pw: region(el, elScale, { x: pwBox.x + 4, y: pwBox.y + 4, w: pwBox.w - 8, h: pwBox.h - 8 }), red: count(el, red) },
            screen: { w: scr.w, h: scr.h, type: scr.type, scale: scrScale, data: scr.data,
                      secret: region(scr, scrScale, box(secret)), magenta: count(scr, magenta), red: count(scr, red), headerPx },
            wide: { w: wide.w, h: wide.h, data: wide.data },
            priv: { w: priv.w, h: priv.h, secret: region(priv, priv.w / 60, { x: 0, y: 0, w: 60, h: 60 }, 1), data: priv.data },
        };
    });

    for (const [name, shot] of Object.entries(result)) {
        fs.writeFileSync(path.join(outDir, `${name}.${shot.type === 'image/png' ? 'png' : 'webp'}`), Buffer.from(shot.data, 'base64'));
    }
    const { el, screen, wide, priv } = result;
    check('element shot is WebP', el.type === 'image/webp', el.type);
    check('pixel ratio capped at 2 (screen is 3)', Math.abs(el.scale - 2) < 0.01, `scale ${el.scale.toFixed(2)}`);
    check('private block is one solid colour in the element shot', el.secret.n > 1000 && el.secret.maxDev <= 8 && el.secret.dark === 0,
        `${el.secret.n} px, max deviation ${el.secret.maxDev}, dark ${el.secret.dark}`);
    check('no red from the private block in the element shot', el.red === 0, `${el.red} red px`);
    check('password field shows no value', el.pw.n > 0 && el.pw.dark === 0, `${el.pw.dark} dark px of ${el.pw.n}`);
    check('screen shot is the viewport', screen.w === 780 && screen.h === 1688, `${screen.w}x${screen.h}`);
    check('private block is one solid colour in the screen shot', screen.secret.n > 1000 && screen.secret.maxDev <= 8 && screen.secret.dark === 0,
        `${screen.secret.n} px, max deviation ${screen.secret.maxDev}, dark ${screen.secret.dark}`);
    check('no red from the private block in the screen shot', screen.red === 0, `${screen.red} red px`);
    check('canvas UI left out of the screen shot', screen.magenta === 0, `${screen.magenta} magenta px`);
    check('fixed header stays at the top when scrolled', screen.headerPx[2] > 150 && screen.headerPx[0] < 80, `rgb(${screen.headerPx})`);
    check('longest side capped at 2000px', Math.max(wide.w, wide.h) === 2000, `${wide.w}x${wide.h}`);
    check('shooting inside a private block gives a solid block', priv.secret.maxDev <= 8 && priv.secret.dark === 0, `${priv.w}x${priv.h}, max deviation ${priv.secret.maxDev}`);
} finally {
    await browser.close();
}

console.info(`shots in ${outDir}`);
const failed = checks.filter((c) => !c.ok).length;
console.info(failed ? `${failed} of ${checks.length} checks failed` : `all ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
