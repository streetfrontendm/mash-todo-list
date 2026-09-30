# Mash Todo List

A todo list with an assistant that can actually edit it. Plain HTML, CSS and
JavaScript — **no build step, no dependencies, nothing to install**. Open
`index.html` in a browser and it works, including a fully offline assistant.

```
todo-ai/
├── index.html     the app (markup + panels)
├── styles.css     dark/light theme, no framework
├── store.js       dates, todo helpers, persistent store with undo
├── nlp.js         natural-language parsing + the offline assistant
├── ai.js          provider config, prompt/schema, remote chat, action runner
├── app.js         DOM wiring: rendering, events, settings, chat, shortcuts
├── sw.js          service worker: offline support (served over http)
├── icon.svg       installable-app icon (maskable + any)
├── manifest.webmanifest  install metadata: name, theme, icon
├── tests.html     engine tests (store + nlp + ai) — 30 tests
├── tests.js       the engine test suite
├── uitest.html    UI integration tests that drive index.html in an iframe
├── uitest.js      the UI test suite
├── serve.ps1      tiny static server (this machine has no Node or Python)
└── README.md
```

## Quick start

1. **Just open it:** double-click `index.html`. Everything except free-form
   chat with a hosted model works offline (tasks are saved in `localStorage`).
2. **Optional local server** (needed for the UI tests, and handy if your
   browser restricts `file://` storage):

   ```powershell
   powershell -ExecutionPolicy Bypass -File serve.ps1
   # then open http://localhost:8080/
   ```

On first run the app seeds four demo tasks (one overdue, one due tomorrow, one
repeating, one undated) so there is something to play with. Delete them and the
seed never comes back.

## The todo list

- Add, edit inline, complete/reopen, delete.
- Priority (low / medium / high), due dates, tags, notes.
- Repeating tasks (`daily` / `weekly`) roll their due date forward instead of
  closing for good.
- Filters (All / Active / Done / Today), search, and sorting: `smart`
  (overdue first, then priority), due date, priority, newest, A–Z.
- One-step **Undo** for the last change (including assistant edits).
- **Export / Import** the whole list as JSON (import merges and skips
  duplicate titles).
- **Keyboard shortcuts** — `j`/`k` (or ↑/↓) move the selection, `x` toggles,
  `e` edits, `Del` deletes, `n` or `/` jumps to the add box, `?` shows the
  shortcut panel. Shortcuts stay silent while you type.
- **Installable & offline** — served over `http://` the app registers a
  service worker (network-first with a cache fallback) and an app manifest,
  so it loads with no connection and can be installed like a native app.
  The double-click-`index.html` flow keeps working without either (service
  workers need `http://`, so `file://` is online-only).

## Quick add understands plain English

Type one line into the box at the top — no forms needed:

| You type | You get |
| --- | --- |

## The assistant

The chat panel on the right adds, edits, completes, reschedules,
reprioritises and deletes tasks — and answers questions about your list.

Try:

- `add buy milk tomorrow !! #errands`
- `finish the report`
- `move everything due today to tomorrow`
- `make the water plants task high priority`
- `delete water plants`
- `clear completed`
- `plan my day` / `what should I do first?` / `how many tasks are left?`

### Two modes

| Mode | What happens |
| --- | --- |
| **Local mode** (default) | A rule-based engine in `nlp.js` handles the commands above entirely in your browser. No network calls, no key, works offline. |
| **Connected** | Open **AI settings**, pick a provider, paste a key. Messages go to that endpoint and the model returns a small JSON action list which the app validates and applies. If a request fails, the app falls back to local mode and says so. |

Presets are built in for **OpenAI**, **OpenRouter**, **Groq**, **Ollama**
(`http://localhost:11434/v1`) and any **custom** OpenAI-compatible endpoint.
`AI settings → Test connection` sends a one-token request so you can verify the
URL, model and key before relying on it.

### How the model is wired up

The model receives the current list (ids, titles, priorities, due dates, tags,
repeat, status) plus today's date, and must reply with a single JSON object:

```json
{
  "reply": "short answer rendered in the chat panel",
  "actions": [
    {"type": "add", "title": "Ship release", "priority": "high", "due": "2026-10-05", "tags": ["work"]},
    {"type": "update", "ref": "t_abc123", "patch": {"due": "2026-10-09"}},
    {"type": "complete", "ref": "buy milk"},
    {"type": "delete", "ref": "t_def456"},
    {"type": "clear_completed"}
  ]
}
```

Fenced JSON, raw JSON, a bare action array and plain prose are all handled.
Everything is validated before it touches your data: unknown action types,
blank titles, empty patches and actions without a target are dropped; dates are
re-parsed and clamped; `ref` strings are resolved against real ids/titles;
actions that match nothing are reported in the chat instead of failing
silently. Turn **"Apply assistant changes without asking"** off to review each

