/** Renderer entry: hash router over three views, driven by window.dottie only. */
import { own } from '../shared/own';
import type { ActivityEntry, AppView, NavigateTarget } from '../shared/ipc';
import { isOnboardingComplete } from '../shared/onboarding';
import { api, call } from './api';
import { h } from './dom';
import { renderAutoStart, renderGrants, renderOnboarding } from './onboarding';

const root = document.getElementById('app') as HTMLElement;
const banner = document.getElementById('banner') as HTMLElement;
const dot = document.getElementById('status-dot') as HTMLElement;
const statusLabel = document.getElementById('status-label') as HTMLElement;
const runtimeNote = document.getElementById('runtime-note') as HTMLElement;

const VIEWS: readonly NavigateTarget[] = ['onboarding', 'settings', 'activity'];

function currentView(): NavigateTarget {
  const v = location.hash.replace('#', '');
  return (VIEWS as readonly string[]).includes(v) ? (v as NavigateTarget) : 'settings';
}

function showError(e: unknown): void {
  banner.hidden = false;
  banner.textContent = e instanceof Error ? e.message : String(e);
}

function applyRuntime(status: AppView['tray']['snapshot']['runtime']): void {
  const notes: Partial<Record<typeof status, string>> = {
    waiting_for_env: '· Codex unavailable (waiting for environment)',
    breaker_open: '· Codex stopped after repeated failures',
    backoff: '· Reconnecting to Codex…',
    half_open: '· Reconnecting to Codex…',
  };
  runtimeNote.textContent = own(notes, status) ?? '';
}

function applyView(v: AppView): void {
  applyRuntime(v.tray.snapshot.runtime);
  dot.className = `dot ${v.tray.state}`;
  statusLabel.textContent = `— ${v.tray.label}`;
  dot.title = v.tray.tooltip;
  const stubs = [v.flags.voice === 'stub' ? 'voice' : null, v.flags.auth === 'stub' ? 'sign-in' : null].filter(Boolean);
  banner.hidden = stubs.length === 0;
  banner.textContent = stubs.length ? `Preview build: ${stubs.join(' and ')} integration not connected yet; related tests are simulated.` : '';
}

async function renderSettings(): Promise<void> {
  const [settings, view, auth] = await Promise.all([call(api.getSettings()), call(api.getView()), call(api.getAuth())]);
  const s = view.tray.snapshot;
  const sens = h('input', { attrs: { type: 'range', min: '0', max: '1', step: '0.05' } });
  sens.value = String(settings.audio.wakeSensitivity);
  sens.addEventListener('change', () => void call(api.updateSettings({ audio: { wakeSensitivity: Number(sens.value) } })).catch(showError));
  const speak = h('input', { attrs: { type: 'checkbox', id: 'speak' } });
  speak.checked = settings.audio.speakResponses;
  speak.addEventListener('change', () => void call(api.updateSettings({ audio: { speakResponses: speak.checked } })).catch(showError));
  const control = (action: Parameters<typeof api.control>[0]['action']) => () => void call(api.control({ action })).then(() => renderSettings()).catch(showError);

  root.replaceChildren(
    h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Status' }),
      h('p', { text: view.tray.tooltip }),
      h(
        'div',
        { class: 'row' },
        h('button', { text: s.muted ? 'Unmute' : 'Mute', on: { click: control(s.muted ? 'unmute' : 'mute') } }),
        h('button', { text: s.paused ? 'Resume' : 'Pause', on: { click: control(s.paused ? 'resume' : 'pause') } }),
        view.menu.find((m) => m.id === 'reconnect')?.enabled ? h('button', { text: 'Reconnect ChatGPT', on: { click: control('reconnect') } }) : null,
        // Unsupported account: message + Sign out / Switch account (handled by main via the auth adapter).
        view.menu.find((m) => m.id === 'sign_out')?.visible ? h('p', { text: "This ChatGPT account can't run Codex." }) : null,
        view.menu.find((m) => m.id === 'sign_out')?.enabled ? h('button', { text: 'Sign out', on: { click: control('sign_out') } }) : null,
        view.menu.find((m) => m.id === 'switch_account')?.enabled ? h('button', { text: 'Switch account', on: { click: control('switch_account') } }) : null,
        view.menu.find((m) => m.id === 'retry')?.enabled ? h('button', { text: 'Retry Codex', on: { click: control('retry') } }) : null,
        view.menu.find((m) => m.id === 'stop_task')?.enabled ? h('button', { text: 'Stop task', on: { click: control('stop_task') } }) : null,
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', { text: 'ChatGPT account' }),
      h('p', { text: `${auth.status.replace('_', ' ')} — ${auth.message}` }),
      h('div', { class: 'row' }, h('button', { text: 'Sign in with ChatGPT', on: { click: () => void call(api.startLogin()).then(() => renderSettings()).catch(showError) } }), h('button', { text: 'Sign out', on: { click: () => void call(api.logout()).then(() => renderSettings()).catch(showError) } })),
    ),
    h('div', { class: 'card' }, h('h2', { text: 'Voice' }), h('div', { class: 'row' }, h('label', { text: 'Wake sensitivity' }), sens), h('div', { class: 'row' }, speak, h('label', { attrs: { for: 'speak' }, text: 'Speak responses' }))),
    h('div', { class: 'card' }, h('h2', { text: 'Start at sign-in' }), renderAutoStart()),
    h('div', { class: 'card' }, renderGrants(settings, () => void renderSettings().catch(showError))),
    h('p', { class: 'muted', text: `Dottie ${view.version} · ${view.platform}` }),
  );
}

function activityItem(e: ActivityEntry): HTMLElement {
  const cls = e.level === 'error' ? 'err' : e.level === 'warning' ? 'warn' : '';
  return h('li', {}, h('span', { class: 'muted', text: new Date(e.at).toLocaleTimeString() + ' ' }), h('span', { class: cls, text: e.message }));
}

async function renderActivity(): Promise<void> {
  const { entries } = await call(api.listActivity());
  const list = h('ul', { class: 'activity', attrs: { id: 'activity-list' } }, ...entries.map(activityItem));
  root.replaceChildren(h('div', { class: 'card' }, h('h2', { text: 'Activity' }), entries.length ? list : h('p', { class: 'muted', text: 'No activity yet.' })));
}

async function route(): Promise<void> {
  const view = currentView();
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', a.getAttribute('data-view') === view);
  const settings = await call(api.getSettings());
  const onboarded = isOnboardingComplete(settings.onboarding.completedSteps);
  (document.querySelector('nav') as HTMLElement).hidden = !onboarded;
  if (!onboarded || view === 'onboarding') {
    const rerender = (): void => void call(api.getSettings()).then((s) => renderOnboarding(root, s, rerender, () => (location.hash = '#settings'))).catch(showError);
    renderOnboarding(root, settings, rerender, () => (location.hash = '#settings'));
    return;
  }
  if (view === 'activity') await renderActivity();
  else await renderSettings();
}

api.on('view', applyView);
api.on('runtimeStatus', ({ status }) => {
  applyRuntime(status);
});
api.on('navigate', ({ view }) => {
  if (location.hash === `#${view}`) void route().catch(showError);
  else location.hash = `#${view}`;
});
api.on('activity', (entry) => {
  const list = document.getElementById('activity-list');
  if (list) list.prepend(activityItem(entry));
});
window.addEventListener('hashchange', () => void route().catch(showError));
void call(api.getView()).then(applyView).catch(showError);
void route().catch(showError);
