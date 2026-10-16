// Small DOM helpers for the board page.

type Props = Record<string, string | number | boolean | null | undefined | EventListener>;
type Child = Node | string | null | undefined | false;

/** An element with attributes (on* props are listeners; class sets className) and children. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = String(v);
        else if (k === 'text') el.textContent = String(v);
        else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
}

export const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * Ask before something goes: a modal with the question, Cancel and a red button. Resolves true only on that button;
 * Esc, Cancel and a click outside all say no.
 */
export function confirmDialog(question: string, action = 'Delete'): Promise<boolean> {
    const dlg = byId<HTMLDialogElement>('confirm');
    byId('confirm-text').textContent = question;
    const yes = byId<HTMLButtonElement>('confirm-yes');
    yes.textContent = action;
    yes.disabled = false;
    return new Promise((resolve) => {
        const done = (ok: boolean) => {
            dlg.removeEventListener('close', onClose);
            yes.removeEventListener('click', onYes);
            if (dlg.open) dlg.close();
            resolve(ok);
        };
        const onClose = () => done(false);
        const onYes = () => done(true);
        dlg.addEventListener('close', onClose);
        yes.addEventListener('click', onYes);
        dlg.showModal();
        byId<HTMLButtonElement>('confirm-no').focus();
    });
}

/** A click on a modal's backdrop closes it. */
export function closeOnBackdrop(dlg: HTMLDialogElement): void {
    dlg.addEventListener('click', (ev) => {
        if (ev.target === dlg) dlg.close();
    });
}

export const isTyping = (t: EventTarget | null): boolean => {
    const el = t as HTMLElement | null;
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};
