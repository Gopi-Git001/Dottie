/** CONTRACTS §3 X5 L231 @ 1f3ac60 (ruling 1t; E08 co-signed): codex_command rendering. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandRenderSchema, commandFromRender, hiddenCharEscape, renderCodexCommand } from '../src/shared/commandRender';
import { CodexCommandDisplaySchema } from '../src/shared/contracts.draft';

const esc = (r: ReturnType<typeof renderCodexCommand>) => r.lines.flat().filter((s) => s.kind === 'escape').map((s) => (s as { text: string }).text);

describe('renderCodexCommand', () => {
  it.each([
    ['ESC', 'printf \u001b[2J', '\\x1b'],
    ['a lone CR', 'echo safe\rrm -rf ~', '\\x0d'],
    ['U+202E', 'run invoice\u202Efdp.exe', '<U+202E>'],
    ['zero-width space', 'rm\u200B -rf', '<U+200B>'],
    ['BOM', '\uFEFFgit status', '<U+FEFF>'],
    ['soft hyphen', 'cu\u00ADrl x', '<U+00AD>'],
    ['DEL', 'a\u007Fb', '\\x7f'],
    ['C1 control', 'a\u009Bb', '\\x9b'],
    ['tag character', 'a\u{E0041}b', '<U+E0041>'],
  ])('%s renders as a visible escape and sets the badge; nothing is stripped', (_n, cmd, shown) => {
    const r = renderCodexCommand(cmd);
    expect(esc(r)).toEqual([shown]);
    expect(r.hiddenCharacters).toBe(true);
    expect(commandFromRender(r)).toBe(cmd);
    expect(CommandRenderSchema.safeParse(r).success).toBe(true);
  });
  it('\\n is a real line break and the line count is reported', () => {
    const r = renderCodexCommand('cd C:\\repo\nnpm ci\nnpm test');
    expect(r.lineCount).toBe(3);
    expect(r.lines).toEqual([[{ kind: 'text', text: 'cd C:\\repo' }], [{ kind: 'text', text: 'npm ci' }], [{ kind: 'text', text: 'npm test' }]]);
    expect(r.hiddenCharacters).toBe(false);
  });
  it('CRLF displays as ONE break (no escape, no badge); the raw command is not modified', () => {
    const raw = 'a\r\nb';
    const r = renderCodexCommand(raw);
    expect(r.lineCount).toBe(2);
    expect(esc(r)).toEqual([]);
    expect(r.hiddenCharacters).toBe(false);
    expect(raw).toBe('a\r\nb');
    expect(commandFromRender(r)).toBe('a\nb');
  });
  it('CR CR LF: the extra CR is a lone CR, shown as an escape', () => {
    const r = renderCodexCommand('a\r\r\nb');
    expect(r.lineCount).toBe(2);
    expect(esc(r)).toEqual(['\\x0d']);
  });
  it('tab is a visible tab marker (layout: no badge)', () => {
    const r = renderCodexCommand('a\tb');
    expect(r.lines[0]).toEqual([{ kind: 'text', text: 'a' }, { kind: 'tab' }, { kind: 'text', text: 'b' }]);
    expect(r.hiddenCharacters).toBe(false);
  });
  it('trailing whitespace is a visible segment, per line', () => {
    const r = renderCodexCommand('echo hi   \nls  ');
    expect(r.lines).toEqual([
      [
        { kind: 'text', text: 'echo hi' },
        { kind: 'trailing_whitespace', text: '   ' },
      ],
      [
        { kind: 'text', text: 'ls' },
        { kind: 'trailing_whitespace', text: '  ' },
      ],
    ]);
    expect(renderCodexCommand('   ').lines).toEqual([[{ kind: 'trailing_whitespace', text: '   ' }]]);
  });
  it('empty lines are kept (blank line between commands)', () => {
    const r = renderCodexCommand('a\n\nb\n');
    expect(r.lineCount).toBe(4);
    expect(r.lines[1]).toEqual([]);
    expect(r.lines[3]).toEqual([]);
  });
  it('escape formats are the CONTRACTS examples', () => {
    expect(hiddenCharEscape(0x1b)).toBe('\\x1b');
    expect(hiddenCharEscape(0x202e)).toBe('<U+202E>');
  });
  it('the view schema rejects a text run hiding a character, a forged escape, or a wrong badge flag/line count', () => {
    const ok = renderCodexCommand('a\u001bb');
    expect(CommandRenderSchema.safeParse(ok).success).toBe(true);
    expect(CommandRenderSchema.safeParse({ ...ok, lines: [[{ kind: 'text', text: 'a\u202Eb' }]], hiddenCharacters: false }).success).toBe(false);
    expect(CommandRenderSchema.safeParse({ ...ok, lines: [[{ kind: 'escape', text: '<U+202E>', codePoint: 0x41 }]] }).success).toBe(false);
    expect(CommandRenderSchema.safeParse({ ...ok, hiddenCharacters: false }).success).toBe(false);
    expect(CommandRenderSchema.safeParse({ ...ok, lineCount: 2 }).success).toBe(false);
    expect(CommandRenderSchema.safeParse({ ...ok, lines: [[{ kind: 'text', text: '<b>x</b>', html: true }]] }).success).toBe(false);
  });
});

describe('codex_command schema (ruling 1t; bound fields relaxed by DOT-095 criterion 10)', () => {
  const cmd = { kind: 'codex_command', category: 'local_change', commandLine: 'x', workingDirectory: 'C:\\repo', networkAccess: 'not_requested', escalation: [], reasonUntrusted: null };
  it('accepts ESC, lone CR, U+202E, CRLF, tab, BOM, soft hyphen in the command', () => {
    for (const c of ['\u001b[0m', 'a\rb', 'a\u202Eb', 'a\r\nb', 'a\tb', '\uFEFFa', 'a\u00ADb']) expect(CodexCommandDisplaySchema.safeParse({ ...cmd, commandLine: c }).success).toBe(true);
  });
  it('the 8 KB limit counts raw UTF-8 bytes: 8192 ESC ok, 8193 rejected (display_unavailable), 2731 x U+202E (8193 bytes) rejected', () => {
    expect(CodexCommandDisplaySchema.safeParse({ ...cmd, commandLine: '\u001b'.repeat(8192) }).success).toBe(true);
    expect(CodexCommandDisplaySchema.safeParse({ ...cmd, commandLine: '\u001b'.repeat(8193) }).success).toBe(false);
    expect(CodexCommandDisplaySchema.safeParse({ ...cmd, commandLine: '\u202E'.repeat(2730) + 'xxx' }).success).toBe(false);
    expect(CodexCommandDisplaySchema.safeParse({ ...cmd, commandLine: '\u202E'.repeat(2730) + 'xx' }).success).toBe(true);
  });
  it('workingDirectory and escalation are bound fields: hidden characters accepted (escaped when rendered, DOT-095 criterion 10); reasonUntrusted is untrusted free text and must arrive stripped', () => {
    expect(CodexCommandDisplaySchema.safeParse({ ...cmd, workingDirectory: 'C:\\a\u202Eb' }).success).toBe(true);
    expect(CodexCommandDisplaySchema.safeParse({ ...cmd, escalation: ['a\u001bb'] }).success).toBe(true);
    expect(CodexCommandDisplaySchema.safeParse({ ...cmd, reasonUntrusted: 'a\u202Eb' }).success).toBe(false);
  });
});

describe('renderer: DOM nodes only, never innerHTML', () => {
  it('no renderer source uses innerHTML / outerHTML / insertAdjacentHTML / document.write', () => {
    const dir = join(__dirname, '..', 'src', 'renderer');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.html'));
    expect(files).toContain('approval.ts');
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    }
  });
});
