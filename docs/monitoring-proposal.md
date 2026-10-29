# Proposal: make persistent monitoring easy to configure

Status: proposed after the task panel milestone. No source adapters or monitoring setup forms are implemented by this change. The existing toolset is unchanged.

## Recommended next experience

Add a **Sources** area to the local panel. A source is a reusable, durable subscription to activity outside the runtime. Users configure it once and attach one or more persistent tasks.

The setup interaction should be:

1. **Choose a signal.** Files changed, Git changed, scheduled check, or incoming webhook.
2. **Choose its scope.** A local project directory, repository, schedule/timezone, or authenticated webhook endpoint. Show a readable summary and sensible exclusions.
3. **Preview and bind.** Show example normalized events, let the user select the tasks to wake, and enable the source.

Users should never need to construct source/type/subject strings or write an adapter merely to watch a project. The advanced view can expose the same saved configuration as JSON; the form and CLI must use the same schema.

Each source should show connection health, last received event, last successfully delivered event, tasks using it, and any concrete configuration error. Starting, pausing, editing, or deleting a source should preserve a clear distinction between stopping event collection and pausing an attached task.

## First adapters

| Adapter | Configuration presented to users | Durable state / recovery |
| --- | --- | --- |
| Filesystem | Directory, include patterns, exclusions, debounce | File fingerprints; reconcile changes after downtime and emit a coalesced catch-up event |
| Git | Repository, commits and/or working-tree changes, paths | Last observed commit and working-tree baseline; handle changed history explicitly |
| Schedule | “Every…”, or calendar time with an explicit timezone | Existing durable timer behavior; show next firing and coalesce missed intervals |
| Webhook | Source name, event mapping, authentication, target tasks | Stable producer IDs and durable receipts; acknowledge after persistence |

Start with filesystem, Git, and a form for existing timers. Webhooks then provide a general path for external services without implementing every service-specific watcher first.

The runtime already has the event router, deduplication, debounce, task mailboxes, and durable timers. The missing layer is acquisition and configuration: adapters produce events; the existing router determines which tasks should wake.

## A small adapter contract

An adapter package should provide:

- A display name, description, and configuration schema, including field labels and defaults.
- Validation that returns actionable errors, such as an unreadable directory or a missing repository.
- A read-only preview that demonstrates what events the configuration would produce.
- A start/stop lifecycle that receives an abort signal, a durable checkpoint, and a durable event emission function.
- Health reports and reconnect/catch-up behavior.

Persist source definitions, enablement, task bindings, checkpoints, and health separately from task state. Assign each source a stable ID and use that ID as the existing event `source`; the panel displays its human-readable name. A separate source registry owns the active adapter instances.

Avoid one watcher per agent. Reuse watchers for the same canonical root and fan normalized events out to task bindings. Bound incoming queues, combine bursts, and retain useful summaries so large event volumes do not turn into equivalent model-call volumes or an unbounded UI feed.

## Defaults that remove work

For filesystem monitoring, exclude dependency directories, `.git` internals, build outputs, caches, temporary editor files, and the runtime’s own state directory. Debounce a save burst and skip metadata-only changes when content fingerprints are unchanged. Expose the normalized paths in the preview so users can verify the scope.

Carry task-origin and causal tags from operations that can supply them. A raw filesystem notification has no reliable agent ownership information, so do not pretend attribution is solved by a watcher alone. Correlation with recorded writes and conservative suppression belong in the source pipeline when local execution adapters are added later.

A persistent task should use zero model calls while it waits. A high-frequency source should first filter deterministically and produce an aggregate event. The panel should let users see the last raw event, the filtered aggregate, and the tasks actually woken, which makes “why did this task run?” debuggable.

A local watcher operates only while the runtime process is running. After the source configuration workflow works, add an optional OS service installer for macOS, Linux, and Windows so monitoring survives terminal closure and login cycles. Catch-up must still work after a reboot; a background process alone does not supply durable delivery.

## Alternatives and tradeoffs

**Configuration file first:** an editable JSON file plus CLI validation is a useful fallback for developers and batch setup. It should share the panel’s schema and preview behavior. It is less approachable than choosing a directory and seeing events immediately.

**MCP integrations:** MCP servers can supply useful service capabilities, tools, and sometimes notifications. Source configuration still needs explicit lifecycle, health, checkpointing, filtering, and recovery in this runtime. Support suitable MCP-backed sources through the same adapter interface rather than requiring users to understand the transport.

**Service-specific connectors:** add these after file/Git/schedule/webhook coverage. They should reuse the common source configuration and task-binding experience.

## Acceptance checkpoint

A user can configure a folder monitor without editing code, preview a matching change, attach a persistent task, and understand the resulting wake in the panel. Pausing a source stops collection; pausing a task retains pending deliveries according to the task’s existing semantics. Restarting the runtime restores the source and emits one coherent catch-up update for relevant missed changes. A burst of saves causes a bounded number of task wakes, and a broken path or connection appears as an actionable source error.
