// The thread list beside the board (a bottom sheet on a phone): Open · N and Resolved. A thread opens in place with
// every comment, a reply box and Resolve or Reopen; your own comments have ⋯ to edit or delete (deleting the first
// deletes the thread). Lifted from Whipsheet's comments panel (workers/canvas/app/comments.js).
import type { Comment, Thread } from '../../../shared/contract.ts';
import { ApiError, post } from './api.ts';
import { byId, h } from './dom.ts';
import { ago, who } from './format.ts';
import { pageKey, threadOnScreen } from './layout.ts';
import { on, removeThread, select, store, threadById, upsert } from './store.ts';

let panel: HTMLElement;
let list: HTMLElement;
let openTab: HTMLButtonElement;
let resolvedTab: HTMLButtonElement;
let sheetBtn: HTMLButtonElement;
let which: 'open' | 'resolved' = 'open';
let editing: string | null = null; // a comment being edited
let confirming: string | null = null; // a comment whose delete is being confirmed
let menuFor: string | null = null; // the comment whose ⋯ menu is open
const replyDrafts = new Map<string, string>();

export function initThreads(): void {
    panel = byId('panel');
    list = byId('threads');
    openTab = byId<HTMLButtonElement>('list-open');
    resolvedTab = byId<HTMLButtonElement>('list-resolved');
    sheetBtn = byId<HTMLButtonElement>('sheet');
    openTab.addEventListener('click', () => show('open'));
    resolvedTab.addEventListener('click', () => show('resolved'));
    sheetBtn.addEventListener('click', () => setSheet(panel.dataset.sheet !== 'up'));
    on('threads', render);
    on('screens', render);
    on('selected', () => {
        editing = confirming = menuFor = null;
        const t = threadById(store.selected);
        if (t) {
            which = t.status;
            setSheet(true);
        }
        render();
        if (t) list.querySelector(`[data-id="${CSS.escape(t.id)}"]`)?.scrollIntoView({ block: 'nearest' });
    });
    document.addEventListener('pointerdown', (ev) => {
        if (menuFor && !(ev.target as Element).closest?.('.msg-menu')) {
            menuFor = null;
            render();
        }
    });
    render();
}

function show(w: 'open' | 'resolved') {
    which = w;
    render();
}

function setSheet(up: boolean) {
    panel.dataset.sheet = up ? 'up' : 'down';
    sheetBtn.setAttribute('aria-expanded', String(up));
}

function screenName(t: Thread): string {
    const s = store.screens.find((x) => threadOnScreen(t, x));
    return s ? s.name : pageKey(t.url);
}

function render() {
    const open = store.threads.filter((t) => t.status === 'open');
    openTab.textContent = 'Open · ' + open.length;
    openTab.setAttribute('aria-selected', String(which === 'open'));
    resolvedTab.setAttribute('aria-selected', String(which === 'resolved'));
    sheetBtn.textContent = 'Comments · ' + open.length;
    // keep the caret where it was in a box being typed in
    const a = document.activeElement as HTMLTextAreaElement | null;
    const keep = a?.tagName === 'TEXTAREA' && a.dataset.k && list.contains(a) ? { k: a.dataset.k, s: a.selectionStart, e: a.selectionEnd } : null;
    const scroll = list.scrollTop;
    list.replaceChildren(...store.threads.filter((t) => t.status === which).map(threadEl));
    list.scrollTop = scroll;
    if (keep) {
        const ta = list.querySelector<HTMLTextAreaElement>(`textarea[data-k="${keep.k}"]`);
        ta?.focus({ preventScroll: true });
        ta?.setSelectionRange(keep.s, keep.e);
    }
}

function threadEl(t: Thread): HTMLElement {
    const isOpen = t.id === store.selected;
    const first = t.comments[0];
    const meta = [first ? who(first.author, store.me) : who(t.created_by, store.me), ago(t.created_at), screenName(t)].filter(Boolean).join(' · ');
    const head = h(
        'button',
        { type: 'button', class: 'thread-head', 'aria-expanded': String(isOpen), onclick: () => select(isOpen ? null : t.id) },
        h('span', { class: 'meta', text: meta }),
        t.component ? h('span', { class: 'el', text: t.component }) : null,
        !isOpen && first ? h('span', { class: 'body clamp', text: first.body }) : null,
        !isOpen && t.comments.length > 1 ? h('span', { class: 'more', text: t.comments.length - 1 + (t.comments.length === 2 ? ' reply' : ' replies') }) : null,
    );
    const art = h('article', { class: 'thread' + (isOpen ? ' selected' : ''), 'data-id': t.id }, head);
    if (isOpen) {
        art.append(h('ol', { class: 'msgs' }, ...t.comments.map((c, i) => msgEl(t, c, i))), replyEl(t));
    }
    return art;
}

