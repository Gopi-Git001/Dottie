/**
 * `codex_command` rendering (CONTRACTS §3 X5 L231 @ 1f3ac60, ruling 1t; E08 co-signed).
 * Pure; main builds these segments into the view and the renderer turns them into DOM nodes with
 * textContent only (never innerHTML). Same segment model as E02's display.ts (DOT-095 helpers).
 *
 *  1. `\n` is a real line break and the line count is shown; `\r\n` → `\n` for DISPLAY ONLY
 *     (Codex executes, and displayHash covers, the raw bytes; this never touches the display object).
 *  2. Nothing is stripped: every other control character, a lone `\r`, bidi controls and invisible
 *     format characters become a visible escape (`\x1b`, `<U+202E>`) and set the
 *     "contains hidden characters" badge. Tab is a visible tab marker (layout: no badge).
 *  3. Long lines wrap (renderer CSS, no horizontal scroll); trailing spaces are a visible segment.
 *  4. The 8 KB limit counts the RAW command bytes (schema); escapes don't count at their rendered length.
 *
 * Bound fields (CONTRACTS L230, ruling 1t; DOT-095 criterion 10, E02 2581593 `renderBoundText`):
 * paths, workingDirectory, escalation, method, labels, app name, window title, process image and
 * every other bound value are rendered with the SAME segment model, on one line: every hidden
 * character, INCLUDING tab, LF and CR, is a visible highlighted escape (no tab marker, no line
 * breaks) and sets the badge; trailing spaces are visible. Never stripped; the value is never modified.
 */
import { z } from 'zod';
import { COMMAND_MAX_BYTES, HIDDEN_CHAR } from './contracts.draft';

export type RenderSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'escape'; readonly text: string; readonly codePoint: number }
  | { readonly kind: 'tab' }
  | { readonly kind: 'trailing_whitespace'; readonly text: string };

export interface CommandRender {
  lines: RenderSegment[][];
  lineCount: number;
  /** Drives the "contains hidden characters" badge. */
  hiddenCharacters: boolean;
}

/** `\x1b` for C0/DEL/C1 controls, `<U+202E>` for every other hidden character (CONTRACTS examples). */
export function hiddenCharEscape(cp: number): string {
  return cp <= 0x9f ? `\\x${cp.toString(16).padStart(2, '0')}` : `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
}

function renderLine(s: string, tabMarker = true): { segments: RenderSegment[]; hidden: boolean } {
  const segments: RenderSegment[] = [];
  let hidden = false;
  let buf = '';
  const flush = (): void => {
    if (buf) segments.push({ kind: 'text', text: buf });
    buf = '';
  };
  for (const ch of s) {
    if (tabMarker && ch === '\t') {
      flush();
      segments.push({ kind: 'tab' });
    } else if (HIDDEN_CHAR.test(ch)) {
      flush();
      hidden = true;
      const cp = ch.codePointAt(0) ?? 0;
      segments.push({ kind: 'escape', text: hiddenCharEscape(cp), codePoint: cp });
    } else buf += ch;
  }
  flush();
  const last = segments[segments.length - 1];
  if (last?.kind === 'text') {
    const m = / +$/.exec(last.text);
    if (m) {
      segments.pop();
      if (m.index > 0) segments.push({ kind: 'text', text: last.text.slice(0, m.index) });
      segments.push({ kind: 'trailing_whitespace', text: m[0] });
    }
  }
  return { segments, hidden };
}

export function renderCodexCommand(command: string): CommandRender {
  let hidden = false;
  const lines = command
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const r = renderLine(line);
      hidden ||= r.hidden;
      return r.segments;
    });
  return { lines, lineCount: lines.length, hiddenCharacters: hidden };
}

/** A rendered bound one-line field (L230). */
export interface BoundTextRender {
  segments: RenderSegment[];
  /** Drives the "contains hidden characters" badge. */
  hiddenCharacters: boolean;
}

/** A bound one-line field (path, label, window title, …): every hidden character, incl. tab and newline, is an escape. */
export function renderBoundText(s: string): BoundTextRender {
  const r = renderLine(s, false);
  return { segments: r.segments, hiddenCharacters: r.hidden };
}

/** Inverse of renderBoundText, for tests: the exact original value. */
export function textFromBound(r: BoundTextRender): string {
  return r.segments.map((s) => (s.kind === 'tab' ? '\t' : s.kind === 'escape' ? String.fromCodePoint(s.codePoint) : s.text)).join('');
}

/** Inverse of the display transform, for tests: segments → the command with only CRLF → LF applied. */
export function commandFromRender(r: CommandRender): string {
  return r.lines.map((l) => l.map((s) => (s.kind === 'tab' ? '\t' : s.kind === 'escape' ? String.fromCodePoint(s.codePoint) : s.text)).join('')).join('\n');
}

// --------------------------------------------------------------------------- view schema
/** A text run never carries a hidden character or a line break: those are escapes or line splits. */
const TextSegmentSchema = z.strictObject({
  kind: z.literal('text'),
  text: z
    .string()
    .min(1)
    .max(COMMAND_MAX_BYTES)
    .refine((v) => !HIDDEN_CHAR.test(v), 'a text run never contains a hidden character'),
});
const EscapeSegmentSchema = z
  .strictObject({ kind: z.literal('escape'), text: z.string().regex(/^(\\x[0-9a-f]{2}|<U\+[0-9A-F]{4,6}>)$/), codePoint: z.number().int().min(0).max(0x10ffff) })
  .refine((s) => s.text === hiddenCharEscape(s.codePoint), 'escape text must match its code point');
export const RenderSegmentSchema = z.union([TextSegmentSchema, EscapeSegmentSchema, z.strictObject({ kind: z.literal('tab') }), z.strictObject({ kind: z.literal('trailing_whitespace'), text: z.string().regex(/^ +$/).max(COMMAND_MAX_BYTES) })]);
export const CommandRenderSchema = z
  .strictObject({
    lines: z.array(z.array(RenderSegmentSchema).max(COMMAND_MAX_BYTES)).min(1).max(COMMAND_MAX_BYTES + 1),
    lineCount: z.number().int().min(1),
    hiddenCharacters: z.boolean(),
  })
  .refine((r) => r.lineCount === r.lines.length, 'lineCount must equal the number of lines')
  .refine((r) => r.hiddenCharacters === r.lines.some((l) => l.some((s) => s.kind === 'escape')), 'the badge flag must match the escapes');

/** Bound field view (L230): one line, no tab segments (tab is an escape here), badge flag matches the escapes. */
export const BOUND_TEXT_MAX = COMMAND_MAX_BYTES;
export const BoundTextRenderSchema = z
  .strictObject({
    segments: z.array(RenderSegmentSchema).max(BOUND_TEXT_MAX),
    hiddenCharacters: z.boolean(),
  })
  .refine((r) => r.segments.length > 0, 'a bound value is never empty')
  .refine((r) => r.segments.every((s) => s.kind !== 'tab'), 'a bound field escapes tab (no tab marker)')
  .refine((r) => r.hiddenCharacters === r.segments.some((s) => s.kind === 'escape'), 'the badge flag must match the escapes');
