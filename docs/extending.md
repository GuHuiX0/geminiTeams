# Extend the runtime

## Register a tool

Tools must describe their inputs, effects, and canonical resources. Use `read` only for operations safe to replay. Mutations, messages, external job creation, or uncertain side effects belong to `write`.

```ts
import { z } from 'zod';
import { GeminiProvider, Runtime, Store, ToolRegistry } from '../src/index.js';

const tools = new ToolRegistry().register({
  name: 'lookup_note',
  description: 'Fetch a note by ID from the application note store',
  effect: 'read',
  schema: z.object({ noteId: z.string().min(1) }),
  resources: input => [`notes/${encodeURIComponent(input.noteId)}`],
  async execute(input, context) {
    context.signal.throwIfAborted();
    // Replace with your own client. Pass context.signal to all I/O.
    return JSON.stringify({ noteId: input.noteId, text: 'Application note content' });
  },
});

const runtime = new Runtime(new Store('.living/runtime.sqlite'), new GeminiProvider(), {}, tools).start();
runtime.submit({ intent: 'Summarize note 42', allowedTools: ['lookup_note'] });
```

`context` includes taskId, jobId, signal, and idempotencyKey. The stable job ID is the idempotency key across safe retries. For write adapters, pass it to an external service that supports idempotency. The runtime never automatically retries a write it cannot confirm.

Resource names must be canonical and use `/` hierarchy: a write lease on `repository/auth` excludes reads/writes on `repository/auth/session`; `repository/payments` can continue. All requested resources are acquired atomically. Normalize aliases in the adapter, including any external identifiers that refer to the same object. Leases are cooperative and local to this ToolRegistry, so they do not coordinate independent processes or external actors.

Adapters must honor cancellation and must not launch detached side effects. The scheduler can stop awaiting an uncooperative promise, but cannot terminate arbitrary JavaScript or undo an external write. For a native process adapter, supervise/terminate its process group and supply an actual sandbox and appropriate isolation.

## Replace Gemini

Implement the `ModelProvider` interface:

```ts
import type { ModelProvider } from '../src/index.js';

const provider: ModelProvider = {
  async execute(request, signal, onText) {
    signal.throwIfAborted();
    // Call onText?.(chunk) as user-visible response text arrives.
    // Return the complete string or validated decision when the call finishes.
    if (request.job.kind === 'reason') return 'Worker findings, uncertainty, and source references';
    return {
      artifact: { title: 'Useful result', body: 'An answer for the current intent', confidence: 'unverified', evidence: [] },
      next: 'complete',
      operations: [],
      reason: 'The task goal is satisfied',
    };
  },
};
```

A controller returns `Decision`; a reasoning worker returns a string. Each provider invocation must correspond to one top-level model request if you want accurate call accounting. Disable hidden SDK retries or additional routing requests. The included Gemini adapter does this and forwards cancellation/timeouts.

A continuing decision must request 1–6 independent operations. The runtime joins them before the next controller call. Operations have `{ kind, instruction, tool, inputJson }`: reason operations use null for tool/inputJson; tool operations supply a registered tool name and a JSON-encoded object matching its schema. Terminal and waiting decisions must have no operations.

## Add an event source

An adapter can be a separate process using `/ingest`. Store the subscription before connecting the source. Give each real event a stable source-specific ID, attach a semantic subject/type, and preserve causal task IDs on agent-triggered changes. Do deterministic filtering before the request when possible. The runtime routes and coalesces events without an LLM call.

For file/Git watchers, explicitly select a project scope and exclude transient/build files. Filesystem notifications do not carry task ownership; your adapter must correlate changes with the operations that produced them if it needs reliable feedback-loop suppression. No broad watcher is installed by this repository.
