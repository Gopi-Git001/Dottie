# DOT-065: E08 change request on PR #101 (head 6ed7f0e)

Raw output: `checks.txt`, run Mon 2026-10-19 13:24 CDT (UTC-5) on the box.

- Item 2 (`navigate` row): done. Added as a new row (plan L197). It cites ADR-0009 item 8, because main defines the `navigate` exception there; ADR-0017 only rules out recovery reuse.
- Item 3 (severity is only a floor, category decides, unmapped means DENIED_BY_POLICY): done (L196).
- Item 4 (`unknown`: may have run, no automatic retry, new approval plus DOT-094 warning, audit records `sideEffect=unknown`): done (L200).
- Item 1 (rename the categories to send/upload/install): **NOT applied.** The enum E08 gave is not on main. Main's canonical category enum is ADR-0012 L43 (`external_send | external_upload | install_or_elevate`, no `send`/`upload`/`install`/`desktop`). ADR-0009 item 8 and CONTRACTS L222 use the same names, and ADR-0009's X5 amendment is about the approval display, not the enum. No C10 alias table exists on main. Renaming would make the plan contradict the accepted ADRs, so this needs an E01/E08 ruling (an ADR-0012 change) first.
- L194, L198 (forbidden; it was L197 before the new row) and L199 (NEEDS_APPROVAL; it was L198) are unchanged. AC1–6 pass: NEEDS_APPROVAL/ATTEMPTED appear only at L199–200 (the mapping table). Tests: 748 passed, 4 xfailed. Secret sweep: 0 hits.
