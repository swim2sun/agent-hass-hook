# Design: Quiet hours (time-window hook silencing)

Date: 2026-06-16
Status: Approved (design OK'd in chat)

## Problem

Users want the hook to stay silent during certain parts of the day — e.g. don't
drive the lights between 09:00 and 18:00. Today the only disable mechanisms are
the `AGENT_HASS_HOOK_DISABLE=1` env switch (per-session) and the `.no-hass-hook`
marker (per-project). Neither is time-based.

## Decisions (confirmed)

- **Multiple daily windows, with overnight support.** A list of `{start, end}`
  windows. Falling inside *any* window silences the hook.
- **Configured via both the wizard (optional step) and hand-editing config.json.**
- **Evaluated in the machine's local timezone** (no per-rule timezone field —
  YAGNI). Note: this host is `Etc/UTC`, so windows are UTC here.
- **Inclusive of start, exclusive of end** (`09:00–18:00` = 09:00:00 through
  17:59:59).
- **`start == end` is a zero-length window** (never matches) — avoids an
  accidental all-day silence.
- Missing key / empty array → feature off (current behavior unchanged).

## Config schema (`config.json`, new optional top-level key)

```jsonc
"quiet_hours": [
  { "start": "09:00", "end": "18:00" },
  { "start": "22:00", "end": "07:00" }   // end < start → wraps past midnight
]
```

- `start`/`end`: `"HH:MM"`, 24-hour, `00:00`–`23:59`.
- Overnight: when `end < start`, the window spans midnight (active if
  `now >= start` OR `now < end`).
- Same-day: when `start < end`, active if `start <= now < end`.

## Architecture

### New module `src/quietHours.ts` (pure, testable)

```
export interface QuietWindow { start: string; end: string; }
export function isWithinQuietHours(now: Date, windows: QuietWindow[]): { active: boolean; window?: string };
```

- Converts `now` to local minutes-of-day (`getHours()*60 + getMinutes()`).
- Parses each window's `HH:MM` to minutes; applies same-day vs overnight rule;
  `start == end` → skip.
- Returns the first matching window's `"HH:MM-HH:MM"` label for logging.
- `now` is injected (a `Date`) so tests are deterministic.

### `src/config.ts`

- Parse optional `quiet_hours` into `Config.quietHours: QuietWindow[]` (default `[]`).
- Validate: must be an array; each entry an object with `start`/`end` strings
  matching `^\d{2}:\d{2}$` and in range `00:00`–`23:59`. Anything malformed →
  `ConfigError` (which dispatch already catches → returns 0).

### `src/dispatch.ts`

Insert the check **after** the empty-event fast path and **before** constructing
the circuit breaker:

```
env disable → marker → load config
  → actions = events[event]; if empty → return 0           (existing)
  → if isWithinQuietHours(new Date(), cfg.quietHours).active:
        logger.log({ event, cwd, result: "skipped", reason: "quiet_hours", window })
        return 0                                            (NEW — before breaker)
  → breaker check → call HA …                               (existing)
```

No HA call, no breaker state written during quiet hours.

### Configurator (`src/configurator.ts`)

- After the preset step, add one optional prompt: free-text like
  `09:00-18:00, 22:00-07:00` (comma-separated `HH:MM-HH:MM` ranges; empty = none).
- A pure helper `parseQuietHours(input: string): QuietWindow[]` parses/validates
  the text (reject malformed ranges with a clear message; allow empty → `[]`).
- `renderConfigJson` gains an optional `quietHours` arg; when non-empty it writes
  `quiet_hours` into the config object.

## Logging

Quiet-hours skips append one JSONL line:
`{"ts":…,"event":…,"cwd":…,"result":"skipped","reason":"quiet_hours","window":"09:00-18:00"}`.

## Testing

- `quietHours`: inside/outside a same-day window; start boundary (inclusive) and
  end boundary (exclusive); overnight wrap (before midnight + after midnight +
  outside); multiple windows; empty list → never active; `start == end` → never
  active.
- `config`: valid `quiet_hours` parses to `quietHours`; malformed (bad format,
  out-of-range hour/minute, non-array, non-object entry) → `ConfigError`; missing
  key → `[]`.
- `dispatch`: within quiet hours → `skipped`/`quiet_hours` logged, HA NOT called,
  no `breaker.json`; outside → HA called normally. `runHook` reads the real clock
  (`new Date()`), so the test computes the window from the current time at
  runtime — e.g. a window spanning `now-1min … now+1min` for the "within" case and
  `now+10min … now+20min` for the "outside" case (handle day wrap when formatting
  `HH:MM`). Use a mock HA server as the existing dispatch tests do.
- `configurator`: `parseQuietHours` valid + invalid + empty; `renderConfigJson`
  includes `quiet_hours` when provided and omits it when empty.

## Out of scope (YAGNI)

- Per-rule timezones / a global timezone field.
- Day-of-week selection.
- An "only enabled during" (inverse) mode.

## Release

New feature → bump minor (`0.1.0` → `0.2.0`) and publish per the established
[[npm-release-process]] after local testing passes.
