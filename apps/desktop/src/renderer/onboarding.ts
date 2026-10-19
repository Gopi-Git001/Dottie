import { STEP_TITLES, nextStep } from '../shared/onboarding';
import { GRANTABLE_SCOPES, ONBOARDING_STEPS, type FolderGrant, type GrantableScope, type OnboardingStep, type Settings } from '../shared/settings';
import { api, call } from './api';
import { h } from './dom';

export const SCOPE_LABELS: Readonly<Record<GrantableScope, string>> = {
  'files.read': 'Read files in granted folders',
  'files.write': 'Create/modify files in granted folders',
  'shell.execute': 'Run PowerShell/CMD commands (limited working directory)',
  'desktop.control': 'Control apps and windows (UI Automation, keyboard/mouse)',
  'browser.navigate': 'Use a browser for research',
  'network.send': 'Send data to websites/services',
  'app.install': 'Install applications (always asks first)',
};

type Render = () => void;

function simBadge(simulated: boolean): HTMLElement | null {
  return simulated ? h('span', { class: 'badge sim', text: 'Simulated' }) : null;
}

export function renderOnboarding(root: HTMLElement, settings: Settings, rerender: Render, done: () => void): void {
  const completed = settings.onboarding.completedSteps;
  const step = nextStep(completed);
  if (step === null) {
    done();
    return;
  }
  const progress = h(
    'div',
    { class: 'steps' },
    ...ONBOARDING_STEPS.map((s) => h('span', { class: completed.includes(s) ? 'done' : s === step ? 'current' : '', text: STEP_TITLES[s] })),
  );
  const status = h('p', { class: 'muted' });
  const complete = async (s: OnboardingStep): Promise<void> => {
    try {
      await call(api.completeOnboardingStep({ step: s }));
      rerender();
    } catch (e) {
      status.className = 'err';
      status.textContent = (e as Error).message;
    }
  };
  const nextBtn = (label = 'Continue', enabled = true): HTMLButtonElement => {
    const b = h('button', { class: 'primary', text: label, on: { click: () => void complete(step) } });
    b.disabled = !enabled;
    return b;
  };

  const body = h('div', { class: 'card' }, h('h1', { text: STEP_TITLES[step] }));
  switch (step) {
    case 'privacy': {
      const cb = h('input', { attrs: { type: 'checkbox', id: 'ack' } });
      const btn = nextBtn('I agree, continue', false);
      cb.addEventListener('change', () => (btn.disabled = !cb.checked));
      body.append(
        h(
          'ul',
          { class: 'plain' },
          h('li', { text: 'The wake word "Dottie" is detected on this PC. Standby audio is not uploaded.' }),
          h('li', { text: 'After you say "Dottie", your spoken request is converted to text. Before speech-to-text is enabled, Dottie will tell you whether that happens on-device or in a cloud service.' }),
          h('li', { text: 'Tasks run through OpenAI Codex using your own ChatGPT account and the official sign-in. Dottie never asks for your password.' }),
          h('li', { text: 'Speech services may be billed separately; your ChatGPT plan does not necessarily cover them.' }),
          h('li', { text: 'Dottie only acts within folders and capabilities you grant. Purchases, sending messages, deleting data and installing software always need your confirmation.' }),
          h('li', { text: 'Settings and logs stay in your Windows user profile (AppData). Raw audio is never written to logs.' }),
          h('li', { text: 'Mute, pause, stop a task or quit at any time from the tray icon.' }),
        ),
        h('div', { class: 'row' }, cb, h('label', { attrs: { for: 'ack' }, text: 'I understand how Dottie uses my microphone and account.' })),
        h('div', { class: 'row' }, btn),
      );
      break;
    }
    case 'mic': {
      const select = h('select');
      const result = h('p');
      const btn = nextBtn('Continue', false);
      void call(api.listMicDevices()).then((d) => {
        for (const dev of d.devices) select.append(h('option', { attrs: { value: dev.id }, text: dev.label }));
      });
      const test = async (): Promise<void> => {
        const deviceId = select.value || null;
        await call(api.updateSettings({ audio: { micDeviceId: deviceId } }));
        const r = await call(api.testMic({ deviceId }));
        result.replaceChildren(h('span', { class: r.ok ? 'ok' : 'warn', text: `${r.ok ? 'Microphone OK' : 'No signal'} (level ${Math.round(r.peakLevel * 100)}%) ` }), simBadge(r.simulated) ?? '', h('div', { class: 'muted', text: r.message }));
        btn.disabled = false;
      };
      body.append(
        h('p', { text: 'Choose the microphone Dottie should listen with, then run a short level test. The test runs in the background voice worker, not in this window.' }),
        h('div', { class: 'row' }, select, h('button', { text: 'Test microphone', on: { click: () => void test().catch((e: unknown) => (result.textContent = (e as Error).message)) } })),
        result,
        h('div', { class: 'row' }, btn, h('button', { text: 'Skip for now', on: { click: () => void complete(step) } })),
      );
      break;
    }
    case 'signin': {
      const result = h('p');
      const refresh = async (): Promise<void> => {
        const a = await call(api.getAuth());
        result.replaceChildren(h('strong', { text: `Status: ${a.status.replace('_', ' ')} ` }), a.adapter === 'stub' ? h('span', { class: 'badge sim', text: 'Adapter pending' }) : '', h('div', { class: 'muted', text: a.message }));
      };
      void refresh();
      const signIn = async (): Promise<void> => {
        const r = await call(api.startLogin());
        const extra = r.userCode ? ` Code: ${r.userCode}` : '';
        result.append(h('div', { class: r.started ? 'ok' : 'warn', text: r.message + extra }));
      };
      body.append(
        h('p', { text: 'Dottie uses the official Codex sign-in. Your browser opens the real ChatGPT page; Dottie never shows a password box and never sees your password.' }),
        h('div', { class: 'row' }, h('button', { class: 'primary', text: 'Sign in with ChatGPT', on: { click: () => void signIn().catch((e: unknown) => (result.textContent = (e as Error).message)) } }), h('button', { text: 'Refresh status', on: { click: () => void refresh() } })),
        result,
        h('p', { class: 'muted', text: 'Without sign-in the wake word still works, but tasks will not run.' }),
        h('div', { class: 'row' }, nextBtn('Continue'), h('button', { text: 'Skip for now', on: { click: () => void complete(step) } })),
      );
      break;
    }
    case 'grants': {
      body.append(renderGrants(settings, rerender), h('p', { class: 'muted', text: 'Nothing is granted by default. You can change these any time in Settings.' }), h('div', { class: 'row' }, nextBtn('Continue')));
      break;
    }
    case 'wake': {
      const result = h('p');
      const run = async (): Promise<void> => {
        result.textContent = 'Say "Dottie"…';
        const r = await call(api.testWake());
        result.replaceChildren(h('span', { class: r.detected ? 'ok' : 'warn', text: r.detected ? 'Wake word detected ' : 'Not detected ' }), simBadge(r.simulated) ?? '', h('div', { class: 'muted', text: r.message }));
      };
      body.append(
        h('p', { text: 'Click Start, then say "Dottie" in a normal voice.' }),
        h('div', { class: 'row' }, h('button', { text: 'Start wake test', on: { click: () => void run().catch((e: unknown) => (result.textContent = (e as Error).message)) } })),
        result,
        h('div', { class: 'row' }, nextBtn('Continue'), h('button', { text: 'Skip for now', on: { click: () => void complete(step) } })),
      );
      break;
    }
    case 'autostart': {
      body.append(renderAutoStart(), h('div', { class: 'row' }, nextBtn('Finish')));
      break;
    }
  }
  root.replaceChildren(progress, body, status);
}

