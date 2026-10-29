# The task workspace

The panel helps a person understand and steer concurrent delegated work without reconstructing it from a message feed. Its primary object is a persistent task. Jobs, decisions, artifacts, and events are inspectable records attached to that task.

## Start locally

```bash
npm ci
npm run build
npm start -- serve --demo --db .living/panel-demo.sqlite
```

Open http://127.0.0.1:7331. Demo mode clearly labels scripted outputs. **Try a parallel workflow** creates three actual runtime tasks. **Try a recovery scenario** additionally simulates a synthesis failure; inspect that step and retry it to continue from the completed workers.

For real inference, export `GEMINI_API_KEY` and start `npm start -- serve`. Model requests use Gemini’s streaming API. The API key stays on the server. If `LIVING_TOKEN` is configured, the panel prompts for that runtime token and keeps it only in the current tab’s session. The CLI and HTTP API remain available.

## Information architecture

| User task | Surface | Observable outcome |
| --- | --- | --- |
| Monitor | Workspace overview; task sidebar; execution-now summary | Identify running work, waiting tasks, capacity use, and tasks needing attention |
| Understand | Recorded decisions; step inspector; provenance links | Connect a chosen action to its instruction and the actual observations/results available to it |
| Debug | Execution map; step ledger; filtered activity trace | Find a failed step, trace dependencies, distinguish attempts and revisions, and inspect recorded errors |
| Control | Task actions and eligible step actions | Pause, resume, redirect, cancel, reconcile outcomes, or retry a failed step while preserving independent completed work |

The selected task and step remain selected across views. URL fragments encode task, view, step, result, event, and revision; a reload or copied URL returns to that context. Historical results keep their revision labels. The interface shows completion counts for the currently scheduled graph, not a fabricated percentage of a still-evolving goal.

## A typical investigation

1. Open a task that needs attention.
2. Choose **Execution** and select its failed node or ledger row.
3. Read the recorded error, step instruction, available inputs, dependency links, and affected downstream steps.
4. Choose **Output** to inspect the response from that attempt, or **Events** to inspect its lifecycle.
5. If retry is eligible, choose **Retry this step** and optionally extend the call budget. Already-completed independent workers remain intact.
6. Follow resumed execution and inspect the next published result. The trace records the intervention.

Retries are unavailable once dependent work has run, for terminal completed/cancelled tasks, or while a write outcome is uncertain. The interface explains the restriction. Unknown write effects use the existing reconciliation workflow; this panel adds no new tool capabilities.

## Response text, findings, and decisions

A running response is visibly provisional. An accepted result is published only after complete output passes the runtime’s decision checks. Controller output displays its artifact body as it arrives; private thought parts are excluded and raw protocol JSON is reserved for an explicit inspection disclosure. Reasoning workers expose their own streamed text in the inspector.

Decision explanations are the controller’s recorded rationale and selected action, linked to recorded inputs. The interface does not invent a Slack-style conversation among independent workers, infer undocumented deliberation, or present model confidence as independent verification.

If a task is redirected, old workers cannot append to the new revision. Reconnect resumes from the last received sequence and snapshot refresh restores the current attempt’s accumulated text. Earlier records with missing provenance remain readable and explicitly state which context was not recorded.

## Persistent tasks

The task overview shows currently stored subscriptions and timers and explains when none are configured. **Run now** resumes a waiting task manually. Source adapters, source setup forms, and automatic monitoring are deferred to [the monitoring proposal](monitoring-proposal.md).

## Browser validation

```bash
npx playwright install chromium
npm run test:panel
```

Five browser workflows cover creating/streaming/inspecting work, failed-step recovery, task lifecycle actions, authenticated reconnect and response sanitization, and a 390 px mobile layout. Tests also exercise keyboard dismissal and the task drawer. Screenshots are generated in the ignored `.panel-test-artifacts/` directory; CI uploads them.
