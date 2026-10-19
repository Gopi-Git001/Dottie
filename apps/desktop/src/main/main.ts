/**
 * Electron main entry. Thin wiring only — logic lives in Electron-free modules that are unit tested
 * (controller, state/*, ipc/*, settings/*, lifecycle/*).
 */
import { app, dialog, ipcMain, net, powerMonitor, session, shell } from 'electron';
import { join } from 'node:path';
import { IPC_EVENTS } from '../shared/ipc';
import { isOnboardingComplete } from '../shared/onboarding';
import { DesktopController } from './controller';
import { DottieTray } from './electron/tray';
import { MainWindow } from './electron/window';
import { ApprovalWindow } from './electron/approvalWindow';
import { hardenSession, installGlobalHardening } from './electron/harden';
import { handleAppScheme, registerAppSchemePrivileges } from './electron/protocol';
import { readFlags } from './flags';
import { createIpcRouter } from './ipc/router';
import { isAllowedExternalUrl } from './ipc/trust';
import { AutoStartManager, launchedAtLogin } from './lifecycle/autostart';
import { QuitController } from './lifecycle/quit';
import { MemoryAuditSink, StubAuthAdapter, StubCoordinator, StubRuntimeStatus, StubVoiceService } from './services/stubs';
import { SettingsStore } from './settings/store';
import { type ExpectedReply, type ReplyEntry, SmokeStepAssertion, SmokeStepTimeout, SmokeSteps, clickRepliesBlame, replySequenceBlame, shortActionId } from './smoke/steps';

const SMOKE_TEST_ARG = '--dottie-smoke-test';
const SMOKE_UI_ARG = '--dottie-smoke-ui';
const NETWORK_POLL_MS = 15_000;

function log(message: string): void {
  if (!app.isPackaged) console.log(`[dottie] ${message}`);
}

