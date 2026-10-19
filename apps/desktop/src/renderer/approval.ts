/**
 * Secure approval dialog renderer (approval.html). Displays main's validated view model only and
 * returns a decision for main's single-use dialogId. With a possible-repeat warning, Approve stays
 * disabled until the warning is rendered and visible AND main has acknowledged that (main also
 * refuses an early Approve on its own).
 */
import { HIDDEN_CHARACTERS_BADGE, TAB_MARKER, TRAILING_SPACE_MARKER, type ApprovalView, type BoundFieldView, type CodexView } from '../shared/approval';
import type { BoundTextRender, CommandRender, RenderSegment } from '../shared/commandRender';
import { api, call } from './api';
import { approveEnabled, isWarningVisible } from './approvalGate';
import { h } from './dom';

const root = document.getElementById('approval') as HTMLElement;

/**
 * Main's Approve gate (visible + focused timer, decided by main from window events). The latest
 * push per dialog is kept so a push that arrives before render() still applies.
 */
let gate: { dialogId: string; approveAfterMs: number | null } | null = null;
let onGate: (() => void) | null = null;
api.on('approvalGate', (g) => {
  gate = g;
  onGate?.();
});

function waitUntilVisible(el: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const check = (ratio: number): boolean => {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return isWarningVisible({
        documentVisible: document.visibilityState === 'visible',
        intersectionRatio: ratio,
        width: rect.width,
        height: rect.height,
        display: cs.display,
        visibility: cs.visibility,
        opacity: Number(cs.opacity),
      });
    };
    const io = new IntersectionObserver(
      (entries) => {
        const ratio = entries[entries.length - 1]?.intersectionRatio ?? 0;
        // Wait one painted frame so the warning has actually been drawn.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (check(ratio)) {
              io.disconnect();
              resolve();
            }
          }),
        );
      },
      { threshold: [0, 0.99, 1] },
    );
    io.observe(el);
  });
}

/** One L231 segment as DOM nodes (textContent only; never innerHTML). */
function segmentNode(seg: RenderSegment): Node {
  switch (seg.kind) {
    case 'text':
      return document.createTextNode(seg.text);
    case 'escape':
      return h('span', { class: 'hidden-char', text: seg.text, attrs: { title: 'Hidden character' } });
    case 'tab':
      return h('span', { class: 'tab-marker', text: TAB_MARKER, attrs: { title: 'Tab' } });
    case 'trailing_whitespace':
      return h('span', { class: 'trailing-ws', text: TRAILING_SPACE_MARKER.repeat(seg.text.length), attrs: { title: 'Trailing spaces' } });
  }
}

/**
 * codex_command box (CONTRACTS L231): one block per line (\n real breaks, CRLF already one break),
 * the line count, visible escapes with a badge, tab markers, visible trailing spaces; wraps with no
 * horizontal scroll. Read-only: plain elements, nothing editable.
 */
function commandBox(r: CommandRender, label: string): HTMLElement[] {
  const box = h('div', { class: 'codex-command', attrs: { id: 'codex-command', role: 'textbox', 'aria-readonly': 'true', 'aria-multiline': 'true', tabindex: '0', 'aria-label': label } });
  for (const line of r.lines) {
    const el = h('div', { class: 'cmd-line' });
    for (const seg of line) el.append(segmentNode(seg));
    if (line.length === 0) el.append(h('br'));
    box.append(el);
  }
  const lines = r.lineCount === 1 ? '1 line' : `${String(r.lineCount)} lines`;
  const head = h(
    'div',
    { class: 'codex-label' },
    h('span', { attrs: { id: 'codex-label' }, text: `${label} (${lines})` }),
    r.hiddenCharacters ? h('span', { class: 'hidden-badge', attrs: { id: 'codex-hidden-badge', role: 'note' }, text: HIDDEN_CHARACTERS_BADGE }) : null,
  );
  return [head, box];
}

/** The "contains hidden characters" badge (L230/L231). */
function hiddenBadge(id?: string): HTMLElement {
  return h('span', { class: 'hidden-badge', attrs: { role: 'note', ...(id ? { id } : {}) }, text: HIDDEN_CHARACTERS_BADGE });
}

/**
 * One bound value (CONTRACTS L230; same segment model as the codex_command box): hidden characters
 * (incl. tab, LF, CR) are highlighted escapes; trailing spaces visible; wraps with no horizontal
 * scroll. textContent only.
 */
function boundValue(r: BoundTextRender, cls = 'bound-value'): HTMLElement {
  const el = h('div', { class: cls });
  for (const seg of r.segments) el.append(segmentNode(seg));
  return el;
}

/** The bound display fields of a tool / ui_action / pre_dispatch dialog, each with its badge when it has escapes. */
function boundFieldsBlock(fields: readonly BoundFieldView[]): HTMLElement | null {
  if (fields.length === 0) return null;
  return h(
    'div',
    { class: 'bound-fields', attrs: { id: 'bound-fields' } },
    ...fields.map((f) =>
      h(
        'div',
        { class: 'bound-field', attrs: { 'data-key': f.key } },
        h('div', { class: 'bound-label' }, h('span', { class: f.untrusted ? 'untrusted-label' : '', text: f.label }), f.values.some((v) => v.hiddenCharacters) ? hiddenBadge() : null),
        h('div', { class: 'bound-values', attrs: { role: 'textbox', 'aria-readonly': 'true', 'aria-label': f.label } }, ...f.values.map((v) => boundValue(v))),
      ),
    ),
  );
}

/**
 * Codex approval (CONTRACTS L221/L230/L231): escalation as its own highlighted field; the command
 * line or the path list in full in a scrollable, read-only box that wraps (no horizontal scroll),
 * never shortened, no ellipsis; cwd, escalation and paths are bound fields (escapes + badge).
 */
