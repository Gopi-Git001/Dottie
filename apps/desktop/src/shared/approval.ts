/**
 * Secure approval dialog view model + IPC payloads (tool-host-control DRAFT 8 §4.4, D14, C-25;
 * E01/E08 final D14 rulings 2026-10-19).
 * Main builds the view from its own templates and the validated ApprovalRequested record; the
 * renderer only displays it and returns a decision bound to a single-use `dialogId` main minted.
 * The coordinator's `actionId` never crosses IPC.
 */
import { own } from './own';
import { z } from 'zod';
import { APPROVAL_CATEGORIES, DISPLAY_HARD_LIMITS, HIDDEN_CHAR, NO_REPEAT_CATEGORIES, PATH_LIST_MAX, PRIOR_SIDE_EFFECTS, RISK_SEVERITIES, type PriorSideEffect } from './contracts.draft';
import { BoundTextRenderSchema, CommandRenderSchema } from './commandRender';

/** Single-use, main-minted 256-bit token (not the coordinator's actionId). */
export const DialogIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Exact D14 warning strings (E01 + E08 final). Chosen ONLY from the validated
 * `possibleRepeat.priorSideEffect`; never from model, Codex, host or summary text.
 */
export const POSSIBLE_REPEAT_WARNINGS: Readonly<Record<PriorSideEffect, string>> = {
  committed: 'This action already happened; approving will do it again.',
  possible: 'This action may already have happened.',
  unknown: 'This action may already have happened.',
};
const WARNING_TEXTS = [...new Set(Object.values(POSSIBLE_REPEAT_WARNINGS))] as [string, ...string[]];

export const ApprovalWarningSchema = z.strictObject({
  priorSideEffect: z.enum(PRIOR_SIDE_EFFECTS),
  text: z.enum(WARNING_TEXTS),
});

/**
 * CONTRACTS §3 X5 approve-enable timer (ruling 1l, @ 6834524): every dialog must have been visible
 * and focused this long, continuously, before Approve. Enforced in main from window events.
 */
export const APPROVE_ATTENTION_MS = 500;
/** Push payload (main -> approval.html): when main will accept Approve for the shown dialog. */
export const ApprovalGateEventSchema = z.strictObject({
  dialogId: DialogIdSchema,
  /** 0 = now; null = the window is not visible and focused (Approve unavailable). */
  approveAfterMs: z.number().int().min(0).max(APPROVE_ATTENTION_MS).nullable(),
});
export type ApprovalGateEvent = z.infer<typeof ApprovalGateEventSchema>;

/** E08: the warning must be visible this long (after main records the renderer's confirmation) before Approve. */
export const WARNING_MIN_VISIBLE_MS = 500;

/** Label shown above the advisory summary (E08 X5: host text is untrusted). */
export const UNTRUSTED_SUMMARY_LABEL = 'Description from the task (untrusted, not checked by Dottie)';

/**
 * Codex approval block (CONTRACTS L221 @ 6834524, ruling 1o; L230/L231, ruling 1t). The command
 * line (L231 segment rendering) or the file paths (one L230 bound rendering per path) are shown IN
 * FULL in a scrollable read-only box that wraps with no horizontal scroll: never shortened, no
 * ellipsis. `escalation` is its own highlighted field. workingDirectory, escalation entries and
 * paths are bound fields: hidden characters are visible escapes with the badge, never stripped.
 * Codex's `reason` is NOT here: it goes only in the untrusted slot (`untrustedSummary`).
 */
export const CodexViewSchema = z
  .strictObject({
    kind: z.enum(['command', 'file_change']),
    /** Fixed label: "Command" or "Files (N)". */
    fullTextLabel: z.string().max(40),
    /** command: the L231 rendering built by main (segments; DOM nodes only in the renderer). null for file_change. */
    command: CommandRenderSchema.nullable(),
    /** file_change: every path, each an L230 bound rendering (1-500, never shortened). null for a command. */
    paths: z.array(BoundTextRenderSchema).min(1).max(PATH_LIST_MAX).nullable(),
    workingDirectory: BoundTextRenderSchema.nullable(),
    networkAccess: z.boolean().nullable(),
    /** Sandbox/escalation requests, each its own highlighted line; null when none. Same bounds as the display (32 entries). */
    escalation: z.array(BoundTextRenderSchema).min(1).max(DISPLAY_HARD_LIMITS.escalation.maxEntries).nullable(),
  })
  .refine((c) => (c.kind === 'command' ? c.command !== null && c.paths === null : c.command === null && c.paths !== null), 'command carries a rendering, file_change a path list');