// Force the sandbox for every renderer, before anything else.
app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  // Another Dottie owns the tray; it receives 'second-instance' and focuses itself.
  app.quit();
} else {
  registerAppSchemePrivileges();
  installGlobalHardening();
  void bootstrap().catch((error: unknown) => {
    // Fail visibly and exit — never spin/restart ourselves (spec §13.5).
    dialog.showErrorBox('Dottie failed to start', error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
}

async function bootstrap(): Promise<void> {
  const quit = new QuitController();
  const smokeTest = process.argv.includes(SMOKE_TEST_ARG);

  // Second launch (e.g. Start menu while tray is running): focus the existing instance.
  let focusExisting: () => void = () => undefined;
  app.on('second-instance', () => focusExisting());
  // Tray app: closing all windows must not quit.
  app.on('window-all-closed', () => undefined);
  // OS shutdown/logoff or app.quit(): stop workers, no resurrection.
  app.on('before-quit', () => quit.requestQuit());

  await app.whenReady();
  if (process.platform === 'win32') app.setAppUserModelId('com.dottie.desktop');

  const appRoot = app.getAppPath();
  const assetsDir = join(appRoot, 'assets');
  hardenSession(session.defaultSession);
  handleAppScheme(join(appRoot, 'dist', 'renderer'));

  const flags = readFlags(process.env);
  if (flags.voice === 'real') log('DOTTIE_FEATURE_VOICE=real requested but no E05 worker is registered; using stub.');
  if (flags.auth === 'real') log('DOTTIE_FEATURE_AUTH=real requested but no E02 adapter is registered; using stub.');

  const store = new SettingsStore({ dir: app.getPath('userData'), log });
  const outcome = await store.load();
  log(`settings ${outcome} at ${store.file}`);

  const coordinator = new StubCoordinator();
  const voice = new StubVoiceService();
  const auth = new StubAuthAdapter(flags.stubAuthStatus);
  // DOT-067: replace with the real Codex app-server supervisor feed (ADR-0013).
  const runtime = new StubRuntimeStatus(flags.stubRuntimeStatus);
  quit.register(voice);
  quit.register(coordinator);

  const autostart = new AutoStartManager(app, {
    platform: process.platform,
    isPackaged: app.isPackaged,
    isMsix: process.windowsStore,
    execPath: process.execPath,
    allowDev: process.env['DOTTIE_ALLOW_DEV_AUTOSTART'] === '1',
  });

  const window = new MainWindow(
    join(__dirname, '..', 'preload', 'preload.js'),
    join(assetsDir, 'icons', process.platform === 'win32' ? 'app.ico' : 'app.png'),
    quit,
    !app.isPackaged,
  );

  // Main's own window-state signal (visible + focused) feeds the approve-enable timer (CONTRACTS X5).
  let onApprovalAttention: (attentive: boolean) => void = () => undefined;
  const approvalWindow = new ApprovalWindow(
    join(__dirname, '..', 'preload', 'preload.js'),
    join(assetsDir, 'icons', process.platform === 'win32' ? 'app.ico' : 'app.png'),
    !app.isPackaged,
    (attentive) => onApprovalAttention(attentive),
  );

  let tray: DottieTray | null = null;
  const doQuit = (): void => {
    if (!quit.requestQuit()) return;
    tray?.destroy();
    approvalWindow.close();
    window.destroy();
    app.quit();
  };

  const controller = new DesktopController({
    // DOT-097 (E08) replaces this with the K8 audit store; wiring only.
    audit: new MemoryAuditSink(),
    store,
    autostart,
    auth,
    voice,
    coordinator,
    runtime,
    flags,
    hooks: {
      platform: process.platform,
      version: app.getVersion(),
      openExternal: async (url) => {
        if (!isAllowedExternalUrl(url)) throw new Error('refused non-allowlisted URL');
        await shell.openExternal(url);
      },
      pickFolder: async () => {
        const r = await dialog.showOpenDialog({ title: 'Choose a folder Dottie may use', properties: ['openDirectory'] });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      showWindow: (view) => window.show(view),
      showApproval: () => approvalWindow.show(),
      closeApproval: () => approvalWindow.close(),
      approvalGate: (e) => approvalWindow.sendGate(e),
      quit: doQuit,
    },
  });

  onApprovalAttention = (attentive) => controller.approvals.setWindowAttention(attentive);

  // IPC: every channel goes through the validating router.
  const router = createIpcRouter(controller.handlers(), { onError: (channel, error) => log(`ipc ${channel}: ${String(error)}`) });
  for (const channel of router.channels.keys()) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => router.handle(channel, event, args));
  }

  tray = new DottieTray(
    assetsDir,
    (id) => void controller.trayAction(id),
    () => window.show(isOnboardingComplete(store.get().onboarding.completedSteps) ? 'activity' : 'onboarding'),
  );
  tray.create(controller.hub.view());
  controller.hub.onChange((v) => {
    tray?.render(v);
    window.send('view', controller.appView());
  });
  controller.activity.onEntry((entry) => window.send('activity', entry));
  controller.onRuntimeStatus((event) => window.send('runtimeStatus', event));

  focusExisting = () => window.show(isOnboardingComplete(store.get().onboarding.completedSteps) ? 'settings' : 'onboarding');

  await controller.init();

  const pollNetwork = (): void => controller.setNetwork(net.isOnline() ? 'online' : 'offline');
  pollNetwork();
  const netTimer = setInterval(pollNetwork, NETWORK_POLL_MS);
  powerMonitor.on('resume', pollNetwork);
  quit.register({ stop: () => clearInterval(netTimer) });

  coordinator.set('STANDBY', false);

  if (smokeTest) {
    await runSmokeTest(window, approvalWindow, coordinator, controller, router.channels.size, outcome);
    const failed = process.exitCode === 1;
    doQuit();
    // app.quit() exits 0 regardless of process.exitCode; a failed smoke must exit non-zero.
    if (failed) app.exit(1);
    return;
  }

  const atLogin = launchedAtLogin(process.argv, app.getLoginItemSettings().wasOpenedAtLogin);
  if (!isOnboardingComplete(store.get().onboarding.completedSteps)) window.show('onboarding');
  else if (!atLogin) window.show('settings');
}

// ------------------------------------------------------------------ smoke (DOT-098: bounded steps)
/** Per-step bound: every smoke wait (window load, page script, click) gets its own timeout. */
const STEP_MS = 5_000;
/** Whole-smoke watchdog: a normal run takes ~6.5 s on the Linux box. */
const SMOKE_WATCHDOG_MS = 60_000;
/** After a closing click: time for any late duplicate reply to show up before counting. */
const CLICK_SETTLE_MS = 300;
/**
 * DOT-098 (E07 recheck): every ApprovalResolved the smoke run must send, in order. a = the repeat
 * dialog (Approve, double click), b and c = pre-dispatch reads declined display_unavailable, d = the
 * focus-timer dialog (Decline), f = the codex dialog (Decline), e = the join mismatch (fail-closed
 * decline), 9 = the bound-path dialog (Decline). The not-active-task request (8) sends nothing.
 */
const EXPECTED_REPLY_SEQUENCE: readonly ExpectedReply[] = [
  // `step` = the smoke step whose action produces the reply (DOT-099 F2 blame). b, c and e are
  // answered at request time, so their labels name the request, not a SmokeSteps step.
  { actionId: 'a'.repeat(64), approved: true, step: 'repeat.approveDoubleClick' },
  { actionId: 'b'.repeat(64), approved: false, step: 'readWithRepeat.request' },
  { actionId: 'c'.repeat(64), approved: false, step: 'readDisplayMismatch.request' },
  { actionId: 'd'.repeat(64), approved: false, step: 'timer.decline' },
  { actionId: 'f'.repeat(64), approved: false, step: 'codex.decline' },
  { actionId: 'e'.repeat(64), approved: false, step: 'joinMismatch.request' },
  { actionId: '9'.repeat(64), approved: false, step: 'bound.decline' },
];
/** DOT-099 F1: settle before the last re-check of the reply sequence, just before DOTTIE_SMOKE_OK. */
const FINAL_SETTLE_MS = 1_000;
const replyEntries = (coordinator: StubCoordinator): ReplyEntry[] => coordinator.resolutions.map((r) => ({ actionId: r.resolved.actionId, approved: r.resolved.approved }));
const smokeSteps = new SmokeSteps();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A page script as a named, bounded step. */
const js = (name: string, wc: Electron.WebContents, code: string): Promise<unknown> => smokeSteps.run(name, wc.executeJavaScript(code) as Promise<unknown>, STEP_MS);

/**
 * DOT-098 root cause: a click that resolves the last pending approval makes main destroy the
 * approval window inside that IPC handler. If the window is destroyed before the reply to the
 * page script that clicked is delivered, `executeJavaScript`'s promise never settles (seen as the
 * one-off hangs at 46a5544, edeac0b run 12 and b5dd124 run 01, and step `repeat.approveDoubleClick`
 * in the DOT-098 diagnosis run). So a closing click never awaits its own script result: it is
 * dispatched, then the smoke waits, bounded and named, for the effect main must produce (the
 * ApprovalResolved sent and the window gone). If that effect doesn't happen, the step fails.
 */
async function clickThatCloses(name: string, ownActionId: string, wc: Electron.WebContents, code: string, entries: () => ReplyEntry[], closed: () => boolean): Promise<void> {
  const before = entries().length;
  wc.executeJavaScript(code).catch(() => undefined); // result intentionally not awaited (see above)
  await smokeSteps.waitFor(name, () => (entries().length > before && closed() ? true : null), STEP_MS);
  // DOT-098 (a): settle, then require EXACTLY one reply, for this dialog's own action. DOT-099 F2:
  // a stray reply of another action is blamed as after:<its step>, not on this click.
  await sleep(CLICK_SETTLE_MS);
  const blame = clickRepliesBlame(name, ownActionId, entries().slice(before), EXPECTED_REPLY_SEQUENCE);
  if (blame !== null) throw new SmokeStepAssertion(blame.step, blame.detail);
}

/** DOT-098/099: the full ordered reply sequence must match; extra replies are blamed on their step. */
function assertReplySequence(checkName: string, coordinator: StubCoordinator): void {
  const blame = replySequenceBlame(checkName, EXPECTED_REPLY_SEQUENCE, replyEntries(coordinator));
  if (blame !== null) throw new SmokeStepAssertion(blame.step, blame.detail);
}

/** One machine-readable failure line: the step, its bound, the steps that passed and the output so far. */
function smokeFailure(reason: string, result: Record<string, unknown>, controller: DesktopController, e?: unknown): string {
  return `DOTTIE_SMOKE_FAIL ${JSON.stringify({
    reason,
    failedStep: e instanceof SmokeStepTimeout || e instanceof SmokeStepAssertion ? e.step : smokeSteps.position(),
    timeoutMs: e instanceof SmokeStepTimeout ? e.timeoutMs : reason === 'watchdog' ? SMOKE_WATCHDOG_MS : null,
    error: e instanceof Error && !(e instanceof SmokeStepTimeout) ? e.message : null,
    completedSteps: smokeSteps.completed,
    partial: result,
    activity: controller.activity.list().slice(0, 30).map((a) => a.message),
  })}`;
}

/**
 * CI/dev smoke test (never used in normal runs): boots main, optionally opens the onboarding window
 * and probes the renderer's isolation from inside the page, then prints one JSON line and quits.
 */
async function runSmokeTest(
  window: MainWindow,
  approvalWindow: ApprovalWindow,
  coordinator: StubCoordinator,
  controller: DesktopController,
  channels: number,
  settings: string,
): Promise<void> {
  const result: Record<string, unknown> = { tray: controller.appView().tray.state, channels, events: Object.keys(IPC_EVENTS).length, settings };
  // DOT-098 watchdog: if anything outside a step stalls, still fail loudly with the current step.
  const watchdog = setTimeout(() => {
    console.log(smokeFailure('watchdog', result, controller));
    app.exit(1);
  }, SMOKE_WATCHDOG_MS);
  try {
    await smokeBody(window, approvalWindow, coordinator, controller, result);
    // DOT-099 F1: a late duplicate of the LAST reply can arrive after the in-body check. Settle
    // >= 1 s, then re-check the whole sequence; nothing else runs between this and DOTTIE_SMOKE_OK.
    if (result['approval'] !== undefined) {
      await sleep(FINAL_SETTLE_MS);
      assertReplySequence('final.replySequenceSettled', coordinator);
    }
  } catch (e) {
    console.log(smokeFailure(e instanceof SmokeStepTimeout ? 'step_timeout' : e instanceof SmokeStepAssertion ? 'step_assertion' : 'error', result, controller, e));
    process.exitCode = 1;
    return;
  } finally {
    clearTimeout(watchdog);
  }
  const approval = result['approval'] as { assertionsPassed?: boolean } | undefined;
  if (approval && approval.assertionsPassed !== true) {
    console.log(`DOTTIE_SMOKE_FAIL ${JSON.stringify(result)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`DOTTIE_SMOKE_OK ${JSON.stringify(result)}`);
}

async function smokeBody(window: MainWindow, approvalWindow: ApprovalWindow, coordinator: StubCoordinator, controller: DesktopController, result: Record<string, unknown>): Promise<void> {
  if (process.argv.includes(SMOKE_UI_ARG)) {
    window.show('onboarding');
    const wc = window.webContents;
    if (wc) {
      await smokeSteps.run('renderer.didFinishLoad', new Promise<void>((resolve) => wc.once('did-finish-load', () => resolve())), STEP_MS);
      await sleep(500);
      result['renderer'] = (await js('renderer.probe', wc,
        `(async () => ({
          url: location.href,
          dottieApi: typeof window.dottie === 'object' && Object.isFrozen(window.dottie),
          apiKeys: Object.keys(window.dottie).length,
          require: typeof require,
          process: typeof process,
          ipcRendererLeak: typeof window.ipcRenderer,
          getView: (await window.dottie.getView()).ok,
          heading: document.querySelector('h1') ? document.querySelector('h1').textContent : null,
          inlineEvalBlocked: (() => { try { eval('1'); return false; } catch { return true; } })(),
        }))()`,
      ));
      const shot = process.env['DOTTIE_SMOKE_SCREENSHOT'];
      if (shot) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(shot, (await wc.capturePage()).toPNG());
      }
      // The main window must not be able to use the approval channels.
      result['mainWindowGetApproval'] = (await js('renderer.mainWindowGetApproval', wc, `window.dottie.getApproval().then((r) => r.ok ? 'ok' : r.error.code)`));
    }
    const out: Record<string, unknown> = {};
    result['approval'] = out; // filled in as it goes, so a failure report shows the partial output
    await smokeApproval(approvalWindow, coordinator, controller, out);
  }
}

/** Smoke: D14 possible-repeat dialog end to end (stub coordinator → main → approval.html → main). */
async function smokeApproval(approvalWindow: ApprovalWindow, coordinator: StubCoordinator, controller: DesktopController, out: Record<string, unknown>): Promise<void> {
  const expiry = new Date(Date.now() + 60_000).toISOString();
  const base = { taskId: 'smoke-t1', summary: 'Delete report-old.txt', risk: 'high', expiry };
  // CONTRACTS X5 tool display (rulings 1k/1l): required on every ApprovalRequested.
  const deleteDisplay = { kind: 'tool', category: 'delete', method: 'files.delete', targetLabel: 'report-old.txt', paths: ['C:\\Users\\smoke\\report-old.txt'], fileCount: '1' };
  const preDispatch = (category: string, possibleRepeat: string | null) => ({ kind: 'pre_dispatch', category, risk: 'high', possibleRepeat, retryOfTaskId: possibleRepeat === null ? null : 'smoke-t0', summaryUntrusted: base.summary });
  // DOT-098: bounded, named wait; a window that never loads fails the smoke with this step's name.
  const waitLoad = (name: string): Promise<Electron.WebContents> =>
    smokeSteps.waitFor(name, () => {
      const wc = approvalWindow.webContents;
      return wc && !wc.isLoading() && wc.getURL().endsWith('/approval.html') ? wc : null;
    }, STEP_MS, 100);
  const probe = `(() => ({
    warning: document.getElementById('repeat-warning')?.querySelector('strong')?.textContent ?? null,
    approveDisabled: document.getElementById('approve')?.disabled ?? null,
  }))()`;

  // Ruling 2e (ADR-0010): smoke-t1 is the single active task. A request for any other task (here an
  // old one) opens nothing and sends nothing; the coordinator's C-08 expiry closes it.
  coordinator.set('EXECUTING', true, 'smoke-t1');
  coordinator.requestApproval({ ...base, taskId: 'smoke-t0', actionId: '8'.repeat(64), category: 'delete', display: deleteDisplay, requestSource: 'tool_host' });
  await sleep(200);
  out['notActiveTask'] = { pending: controller.approvals.size, sent: coordinator.resolutions.length, windowOpen: approvalWindow.webContents !== null };
  coordinator.requestApproval({ ...base, actionId: 'a'.repeat(64), category: 'delete', display: deleteDisplay, requestSource: 'tool_host', possibleRepeat: { priorTaskId: 'smoke-t0', priorSideEffect: 'committed' } });
  let wc = await waitLoad('repeat.waitLoad');
  // Sample from load until Approve becomes enabled; record whether it was disabled while the
  // warning was already on screen, and try an early Approve over IPC at that moment.
  let state: { warning: string | null; approveDisabled: boolean | null } = { warning: null, approveDisabled: null };
  let disabledWithWarning = false;
  let earlyApprove: unknown = null;
  for (let i = 0; i < 60; i++) {
    state = (await js('repeat.probe', wc, probe)) as typeof state;
    if (state.warning && state.approveDisabled === true && !disabledWithWarning) {
      disabledWithWarning = true;
      earlyApprove = await js('repeat.earlyApprove', wc, 
        `window.dottie.getApproval().then((g) => window.dottie.resolveApproval({ dialogId: g.data.approval.dialogId, decision: 'approve' })).then((r) => r.ok ? 'ok' : r.error.code)`,
      );
      // D2 join while the dialog is open: same dialog, no reload.
      coordinator.requestApproval({ ...base, actionId: 'a'.repeat(64), category: 'delete', display: deleteDisplay, requestSource: 'tool_host', possibleRepeat: { priorTaskId: 'smoke-t0', priorSideEffect: 'committed' } });
    }
    if (state.approveDisabled === false) break;
    await sleep(50);
  }
  out['repeat'] = { ...state, approveDisabledWhileWarningShown: disabledWithWarning, earlyApprove, joined: controller.approvals.joinedCount('a'.repeat(64)) };
  out['forgedId'] = (await js('repeat.forgedId', wc, `window.dottie.resolveApproval({ dialogId: '${'f'.repeat(64)}', decision: 'approve' }).then((r) => r.ok ? 'ok' : r.error.code)`));
  const replies = (): ReplyEntry[] => replyEntries(coordinator);
  const closed = (): boolean => approvalWindow.webContents === null;
  await clickThatCloses('repeat.approveDoubleClick', 'a'.repeat(64), wc, `document.getElementById('approve').click(); document.getElementById('approve').click();`, replies, closed);
  out['repeatResolved'] = coordinator.resolutions.map((r) => r.resolved.approved);

  coordinator.requestApproval({ ...base, actionId: 'b'.repeat(64), category: 'read', requestSource: 'coordinator', display: preDispatch('local_change', 'possible'), possibleRepeat: { priorTaskId: 'smoke-t0', priorSideEffect: 'possible' } });
  out['readWithRepeatPending'] = controller.approvals.size;
  // A read whose display says local_change is refused (ruling 2b: display.category = event category, every kind).
  // A matching pre_dispatch/codex read WOULD open a dialog (ruling 2a); unit-tested in approval.test.ts.
  coordinator.requestApproval({ ...base, actionId: 'c'.repeat(64), category: 'read', summary: 'Read notes.txt', requestSource: 'coordinator', display: preDispatch('local_change', null) });
  out['readPending'] = controller.approvals.size;
  // Ruling 2c: both were declined to the coordinator with display_unavailable, not dropped.
  out['readDeclined'] = coordinator.resolutions.filter((r) => r.resolved.actionId === 'b'.repeat(64) || r.resolved.actionId === 'c'.repeat(64)).map((r) => `${String(r.resolved.approved)}:${String(r.resolved.reason)}`);

  coordinator.requestApproval({ ...base, actionId: 'd'.repeat(64), category: 'local_change', requestSource: 'coordinator', display: preDispatch('local_change', null) });
  wc = await waitLoad('noRepeat.waitLoad');
  await sleep(300);
  out['noRepeat'] = wc ? ((await js('noRepeat.probe', wc, probe))) : null;
  // Approve-enable timer (CONTRACTS X5): every dialog needs 500 ms visible + focused, decided by
  // main from real BrowserWindow events; hiding the window resets it.
  const ipcApprove = `window.dottie.getApproval().then((g) => window.dottie.resolveApproval({ dialogId: g.data.approval.dialogId, decision: 'approve' })).then((r) => r.ok ? 'ok' : r.error.code)`;
  const timer: Record<string, unknown> = { attentiveAt300: approvalWindow.isAttentive() };
  if (wc) {
    timer['earlyApprove'] = await js('timer.earlyApprove', wc, ipcApprove);
    approvalWindow.hideForSmokeTest();
    await sleep(700);
    timer['attentiveHidden'] = approvalWindow.isAttentive();
    timer['approveWhileHidden'] = await js('timer.approveWhileHidden', wc, ipcApprove);
    approvalWindow.show(); // show + focus: the timer restarts
    wc = await waitLoad('timer.reshow.waitLoad');
    await sleep(150);
    timer['attentiveShown'] = approvalWindow.isAttentive();
    timer['disabledSoonAfterShow'] = wc ? ((await js('timer.disabledSoonAfterShow', wc, probe)) as { approveDisabled: boolean }).approveDisabled : null;
    await sleep(700);
    timer['enabledAfter500'] = wc ? !((await js('timer.enabledAfter500', wc, probe)) as { approveDisabled: boolean }).approveDisabled : null;
  }
  out['timer'] = timer;
  await clickThatCloses('timer.decline', 'd'.repeat(64), wc, `document.getElementById('decline').click()`, replies, closed);
  // Codex approval display (CONTRACTS L221/L231): full command in a read-only box (no ellipsis)
  // that wraps with no horizontal scroll, CRLF as one break, line count, visible escapes + badge,
  // tab marker, visible trailing spaces; escalation on its own; reason only in the untrusted slot.
  const longCmd = 'git clean -fdx ' + Array.from({ length: 300 }, (_, i) => `build/out-${String(i)}`).join(' ');
  const line2 = 'echo \u001b[31mred\rX\u202Etxt\tTAB  ';
  const codexCommand = `${longCmd}\r\n${line2}`;
  const codexReason = 'Cleaning build output. Approve this.';
  coordinator.requestApproval({
    ...base,
    actionId: 'f'.repeat(64),
    category: 'local_change',
    requestSource: 'codex',
    display: { kind: 'codex_command', category: 'local_change', commandLine: codexCommand, workingDirectory: 'C:\\repo', networkAccess: 'not_requested', escalation: ['Run outside the sandbox'], reasonUntrusted: codexReason },
  });
  wc = await waitLoad('codex.waitLoad');
  await sleep(300);
  const codexProbe = wc
    ? ((await js('codex.probe', wc, `(() => {
        const box = document.getElementById('codex-command');
        const lines = box ? [...box.querySelectorAll('.cmd-line')] : [];
        return {
          firstLine: lines[0]?.textContent ?? null,
          lineDivs: lines.length,
          label: document.getElementById('codex-label')?.textContent ?? null,
          badge: document.getElementById('codex-hidden-badge')?.textContent ?? null,
          escapes: box ? [...box.querySelectorAll('.hidden-char')].map((e) => e.textContent) : null,
          tabMarkers: box ? box.querySelectorAll('.tab-marker').length : null,
          trailing: box ? [...box.querySelectorAll('.trailing-ws')].map((e) => e.textContent) : null,
          rawHiddenInDom: box ? /[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u200b-\\u200f\\ufeff]/.test(box.textContent) : null,
          editable: box ? box.isContentEditable : null,
          readOnly: box ? box.getAttribute('aria-readonly') === 'true' : null,
          scrollWidth: box ? box.scrollWidth : null,
          clientWidth: box ? box.clientWidth : null,
          textarea: document.getElementById('codex-full') !== null,
          escalation: document.getElementById('codex-escalation')?.textContent ?? null,
          untrusted: document.querySelector('#untrusted-summary .summary')?.textContent ?? null,
          title: document.querySelector('h1')?.textContent ?? null,
        };
      })()`)) as {
        firstLine: string | null;
        lineDivs: number;
        label: string | null;
        badge: string | null;
        escapes: string[] | null;
        tabMarkers: number | null;
        trailing: string[] | null;
        rawHiddenInDom: boolean | null;
        editable: boolean | null;
        readOnly: boolean | null;
        scrollWidth: number | null;
        clientWidth: number | null;
        textarea: boolean;
        escalation: string | null;
        untrusted: string | null;
        title: string | null;
      })
    : null;
  out['codex'] = codexProbe ? { ...codexProbe, firstLine: undefined, fullFirstLine: codexProbe.firstLine === longCmd, firstLineLength: codexProbe.firstLine?.length ?? 0, ellipsis: codexProbe.firstLine?.includes('\u2026') ?? null } : null;
  await clickThatCloses('codex.decline', 'f'.repeat(64), wc, `document.getElementById('decline').click()`, replies, closed);

  // Join condition (f) fail closed: a joined request with different content declines the set.
  const before = coordinator.resolutions.length;
  coordinator.requestApproval({ ...base, actionId: 'e'.repeat(64), category: 'local_change', requestSource: 'coordinator', display: preDispatch('local_change', null) });
  await waitLoad('joinMismatch.waitLoad');
  coordinator.requestApproval({ ...base, actionId: 'e'.repeat(64), category: 'local_change', summary: 'Something else', requestSource: 'coordinator', display: preDispatch('local_change', null) });
  await sleep(300);
  out['joinMismatch'] = { sent: coordinator.resolutions.slice(before).map((r) => r.resolved), pending: controller.approvals.size, windowOpen: approvalWindow.webContents !== null };
  out['resolutions'] = coordinator.resolutions.slice(0, before).map((r) => r.resolved.approved);
  out['pendingAfter'] = controller.approvals.size;

  // DOT-095 criterion 10 (CONTRACTS X5 L230): a bound path with U+202E is shown with a visible,
  // highlighted escape and the badge (never stripped, no raw override in the DOM), wrapping with no
  // horizontal scroll; the long path is shown in full.
  const rloPath = 'C:\\Users\\u\\Documents\\' + 'very-long-folder-name-'.repeat(12) + '\\invoice\u202Efdp.exe';
  coordinator.requestApproval({ ...base, actionId: '9'.repeat(64), category: 'delete', requestSource: 'tool_host', display: { kind: 'tool', category: 'delete', method: 'files.delete', targetLabel: 'invoice', paths: [rloPath], fileCount: '1' } });
  wc = await waitLoad('bound.waitLoad');
  await sleep(300);
  const boundProbe = wc
    ? ((await js('bound.probe', wc, `(() => {
        const f = document.querySelector('#bound-fields [data-key="paths"]');
        const vals = f ? f.querySelector('.bound-values') : null;
        const v = f ? f.querySelector('.bound-value') : null;
        return {
          escapes: f ? [...f.querySelectorAll('.hidden-char')].map((e) => e.textContent) : null,
          badge: f?.querySelector('.hidden-badge')?.textContent ?? null,
          text: v?.textContent ?? null,
          rawHiddenInDom: f ? /[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u200b-\\u200f\\ufeff]/.test(f.textContent) : null,
          scrollWidth: vals ? vals.scrollWidth : null,
          clientWidth: vals ? vals.clientWidth : null,
          methodBadge: document.querySelector('#bound-fields [data-key="method"] .hidden-badge') !== null,
        };
      })()`)) as { escapes: string[] | null; badge: string | null; text: string | null; rawHiddenInDom: boolean | null; scrollWidth: number | null; clientWidth: number | null; methodBadge: boolean })
    : null;
  out['boundPath'] = boundProbe;
  await clickThatCloses('bound.decline', '9'.repeat(64), wc, `document.getElementById('decline').click()`, replies, closed);
  // DOT-098 (E07 recheck): ONE check on the full ordered reply sequence (actionId, approved, count).
  // Runs after the last click's settle window, so a late duplicate from any click is counted too.
  out['replySequence'] = replyEntries(coordinator).map((r) => `${shortActionId(r.actionId)}/${String(r.approved)}`);
  assertReplySequence('final.replySequence', coordinator);
  // Hard assertions (exit 1 on failure): Approve disabled while the warning was shown, early
  // Approve refused by main, join kept one dialog, one click (even double) -> one ApprovalResolved.
  const repeatOut = out['repeat'] as { approveDisabledWhileWarningShown: boolean; earlyApprove: unknown; joined: number; warning: string | null };
  out['assertionsPassed'] =
    repeatOut.approveDisabledWhileWarningShown &&
    repeatOut.earlyApprove === 'FORBIDDEN' &&
    repeatOut.joined === 2 &&
    repeatOut.warning === 'This action already happened; approving will do it again.' &&
    JSON.stringify(out['repeatResolved']) === '[true]' &&
    out['readWithRepeatPending'] === 0 &&
    timer['attentiveAt300'] === true &&
    timer['earlyApprove'] === 'FORBIDDEN' &&
    timer['attentiveHidden'] === false &&
    timer['approveWhileHidden'] === 'FORBIDDEN' &&
    timer['attentiveShown'] === true &&
    timer['disabledSoonAfterShow'] === true &&
    timer['enabledAfter500'] === true &&
    out['readPending'] === 0 &&
    JSON.stringify(out['readDeclined']) === JSON.stringify(['false:display_unavailable', 'false:display_unavailable']) &&
    JSON.stringify(out['resolutions']) === '[true,false,false,false,false]' &&
    codexProbe !== null &&
    codexProbe.firstLine === longCmd &&
    !longCmd.includes('\u2026') &&
    codexProbe.lineDivs === 2 &&
    codexProbe.label === 'Command (2 lines)' &&
    codexProbe.badge === 'Contains hidden characters' &&
    JSON.stringify(codexProbe.escapes) === JSON.stringify(['\\x1b', '\\x0d', '<U+202E>']) &&
    codexProbe.tabMarkers === 1 &&
    JSON.stringify(codexProbe.trailing) === JSON.stringify(['\u00b7\u00b7']) &&
    codexProbe.rawHiddenInDom === false &&
    codexProbe.editable === false &&
    codexProbe.readOnly === true &&
    !codexProbe.textarea &&
    codexProbe.scrollWidth !== null &&
    codexProbe.clientWidth !== null &&
    codexProbe.clientWidth > 0 &&
    codexProbe.scrollWidth <= codexProbe.clientWidth &&
    codexProbe.escalation === 'Asks for more access:Run outside the sandbox' &&
    codexProbe.untrusted === codexReason &&
    codexProbe.title === 'Approve: Change something on this PC?' &&
    out['pendingAfter'] === 0 &&
    JSON.stringify((out['joinMismatch'] as { sent: unknown[] }).sent.map((r) => ({ ...(r as object), timestamp: undefined }))) === JSON.stringify([{ actionId: 'e'.repeat(64), approved: false, reason: 'display_unavailable' }]) &&
    (out['joinMismatch'] as { pending: number; windowOpen: boolean }).pending === 0 &&
    !(out['joinMismatch'] as { windowOpen: boolean }).windowOpen &&
    boundProbe !== null &&
    JSON.stringify(boundProbe.escapes) === JSON.stringify(['<U+202E>']) &&
    boundProbe.badge === 'Contains hidden characters' &&
    boundProbe.text === rloPath.replace('\u202E', '<U+202E>') &&
    boundProbe.rawHiddenInDom === false &&
    !boundProbe.methodBadge &&
    boundProbe.clientWidth !== null &&
    boundProbe.clientWidth > 0 &&
    boundProbe.scrollWidth !== null &&
    boundProbe.scrollWidth <= boundProbe.clientWidth &&
    JSON.stringify(out['notActiveTask']) === JSON.stringify({ pending: 0, sent: 0, windowOpen: false }) &&
    controller.approvals.size === 0;
  coordinator.set('STANDBY', false);
}