function msgEl(t: Thread, c: Comment, i: number): HTMLElement {
    const mine = c.author === store.me;
    const headKids: Node[] = [
        h('span', { class: 'who', text: who(c.author, store.me) }),
        h('time', { class: 'when', datetime: c.created_at, text: ago(c.created_at) + (c.edited_at ? ' · edited' : '') }),
    ];
    if (mine && editing !== c.id) {
        const btn = h('button', {
            type: 'button',
            class: 'icon-btn',
            'aria-label': 'Comment options',
            'aria-haspopup': 'menu',
            'aria-expanded': String(menuFor === c.id),
            text: '⋯',
            onclick: () => {
                menuFor = menuFor === c.id ? null : c.id;
                render();
                if (menuFor) list.querySelector<HTMLButtonElement>('.msg-menu .menu button')?.focus();
            },
        });
        const menu =
            menuFor === c.id
                ? h(
                      'div',
                      { class: 'menu', role: 'menu' },
                      h('button', { type: 'button', role: 'menuitem', class: 'menu-item', text: 'Edit', onclick: () => ((menuFor = null), (editing = c.id), render(), focusKey('edit-' + c.id)) }),
                      h('button', { type: 'button', role: 'menuitem', class: 'menu-item danger', text: 'Delete', onclick: () => ((menuFor = null), (confirming = c.id), render()) }),
                  )
                : null;
        headKids.push(h('div', { class: 'msg-menu' }, btn, menu));
    }
    const li = h('li', { class: 'msg' }, h('div', { class: 'msg-head' }, ...headKids));
    if (editing === c.id) {
        li.append(
            composer({
                k: 'edit-' + c.id,
                label: 'Edit comment',
                submit: 'Save',
                value: c.body,
                onCancel: () => ((editing = null), render()),
                onSubmit: async (body) => {
                    const { thread } = await post<{ thread: Thread }>('comments/' + encodeURIComponent(c.id) + '/edit', { body });
                    editing = null;
                    upsert(thread);
                },
            }),
        );
    } else li.append(h('p', { class: 'body', text: c.body }));
    if (confirming === c.id) {
        const yes = h('button', { type: 'button', class: 'btn danger', text: 'Delete' });
        yes.addEventListener('click', async () => {
            yes.disabled = true;
            try {
                const out = await post<{ thread?: Thread; deleted?: boolean }>('comments/' + encodeURIComponent(c.id) + '/delete');
                confirming = null;
                if (out.thread) upsert(out.thread);
                else removeThread(t.id);
            } catch {
                yes.disabled = false;
            }
        });
        li.append(
            h(
                'div',
                { class: 'confirm', role: 'group', 'aria-label': 'Confirm delete' },
                h('span', { text: i === 0 ? 'Delete this thread?' : 'Delete this comment?' }),
                h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => ((confirming = null), render()) }),
                yes,
            ),
        );
    }
    return li;
}

function statusBtn(t: Thread): HTMLButtonElement {
    const resolved = t.status === 'resolved';
    const b = h('button', { type: 'button', class: 'btn', text: resolved ? 'Reopen' : 'Resolve' });
    b.addEventListener('click', async () => {
        b.disabled = true;
        try {
            const { thread } = await post<{ thread: Thread }>('threads/' + encodeURIComponent(t.id) + '/' + (resolved ? 'reopen' : 'resolve'));
            upsert(thread);
            which = thread.status;
            render();
        } catch {
            b.disabled = false;
        }
    });
    return b;
}

function replyEl(t: Thread): HTMLElement {
    return composer({
        k: 'reply-' + t.id,
        label: 'Reply',
        submit: 'Reply',
        value: replyDrafts.get(t.id) || '',
        onInput: (v) => replyDrafts.set(t.id, v),
        extra: statusBtn(t),
        onSubmit: async (body) => {
            const { thread } = await post<{ thread: Thread }>('threads/' + encodeURIComponent(t.id) + '/comments', { body });
            replyDrafts.delete(t.id);
            upsert(thread);
        },
    });
}

function focusKey(k: string) {
    list.querySelector<HTMLTextAreaElement>(`textarea[data-k="${k}"]`)?.focus();
}

function composer(o: {
    k: string;
    label: string;
    submit: string;
    value?: string;
    onSubmit: (body: string) => Promise<void>;
    onCancel?: () => void;
    onInput?: (v: string) => void;
    extra?: HTMLElement;
}): HTMLFormElement {
    const ta = h('textarea', { class: 'field', rows: o.onCancel ? 3 : 2, 'aria-label': o.label, 'data-k': o.k, placeholder: o.onCancel ? null : 'Reply' });
    ta.value = o.value || '';
    const err = h('p', { class: 'err', role: 'alert' });
    const send = h('button', { type: 'submit', class: 'btn primary', text: o.submit });
    const row = h('div', { class: 'row-end' }, o.extra || null, h('span', { class: 'sp' }));
    if (o.onCancel) row.append(h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: o.onCancel }));
    row.append(send);
    const form = h('form', { class: o.onCancel ? 'edit' : 'reply' }, ta, err, row);
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            form.requestSubmit();
        } else if (e.key === 'Escape' && o.onCancel) {
            e.preventDefault();
            e.stopPropagation();
            o.onCancel();
        }
    });
    if (o.onInput) ta.addEventListener('input', () => o.onInput!(ta.value));
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = ta.value.trim();
        if (!body || send.disabled) return;
        send.disabled = true;
        err.textContent = '';
        try {
            await o.onSubmit(body);
        } catch (x) {
            err.textContent = x instanceof ApiError ? x.message : 'Couldn’t save. Try again.';
            send.disabled = false;
        }
    });
    return form;
}