export type CodexView = z.infer<typeof CodexViewSchema>;
/** Badge next to the command box when it contains escapes (L231). */
export const HIDDEN_CHARACTERS_BADGE = 'Contains hidden characters';
/** Visible tab marker (L231). */
export const TAB_MARKER = '\u2192';
/** Visible trailing space (L231). */
export const TRAILING_SPACE_MARKER = '\u00b7';
/** Label for the untrusted slot when it holds Codex's reason. */
export const UNTRUSTED_CODEX_REASON_LABEL = "Codex's reason (untrusted, not checked by Dottie)";

/**
 * Bound display fields for tool, ui_action and pre_dispatch dialogs (CONTRACTS X5 L230; DOT-095
 * criterion 10, UI side). Each value is an L230 bound rendering: hidden characters become visible
 * highlighted escapes and the field shows the "contains hidden characters" badge; nothing is
 * stripped. `untrusted` marks a value from model/web/app text (window title; message body, which
 * arrives stripped). Labels are main's fixed templates, never display text.
 */
export const BOUND_FIELD_KEYS = [
  'method', 'targetLabel', 'targets', 'paths', 'recipients', 'channel', 'bodyUntrusted', 'path', 'destinationHost', 'merchant', 'amount',
  'package', 'publisher', 'version', 'source', 'setting', 'currentValue', 'newValue', 'appName', 'windowTitle', 'processImage', 'retryOfTaskId',
] as const;
export type BoundFieldKey = (typeof BOUND_FIELD_KEYS)[number];
export const BoundFieldViewSchema = z.strictObject({
  key: z.enum(BOUND_FIELD_KEYS),
  label: z.string().min(1).max(60),
  values: z.array(BoundTextRenderSchema).min(1).max(PATH_LIST_MAX),
  untrusted: z.boolean(),
});
export type BoundFieldView = z.infer<typeof BoundFieldViewSchema>;

export const ApprovalViewSchema = z
  .strictObject({
    dialogId: DialogIdSchema,
    /** Main template, from the validated category (never from summary text). */
    title: z.string().max(120),
    categoryLabel: z.string().max(80),
    risk: z.enum(RISK_SEVERITIES),
    category: z.enum(APPROVAL_CATEGORIES).exclude(['credential_access']),
    expiresAt: z.iso.datetime({ offset: true }),
    /** Locally expired: shown with Approve/Decline disabled until the coordinator's outcome closes it. */
    expired: z.boolean(),
    /** Advisory host/coordinator text; always rendered under UNTRUSTED_SUMMARY_LABEL. */
    // Untrusted free text crosses IPC only stripped (ruling 1t, pinned E02 HIDDEN_CHAR set; defence in depth).
    untrustedSummary: z.string().max(2000).refine((v) => !HIDDEN_CHAR.test(v), 'untrusted free text must have hidden characters stripped'),
    untrustedLabel: z.enum([UNTRUSTED_SUMMARY_LABEL, UNTRUSTED_CODEX_REASON_LABEL]),
    /** Codex approvals only (command or file change); null otherwise. */
    codex: CodexViewSchema.nullable(),
    /** Bound display fields (tool, ui_action, pre_dispatch); [] for Codex (its block carries them). */
    fields: z.array(BoundFieldViewSchema).max(BOUND_FIELD_KEYS.length),
    /** Present only when the request carried `possibleRepeat` (never for read). */
    warning: ApprovalWarningSchema.nullable(),
  })
  .refine((v) => v.warning === null || v.warning.text === own(POSSIBLE_REPEAT_WARNINGS, v.warning.priorSideEffect), { path: ['warning', 'text'] })
  .refine((v) => !(NO_REPEAT_CATEGORIES.includes(v.category) && v.warning !== null), { path: ['warning'] });
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

export const GetApprovalResponseSchema = z.strictObject({ approval: ApprovalViewSchema.nullable() });
export const ApprovalWarningShownRequestSchema = z.strictObject({ dialogId: DialogIdSchema });
export const ApprovalWarningShownResponseSchema = z.strictObject({
  approveEnabled: z.boolean(),
  /** Remaining part of WARNING_MIN_VISIBLE_MS before main will accept Approve. */
  enableAfterMs: z.number().int().min(0).max(WARNING_MIN_VISIBLE_MS),
});
export const ApprovalDecisionSchema = z.enum(['approve', 'decline']);
export const ResolveApprovalRequestSchema = z.strictObject({ dialogId: DialogIdSchema, decision: ApprovalDecisionSchema });
export const ResolveApprovalResponseSchema = z.strictObject({ decision: ApprovalDecisionSchema });

/** Renderer page that alone may call the approval channels. */
export const APPROVAL_PAGE = '/approval.html' as const;