function codexBlock(c: CodexView): HTMLElement {
  let body: HTMLElement[];
  if (c.command !== null) body = commandBox(c.command, c.fullTextLabel);
  else {
    const paths = c.paths ?? [];
    const box = h('div', { class: 'codex-command', attrs: { id: 'codex-paths', role: 'textbox', 'aria-readonly': 'true', 'aria-multiline': 'true', tabindex: '0', 'aria-label': c.fullTextLabel } }, ...paths.map((p) => boundValue(p, 'path-line')));
    body = [h('div', { class: 'codex-label' }, h('span', { attrs: { id: 'codex-label' }, text: c.fullTextLabel }), paths.some((p) => p.hiddenCharacters) ? hiddenBadge('codex-paths-badge') : null), box];
  }
  const esc = c.escalation;
  return h(
    'div',
    { class: 'codex', attrs: { id: 'codex' } },
    esc !== null
      ? h(
          'div',
          { class: 'escalation', attrs: { id: 'codex-escalation', role: 'alert' } },
          h('strong', { text: 'Asks for more access:' }),
          esc.some((e) => e.hiddenCharacters) ? hiddenBadge('codex-escalation-badge') : null,
          ...esc.map((e) => boundValue(e, 'escalation-item')),
        )
      : null,
    ...body,
    c.workingDirectory !== null
      ? h('div', { class: 'muted codex-cwd', attrs: { id: 'codex-cwd' } }, h('span', { text: 'Folder: ' }), c.workingDirectory.hiddenCharacters ? hiddenBadge('codex-cwd-badge') : null, boundValue(c.workingDirectory, 'bound-value inline'))
      : null,
    c.networkAccess !== null ? h('p', { class: c.networkAccess ? 'net-requested' : 'muted', attrs: { id: 'codex-network' }, text: c.networkAccess ? 'Network access: requested' : 'Network access: not requested' }) : null,
  );
}

function render(view: ApprovalView | null): void {
  if (!view) {
    root.replaceChildren(h('p', { class: 'muted', text: 'No approval is waiting.' }));
    return;
  }
  const status = h('p', { class: 'muted', attrs: { id: 'approval-status', 'aria-live': 'polite' } });
  const approve = h('button', { class: 'primary', text: 'Approve', attrs: { id: 'approve', type: 'button', disabled: true } });
  const decline = h('button', { text: 'Decline', attrs: { id: 'decline', type: 'button' } });
  // Warning text comes only from main's validated record (exact D14 strings).
  const warning = view.warning ? h('div', { class: 'repeat-warning', attrs: { id: 'repeat-warning', role: 'alert' } }, h('strong', { text: view.warning.text })) : null;
  let acked = false;
  let expiredLocally = view.expired;
  let sent = false;
  let attentionReady = false;
  let attentionTimer: ReturnType<typeof setTimeout> | undefined;
  const refresh = (): void => {
    approve.disabled = sent || !approveEnabled(view, acked, expiredLocally, attentionReady);
    decline.disabled = sent || expiredLocally;
  };
  const applyGate = (): void => {
    clearTimeout(attentionTimer);
    attentionReady = false;
    if (gate?.dialogId === view.dialogId && gate.approveAfterMs !== null) {
      attentionTimer = setTimeout(() => {
        attentionReady = true;
        refresh();
      }, gate.approveAfterMs);
    }
    refresh();
  };
  onGate = applyGate;
  const decide = (decision: 'approve' | 'decline') => () => {
    if (sent) return; // one click = one request; main is idempotent too
    sent = true;
    refresh();
    void call(api.resolveApproval({ dialogId: view.dialogId, decision })).catch((e: unknown) => {
      status.textContent = e instanceof Error ? e.message : String(e);
      sent = false;
      refresh();
    });
  };
  approve.addEventListener('click', decide('approve'));
  decline.addEventListener('click', decide('decline'));
  const markExpired = (): void => {
    expiredLocally = true;
    status.textContent = 'This request expired, so nothing was done.';
    refresh();
  };
  const msLeft = Date.parse(view.expiresAt) - Date.now();
  if (view.expired || msLeft <= 0) markExpired();
  else setTimeout(markExpired, msLeft);

  const parts: Node[] = [h('h1', { text: view.title })];
  if (warning) parts.push(warning);
  parts.push(h('p', { class: 'muted', text: `Risk: ${view.risk} · expires ${new Date(view.expiresAt).toLocaleTimeString()}` }));
  if (view.codex) parts.push(codexBlock(view.codex));
  const fields = boundFieldsBlock(view.fields);
  if (fields) parts.push(fields);
  parts.push(
    h('div', { class: 'untrusted', attrs: { id: 'untrusted-summary' } }, h('span', { class: 'untrusted-label', text: view.untrustedLabel }), h('p', { class: 'summary', text: view.untrustedSummary })),
    h('div', { class: 'row' }, approve, decline),
    status,
  );
  root.replaceChildren(...parts);

  applyGate();
  if (!warning || expiredLocally) return;
  status.textContent = 'Read the warning above before approving.';
  void waitUntilVisible(warning)
    .then(() => call(api.approvalWarningShown({ dialogId: view.dialogId })))
    .then((r) => new Promise<typeof r>((resolve) => setTimeout(() => resolve(r), r.enableAfterMs)))
    .then((r) => {
      acked = r.approveEnabled;
      if (!expiredLocally) status.textContent = '';
      refresh();
    })
    .catch((e: unknown) => {
      status.textContent = e instanceof Error ? e.message : String(e);
    });
}

void call(api.getApproval())
  .then((r) => render(r.approval))
  .catch((e: unknown) => {
    root.replaceChildren(h('p', { class: 'err', text: e instanceof Error ? e.message : String(e) }));
  });
