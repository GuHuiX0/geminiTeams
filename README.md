# Living Agent Runtime

**One persistent runtime. Many living tasks. Ephemeral Gemini workers.**

A working, headless TypeScript runtime for quick questions, deep intellectual work, and long-lived projects. It implements the final direction in [the design discussion](https://chatgpt.com/share/6ae0cae6-4f30-83ea-a6ba-360b4f5ce7aa): optimize time to the first useful result, keep background work independent, and preserve tasks between interactions.

[中文快速开始](docs/quickstart.zh-CN.md) · [Architecture and guarantees](docs/architecture.md) · [HTTP API](docs/api.md) · [Extending tools and providers](docs/extending.md)

## Start in two minutes

Requires **Node.js 24+** and npm. SQLite is built into Node; there is no separate database service.

```bash
npm ci
npm run build
npm run demo
```

The demo makes **no network or model calls**. It demonstrates reserved interactive capacity, parallel branches, progressive artifacts, a sleeping persistent task, and event deduplication. Its answers are clearly labeled scripted content.

For real Gemini inference:

```bash
export GEMINI_API_KEY='your-key'
# Optional: choose a model available to your account.
export LIVING_MODEL=gemini-flash-latest
npm start -- serve
```

In another terminal:

```bash
npm start -- submit "Explain actor models in three sentences" --policy instant --wait
npm start -- submit "Compare three approaches to a personal research assistant" --policy deep --wait
npm start -- list
npm start -- get TASK_ID
npm start -- events TASK_ID
```

`submit` acknowledges the new task immediately. `--wait` prints each new useful artifact as it becomes available; `events` exposes the durable event stream. Without a key, run `npm start -- serve --demo` to try the CLI and API offline.

Optionally enable Gemini Google Search grounding for **reasoning workers**:

```bash
npm start -- serve --ground-search
```

This adds search sources to worker observations. Controllers synthesize those observations. Search availability and tool charges depend on your Gemini model/account; model-call budgets count top-level requests, not individual searches or tokens.

## What works

| Capability | Behavior |
| --- | --- |
| Fast path | `instant` performs one plain model call, with no planner call. |
| Adaptive depth | `focused` starts in interactive capacity; further branches move to background capacity after the first useful result. |
| Parallel work | Controllers request independent reasoning/tool operations, then synthesize after their dependencies settle. |
| Reserved capacity | Separate interactive and background slot limits; background work cannot consume interactive slots. |
| Fair scheduling | Task priority weights virtual service time; global and per-task limits bound concurrency. |
| Living tasks | Pause, resume, redirect, cancel, and inspect tasks without throwing away their artifacts or evidence. |
| Durability | SQLite checkpoints, artifacts, memory, jobs, mailbox deliveries, timers, dedupe receipts, and an append-only event log. |
| Recovery | Restart interrupted reasoning/reads; pause interrupted or failed writes for explicit reconciliation. |
| Event routing | Explicit subscriptions, deterministic source/type/subject filters, bounded debounce, deduplication, and causal-loop suppression. |
| Progressive results | Versioned artifacts publish before deeper work finishes; passive progress and completion/decision events remain distinct. |
| Tool control | Explicit per-task allowlists, schema validation, workspace-scoped file tools, and resource leases. |
| Interfaces | TypeScript SDK, CLI, local HTTP API, and resumable Server-Sent Events. |

No task consumes inference while `waiting` or `paused`. The scheduler keeps a lightweight timer running to dispatch jobs and durable timers.

## Choose how much work to do

| Policy | Initial lane | Default call budget | Intended use |
| --- | --- | --- | --- |
| `instant` | interactive | 1 | Direct answers and transformations |
| `focused` | interactive, then background if expanded | 10 | Bounded reasoning or tool use |
| `deep` | background | 30 | Research, analysis, design, exploration |
| `persistent` | background | 100 | Long-lived projects that wait for events |

The policy is explicit; there is no extra LLM router before the first call. The default `focused` controller can finish immediately or expand only when useful. Every controller's first accepted decision must include a useful artifact. Later calls may refine it, request independent operations, complete, or wait for an event.

```bash
npm start -- submit "Explore this hypothesis" --policy deep --max-calls 20 --max-parallel 4
npm start -- pause TASK_ID
npm start -- steer TASK_ID "Revised goal: prioritize the architecture and retain useful evidence"
npm start -- resume TASK_ID --extra-calls 10
npm start -- cancel TASK_ID
```

`steer` replaces the full intent, increments the task revision, and fences old results. Earlier artifacts stay available as labeled historical context. Budgets count all attempted model requests, including aborted requests and retries. Branches must leave room for a synthesis call. Exhausted budgets pause for a user decision rather than reporting false completion.

## Wake a persistent task

```bash
npm start -- submit "Track changes to my research hypothesis" --policy persistent
npm start -- subscribe TASK_ID --source research --subject 'papers/*' --type new-evidence
npm start -- emit --source research --subject papers/actors --type new-evidence \
  --event-id paper-42 --payload '{"summary":"New evidence to consider","url":"https://example.com/paper"}'
npm start -- timer TASK_ID --in 30m --every 6h
```

Subscriptions and timers persist across restarts. File, Git, browser, and service integrations can send events through `/ingest`; the runtime does not automatically collect computer activity. An event only wakes existing subscribed tasks. Subject/type patterns support exact match, `*`, or a trailing prefix wildcard.

Producers should attach `originTaskId` and a `causation` list of task IDs. A task ignores events it caused or already appears in. Ten edits to the same source/type/subject in a short burst become one delivery containing the newest payload and a coalesced count. Duplicate `(source,id)` pairs are accepted once, including after restart.

## Give a task access to local files

Registering a tool on the server and granting it to a task are separate actions:

```bash
npm start -- serve --workspace /absolute/path/to/project
npm start -- submit "Read notes.md and summarize the open questions" --tools file_read
```

For file writes, start with `--allow-writes` **and** submit with `--tools file_read,file_write`. These are actual authorizations: an allowed write tool may change files without another confirmation. Built-in tools enforce path boundaries, reject escaping symlinks, and use atomic replacement. This adapter is a local workspace boundary, not an operating-system sandbox against hostile processes racing filesystem changes.

Read operations share leases. Writes take exclusive leases across overlapping resource paths; disjoint resources can proceed concurrently. No shell or GUI tool is registered by default. Add other adapters through the SDK with explicit schemas and resources.

## Use the SDK

```ts
import { GeminiProvider, Runtime, Store } from './dist/index.js';

const store = new Store('.living/runtime.sqlite');
const runtime = new Runtime(store, new GeminiProvider(), {
  interactiveSlots: 2,
  backgroundSlots: 8,
  maxWorkersPerTask: 4,
}).start();

const task = runtime.submit({
  intent: 'Develop and challenge a hypothesis for a new research tool',
  policy: 'deep',
});

const unsubscribe = store.onEvent(event => {
  if (event.taskId === task.id) console.log(event.kind, event.data);
});

// At application shutdown:
// unsubscribe(); await runtime.stop(); store.close();
```

Keep one runtime process per database. Other clients use its HTTP API. A database ownership lock is automatically released by the OS on process death. Persist `.living/` on local storage; task contents and tool results live there, and this directory is ignored by Git.

## Verify

```bash
npm run check
```

Checks include strict TypeScript, concurrency and lifecycle tests, a real `SIGKILL`/restart test, durable SSE replay, authorization and filesystem boundary tests, and the Gemini SDK adapter over a mocked HTTP transport. Live Gemini inference requires your credentials and is not part of the offline test suite. GitHub Actions runs the same checks on Node 24.

## Current scope

This is a single-machine MVP with a runnable SDK/CLI/API. It has no dashboard, distributed scheduler, automatic desktop observation, sandboxed shell execution, or autonomous opportunity detection. Task priority is a transparent scheduling weight, not a learned estimate of task value. Google Search grounding is optional; otherwise research uses model knowledge and the tools/observations you supply.

Model-generated confidence and citations are claims to inspect, not independent verification. `supported` is the model's assessment; the runtime downgrades unsupported empty evidence to `unverified`, but does not prove the references. Context selection is bounded (recent artifacts and observations); full history remains in SQLite. Logs have no automatic retention/compaction yet. See [architecture](docs/architecture.md) for exact recovery and scheduling limits.
