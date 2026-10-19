/**
 * Quit semantics (spec §13.5 "Respect user Quit"):
 *  - Closing a window only hides it (tray app keeps running).
 *  - Quit from the tray sets `quitting`, stops every supervised worker (no restarts), destroys the
 *    tray and exits the process. Nothing relaunches Dottie until the next sign-in (if enabled).
 *  - No app.relaunch(), no crash-resurrection of the main process.
 */
export interface Stoppable {
  stop(): void;
}

export class QuitController {
  private quitting = false;
  private readonly stoppables = new Set<Stoppable>();

  get isQuitting(): boolean {
    return this.quitting;
  }

  register(s: Stoppable): void {
    if (this.quitting) {
      s.stop();
      return;
    }
    this.stoppables.add(s);
  }

  /** Should a window 'close' event be converted into hide? */
  shouldHideInsteadOfClose(): boolean {
    return !this.quitting;
  }

  /** Idempotent. Returns true the first time. */
  requestQuit(): boolean {
    if (this.quitting) return false;
    this.quitting = true;
    for (const s of this.stoppables) {
      try {
        s.stop();
      } catch {
        // keep stopping the rest; quitting must not be blocked by one worker
      }
    }
    this.stoppables.clear();
    return true;
  }
}