## Tests

**Engine tests** — dates, store behaviour, sorting, NLP parsing and the AI
layer, including stubbed `fetch` calls for the remote path (30 tests):

```
open tests.html
```

**UI integration tests** — drive the real `index.html` in an iframe with real
DOM events: quick add, filters, search, toggling, inline edit, chat, the
pending-approval flow, settings, Escape-to-close, keyboard shortcuts,
clear/undo and persistence across a reload (14 tests). They need same-origin access to the iframe, so run
them from the local server:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
# open http://localhost:8080/uitest.html
```

Your saved tasks and AI settings are snapshotted and restored around a UI run.
Both suites set `document.title` to `PASS n/m` (or `FAIL …`) and print a JSON
summary into `#dump`, so they can be checked headlessly. This is how they were
verified while building:

```powershell
$edge = (Get-ChildItem 'C:\Program Files (x86)\Microsoft\Edge\Application' -Filter msedge.exe).FullName

# engine suite, no server needed
& $edge --headless --disable-gpu --virtual-time-budget=8000 --dump-dom `
    'file:///C:/path/to/todo-ai/tests.html' | Select-String 'id="dump"'

# ui suite, needs serve.ps1 running
& $edge --headless --disable-gpu --virtual-time-budget=45000 --dump-dom `
    'http://localhost:8080/uitest.html' | Select-String 'id="dump"'
```

## Where your data lives

| `localStorage` key | Contents |
| --- | --- |
| `todo-ai.v1` | the tasks |
| `todo-ai.ai.v1` | provider, base URL, model, key, auto-apply flag, last 40 chat turns |
| `todo-ai.seeded.v1` | marker so the demo tasks are only seeded once |

Clearing site data resets everything. If a browser blocks storage (some
`file://` configurations), the app keeps working for the session and shows a
warning instead of failing.

## Design notes and limitations

- **No build step on purpose.** This machine has no Node, Python or Ollama, so
  the app is classic `<script>` files that run from `file://` — modules would
  have been blocked by CORS on `file://`.
- **The assistant is a tool-caller, not a chatbot bolted on.** Local and remote
  modes produce the *same* action schema, so both are validated, applied and
  undone through one code path.
- **Offline mode is a real feature, not a stub.** It never silently pretends to
  be an LLM: every locally generated answer is labelled "Offline answer".
- **"Smart" sort is deterministic:** date bucket first (overdue → today → within
  3 days → later → undated), then priority. Ties fall back to creation order.
- **`next friday` means the Friday of the following week** (Todoist-style);
  plain `friday` is the next upcoming one. If today is that weekday, it means
  seven days out.
- **Times are not stored.** `Call mom at 3pm tomorrow` keeps "at 3pm" in the
  title and sets the due *date* to tomorrow — there is no clock/reminder layer.
- **`localAssistant` never writes to storage by itself**; it returns actions and
  the caller applies them, which is what makes the tests and the
  approve-before-apply mode possible.
- **Undo is single-step** and covers the last mutation (including a whole
  assistant batch, because a batch is committed as one change).
- **Not included:** accounts, sync, sharing, notifications, recurring patterns
  other than daily/weekly, and undo history beyond one step.

batch with **Apply / Dismiss** buttons.

### Privacy, keys and CORS

- The key lives in this browser's `localStorage` only and is sent only to the
  endpoint you configure. There is no backend in this project.
- The browser calls the provider directly, so the provider must allow
  cross-origin requests (OpenAI, OpenRouter and Groq do; a local Ollama needs
  `OLLAMA_ORIGINS="*"` before it starts). If a provider blocks browser calls the
  app says so and falls back to local mode — put a small server-side proxy in
  front of it if you need one.
- Opening the page straight from disk gives it a `null` origin. If your provider
  rejects that, run `serve.ps1` and use `http://localhost:8080/`.

| `Call mom tomorrow !! #family` | "Call mom", due tomorrow, high priority, `#family` |
| `pay rent 10/1` | due 2026-10-01 |
| `Submit report in 3 days p1 tag work` | due in 3 days, high priority, `#work` |
| `Standup every weekday 9am` | daily repeat task |
| `Water plants friday` | due the next Friday |
| `Buy stamps` | plain task, medium priority |

Syntax reference: `!!` / `p1` / `urgent` = high, `!` / `p2` = medium,
`p3` / `whenever` = low; `#tag` or `tag a, b`; dates like `today`, `tonight`,
`tomorrow`, `day after tomorrow`, `in 3 days`, `in 2 weeks`, `next week`,
`next month`, `friday`, `next friday`, `oct 5`, `5 october`, `2026-10-05`,
`10/5`.