export function renderGrants(settings: Settings, rerender: Render): HTMLElement {
  const box = h('div');
  const msg = h('p', { class: 'muted' });
  const caps = settings.grants.capabilities;
  const capList = h('div');
  for (const scope of GRANTABLE_SCOPES) {
    const cb = h('input', { attrs: { type: 'checkbox', id: `cap-${scope}` } });
    cb.checked = caps[scope];
    cb.addEventListener('change', () => {
      void call(api.updateSettings({ capabilities: { [scope]: cb.checked } })).catch((e: unknown) => (msg.textContent = (e as Error).message));
    });
    capList.append(h('div', { class: 'row' }, cb, h('label', { attrs: { for: `cap-${scope}` }, text: SCOPE_LABELS[scope] }), h('code', { class: 'muted', text: scope })));
  }
  const folders = settings.grants.folders;
  const save = async (next: FolderGrant[]): Promise<void> => {
    await call(api.setFolderGrants({ folders: next }));
    rerender();
  };
  const folderList = h(
    'ul',
    { class: 'plain' },
    ...folders.map((f, i) =>
      h(
        'li',
        {},
        h('code', { text: f.path }),
        ` (${f.scopes.join(', ')}) `,
        h('button', { text: 'Remove', on: { click: () => void save(folders.filter((_, j) => j !== i)).catch((e: unknown) => (msg.textContent = (e as Error).message)) } }),
      ),
    ),
  );
  const add = async (write: boolean): Promise<void> => {
    const r = await call(api.pickFolder());
    if (!r.picked) return;
    await save([...folders, { path: r.picked, scopes: write ? ['files.read', 'files.write'] : ['files.read'] }]);
  };
  box.append(
    h('h2', { text: 'Folders' }),
    folders.length ? folderList : h('p', { class: 'muted', text: 'No folders granted.' }),
    h(
      'div',
      { class: 'row' },
      h('button', { text: 'Add folder (read only)…', on: { click: () => void add(false).catch((e: unknown) => (msg.textContent = (e as Error).message)) } }),
      h('button', { text: 'Add folder (read & write)…', on: { click: () => void add(true).catch((e: unknown) => (msg.textContent = (e as Error).message)) } }),
    ),
    h('h2', { text: 'Capabilities' }),
    capList,
    h('p', { class: 'muted', text: 'Credential access and purchases cannot be granted here; Dottie asks every time.' }),
    msg,
  );
  return box;
}

export function renderAutoStart(): HTMLElement {
  const box = h('div');
  const cb = h('input', { attrs: { type: 'checkbox', id: 'autostart' } });
  const note = h('p', { class: 'muted' });
  const apply = (s: { enabled: boolean; supported: boolean; note?: string | undefined }): void => {
    cb.checked = s.enabled;
    cb.disabled = !s.supported;
    note.textContent = s.note ?? 'Dottie starts in the tray when you sign in to Windows. You can also turn this off in Windows Settings > Apps > Startup.';
  };
  void call(api.getAutoStart()).then(apply);
  cb.addEventListener('change', () => {
    void call(api.setAutoStart({ enabled: cb.checked })).then(apply).catch((e: unknown) => (note.textContent = (e as Error).message));
  });
  box.append(h('div', { class: 'row' }, cb, h('label', { attrs: { for: 'autostart' }, text: 'Start Dottie when I sign in to Windows' })), note);
  return box;
}
