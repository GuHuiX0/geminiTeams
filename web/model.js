/** Shared presentation model: task selection survives changing the question/view. */
export function stepLabel(job) {
  if (job.kind === "tool")
    return job.tool?.replaceAll("_", " ") ?? "Tool operation";
  if (job.kind === "reason") return "Reasoning worker";
  return job.dependsOn.length
    ? "Synthesis"
    : job.parentId
      ? "Reassessment"
      : "Initial response";
}
export function dependencies(job, jobs) {
  const ids = new Set(job.dependsOn);
  if (job.parentId) ids.add(job.parentId);
  return jobs.filter((j) => ids.has(j.id));
}
export function layers(jobs) {
  const depths = new Map();
  const visit = (job, path = new Set()) => {
    if (depths.has(job.id)) return depths.get(job.id);
    if (path.has(job.id)) return 0;
    path = new Set([...path, job.id]);
    const parents = dependencies(job, jobs);
    const depth = parents.length
      ? 1 + Math.max(...parents.map((parent) => visit(parent, path)))
      : 0;
    depths.set(job.id, depth);
    return depth;
  };
  for (const job of jobs) visit(job);
  const grouped = [];
  for (const job of jobs) (grouped[depths.get(job.id)] ??= []).push(job);
  return grouped.filter(Boolean);
}
export function taskSummary(task, jobs) {
  const current = jobs.filter(
    (j) => j.taskId === task.id && j.revision === task.revision,
  );
  const running = current.filter((j) => j.state === "running");
  const queued = current.filter((j) => j.state === "queued");
  const blocked = queued.filter((j) =>
    j.dependsOn.some(
      (id) =>
        !["completed", "failed", "cancelled"].includes(
          current.find((p) => p.id === id)?.state,
        ),
    ),
  );
  const failed = current.filter((j) =>
    ["failed", "uncertain"].includes(j.state),
  );
  let label = task.state;
  if (task.state === "active")
    label = running.length
      ? `${running.length} ${running.length === 1 ? "step" : "steps"} running`
      : "Queued for capacity";
  if (task.state === "waiting") label = "Waiting for an event";
  if (task.state === "paused")
    label = failed.some((j) => j.state === "uncertain")
      ? "Outcome needs review"
      : "Paused";
  return {
    current,
    running,
    queued,
    blocked,
    failed,
    label,
    completed: current.filter((j) => j.state === "completed").length,
    attention:
      ["paused", "failed"].includes(task.state) ||
      failed.some((j) => j.state === "uncertain"),
  };
}
export function retryBlocker(job, jobs, task) {
  if (
    job.state !== "failed" ||
    job.revision !== task.revision ||
    ["completed", "cancelled"].includes(task.state)
  )
    return "Retry is available for failed steps in an unfinished current revision.";
  if (job.kind === "tool")
    return "Tool retries require checking the operation’s effects in the runtime.";
  if (jobs.some((j) => j.state === "uncertain"))
    return "Reconcile uncertain write outcomes first.";
  const downstream = new Set([job.id]);
  for (let pass = 0; pass < jobs.length; pass++)
    for (const candidate of jobs) {
      if (
        (candidate.parentId && downstream.has(candidate.parentId)) ||
        candidate.dependsOn.some((id) => downstream.has(id))
      )
        downstream.add(candidate.id);
    }
  if (
    jobs.some(
      (j) => j.id !== job.id && downstream.has(j.id) && j.state !== "queued",
    )
  )
    return "Dependent work has already run. Start a new task to reconsider those results.";
  return "";
}
export function decisionFor(job) {
  if (job.kind !== "controller" || !job.result) return null;
  try {
    const value = JSON.parse(job.result);
    return value && typeof value.reason === "string" ? value : null;
  } catch {
    return null;
  }
}
export function eventLabel(event) {
  const labels = {
    "task.created": "Task started",
    "job.queued": "Step queued",
    "job.started": "Step started",
    "job.output": "Response text",
    "job.completed": "Step completed",
    "artifact.published": "Result published",
    "decision.recorded": "Decision recorded",
    "job.retry": "Retry scheduled",
    "job.retried": "Step retried by user",
    "job.failed": "Step failed",
    "task.failed": "Task failed",
    "task.paused": "Task paused",
    "task.resumed": "Task resumed",
    "task.steered": "Direction changed",
    "task.cancelled": "Task cancelled",
    "task.completed": "Task completed",
    "task.waiting": "Waiting for an event",
    "task.event": "Event delivered",
    "task.limit": "Limit reached",
    "tool.uncertain": "Write outcome needs review",
    "tool.reconciled": "Outcome recorded",
    "task.escalated": "Continued in background",
  };
  return (
    labels[event.kind] ?? event.kind.replaceAll(".", " · ").replaceAll("_", " ")
  );
}
export function filterEvents(events, category = "all", query = "") {
  return events.filter((event) => {
    const kind = event.kind;
    const matches =
      category === "all"
        ? kind !== "job.output"
        : category === "decisions"
          ? [
              "decision.recorded",
              "artifact.published",
              "task.escalated",
            ].includes(kind)
          : category === "failures"
            ? /failed|uncertain|limit|retry|error/.test(kind)
            : category === "control"
              ? [
                  "task.paused",
                  "task.resumed",
                  "task.steered",
                  "task.cancelled",
                  "job.retried",
                  "tool.reconciled",
                ].includes(kind)
              : category === "external"
                ? [
                    "task.event",
                    "event.ingested",
                    "timer.created",
                    "subscription.created",
                  ].includes(kind)
                : category === "output"
                  ? kind === "job.output"
                  : true;
    return (
      matches &&
      (!query ||
        (eventLabel(event) + JSON.stringify(event.data))
          .toLowerCase()
          .includes(query.toLowerCase()))
    );
  });
}
export function parseRoute(hash) {
  const parameters = new URLSearchParams(hash.replace(/^#/, ""));
  return {
    taskId: parameters.get("task"),
    view: ["overview", "results", "execution", "activity"].includes(
      parameters.get("view"),
    )
      ? parameters.get("view")
      : "overview",
    jobId: parameters.get("step"),
    artifactId: parameters.get("artifact"),
    eventId: parameters.get("event"),
    revision: parameters.get("revision"),
  };
}
/** Handles arbitrary network chunk boundaries, including CRLF and split UTF-8 via TextDecoder upstream. */
export function sseParser(consume) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const record = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = record
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) consume(JSON.parse(data));
    }
  };
}
