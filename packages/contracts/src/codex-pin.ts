/** The pinned Codex release (ADR-0003). Data lives in ../codex-pin.json so the codegen scripts read the same values. */
import pin from '../codex-pin.json' with { type: 'json' };

export interface PinnedBinary {
  readonly asset: string;
  readonly file: string;
  readonly sha256: string;
  readonly provenance: string;
}

export interface CodexPin {
  readonly tag: string;
  readonly version: string;
  readonly commit: string;
  readonly assets: Readonly<Record<string, string>>;
  readonly binaries: Readonly<Record<string, PinnedBinary>>;
}

export const CODEX_PIN: CodexPin = pin;

/** Pinned binary for a Node `${process.platform}-${process.arch}` key, e.g. `linux-x64`, `win32-x64`. */
export function pinnedBinaryFor(platformKey: string): PinnedBinary | undefined {
  return CODEX_PIN.binaries[platformKey];
}
