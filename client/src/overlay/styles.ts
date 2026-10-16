// The overlay's look, inside its shadow root so the app's styles and these never touch. Option A of the approved mock:
// a dark floating pill, a brand outline and label on the hovered element, a white popover, orange pins.
export const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  --ink: #18181b; --mute: #71717a; --line: #e4e4e7; --card: #ffffff; --brand: #4f46e5; --brand-ink: #ffffff;
  --pin: #f97316; --pill: #18181b; --pill-hover: #3f3f46; --err: #b91c1c; --ring: #a5b4fc;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink);
}
@media (prefers-color-scheme: dark) {
  .root { --ink: #f4f4f5; --mute: #a1a1aa; --line: #3f3f46; --card: #18181b; --pill: #27272a; --pill-hover: #3f3f46; --err: #fca5a5; }
}
[hidden] { display: none !important; }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

.layer { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; background: transparent; }
.hl { position: fixed; pointer-events: none; border: 2px solid var(--brand); border-radius: 6px; background: rgba(79, 70, 229, .06); }
.area { position: fixed; pointer-events: none; border: 2px dashed var(--brand); border-radius: 4px; background: rgba(79, 70, 229, .08); }
.tag {
  position: fixed; pointer-events: none; max-width: calc(100vw - 16px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  background: var(--brand); color: var(--brand-ink); font: 600 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 3px 6px; border-radius: 4px;
}

.pin {
  position: fixed; width: 24px; height: 24px; padding: 0; border: 0; pointer-events: auto; cursor: pointer;
  border-radius: 12px 12px 12px 2px; background: var(--pin); color: #fff; font: 700 12px/24px system-ui, sans-serif;
  text-align: center; box-shadow: 0 2px 6px rgba(0, 0, 0, .25);
}
.pin::after { content: ""; position: absolute; inset: -10px; }
.pin[aria-expanded="true"] { box-shadow: 0 0 0 2px var(--card), 0 0 0 4px var(--pin); }

.pill {
  position: fixed; display: flex; gap: 2px; padding: 4px; border-radius: 99px; background: var(--pill);
  box-shadow: 0 6px 20px rgba(0, 0, 0, .25); pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none;
}
.pill.bottom-right { right: calc(14px + env(safe-area-inset-right)); bottom: calc(14px + env(safe-area-inset-bottom)); }
.pill.bottom-left { left: calc(14px + env(safe-area-inset-left)); bottom: calc(14px + env(safe-area-inset-bottom)); }
.pill.top-right { right: calc(14px + env(safe-area-inset-right)); top: calc(14px + env(safe-area-inset-top)); }
.pill.top-left { left: calc(14px + env(safe-area-inset-left)); top: calc(14px + env(safe-area-inset-top)); }
.pill.dragging { cursor: grabbing; box-shadow: 0 10px 28px rgba(0, 0, 0, .35); }
.pill > * {
  width: 36px; height: 36px; border-radius: 18px; border: 0; background: transparent; color: #fff;
  display: flex; align-items: center; justify-content: center; font: 600 13px/1 system-ui, sans-serif; text-decoration: none;
  -webkit-touch-callout: none;
}
.pill > button, .pill > a { cursor: pointer; }
.pill > button:hover, .pill > a:hover { background: var(--pill-hover); }
.pill > [aria-pressed="true"], .pill > [aria-pressed="true"]:hover { background: var(--brand); }
.pill svg { width: 18px; height: 18px; display: block; }

.menu, .toast {
  position: fixed; pointer-events: auto; background: var(--pill); color: #fff; border-radius: 10px; padding: 4px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, .25);
}
.menu button {
  display: block; width: 100%; min-height: 36px; padding: 8px 12px; border: 0; border-radius: 6px; background: transparent;
  color: #fff; font: 600 13px/1.2 system-ui, sans-serif; text-align: left; white-space: nowrap; cursor: pointer;
}
.menu button:hover, .menu button:focus-visible { background: var(--pill-hover); }
.toast { padding: 8px 12px; font: 600 13px/1.2 system-ui, sans-serif; pointer-events: none; max-width: calc(100vw - 28px); }

.pop {
  position: fixed; width: min(300px, calc(100vw - 16px)); max-height: 60vh; overflow: auto; pointer-events: auto;
  background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, .14); padding: 12px;
}
.pop textarea {
  display: block; width: 100%; height: 72px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; resize: none;
  font: inherit; color: inherit; background: transparent;
}
.pop textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand); }
.pop .reply textarea { height: 56px; }
.act { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.btn {
  min-height: 32px; padding: 6px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card);
  color: var(--ink); font: 600 13px/1.2 system-ui, sans-serif; cursor: pointer;
}
.btn.p { background: var(--brand); border-color: var(--brand); color: var(--brand-ink); }
.btn:disabled { opacity: .6; cursor: default; }
.err { margin: 8px 0 0; color: var(--err); font-size: 13px; }
.err:empty { display: none; }

.head { display: flex; align-items: center; gap: 8px; margin: -4px -4px 8px 0; }
.what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--brand); font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; }
.x { width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--mute); font-size: 20px; line-height: 1; cursor: pointer; }
.x:hover { color: var(--ink); }
.msgs { list-style: none; margin: 0 0 10px; padding: 0; display: grid; gap: 10px; }
.who { font-size: 12px; color: var(--mute); }
.who b { color: var(--ink); font-weight: 600; }
.body { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }

.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

export const ICON_COMMENT =
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5Z"/></svg>';
export const ICON_BOARD =
    '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1.2"/><rect x="11" y="3" width="6" height="6" rx="1.2"/><rect x="3" y="11" width="6" height="6" rx="1.2"/><rect x="11" y="11" width="6" height="6" rx="1.2"/></svg>';
