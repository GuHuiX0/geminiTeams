import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  stepLabel,
  dependencies,
  layers,
  taskSummary,
  retryBlocker,
  decisionFor,
  eventLabel,
  filterEvents,
  parseRoute,
  sseParser,
} from "./model.js";

const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const md = (text) =>
  DOMPurify.sanitize(marked.parse(text ?? "", { breaks: false }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "style", "form", "input", "iframe"],
  });
const paths = {
  arrow: "M7 17 17 7M7 7h10v10",
  chevron: "m9 5 7 7-7 7",
  check: "m5 12 4 4L19 6",
  pause: "M9 5v14M15 5v14",
  play: "m8 5 11 7-11 7V5Z",
  stop: "M6 6h12v12H6z",
  branch:
    "M6 3v12a3 3 0 0 0 3 3h9M6 9h7a4 4 0 0 0 4-4V3M3 3h6M15 3h4M17 15l3 3-3 3",
  layers: "m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5",
  clock: "M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  alert:
    "M12 8v5m0 3v.1M10 4 2 18a1 1 0 0 0 1 2h18a1 1 0 0 0 1-2L14 4a2 2 0 0 0-4 0Z",
  search: "m16 16 4 4M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  refresh:
    "M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-2l2 3M4 16l2 3a8 8 0 0 0 13-2",
  file: "M14 3H5v18h14V8l-5-5Zm0 0v6h5M8 13h8M8 17h6",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
};
const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] ?? paths.file}"/></svg>`;
const badge = (status, label = status) =>
  `<span class="badge ${escape(status)}"><span class="status-dot ${escape(status)}"></span>${escape(label)}</span>`;
const time = (value) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const date = (value) =>
  new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const duration = (ms) =>
  ms < 1000
    ? `${ms}ms`
    : ms < 60000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
const short = (id) => id?.slice(0, 8) ?? "—";
const state = {
  data: null,
  route: parseRoute(location.hash),
  taskFilter: "all",
  taskQuery: "",
  eventFilter: "all",
  eventQuery: "",
  events: [],
  hasMore: true,
  historyScope: undefined,
  pinnedEvent: null,
  token: sessionStorage.getItem("living.token") ?? "",
  connection: "connecting",
  inspectorTab: "context",
};
let streamController,
  streamGeneration = 0,
  refreshTimer,
  renderTimer,
  toastTimer,
  refreshing = false,
  refreshAgain = false,
  action;
const selected = () =>
  state.data?.selected?.task.id === state.route.taskId
    ? state.data.selected
    : null;

async function api(
  path,
  body,
  method = body === undefined ? "GET" : "POST",
  signal,
) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(state.token ? { authorization: "Bearer " + state.token } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(
      data.error ?? `Request failed (${response.status})`,
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 4500);
}
function navigate(patch) {
  const next = { ...state.route, ...patch };
  const parameters = new URLSearchParams();
  for (const [key, name] of [
    ["taskId", "task"],
    ["view", "view"],
    ["jobId", "step"],
    ["artifactId", "artifact"],
    ["eventId", "event"],
    ["revision", "revision"],
  ]) {
    if (next[key] && !(key === "view" && next[key] === "overview"))
      parameters.set(name, next[key]);
  }
  const hash = parameters.toString();
  if (location.hash.slice(1) === hash) {
    state.route = next;
    render();
  } else location.hash = hash;
}
async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    const requestedTaskId = state.route.taskId;
    const query = state.route.taskId
      ? "?taskId=" + encodeURIComponent(state.route.taskId)
      : "";
    const data = await api("/snapshot" + query);
    if (state.route.taskId !== requestedTaskId) {
      refreshAgain = true;
      return;
    }
    const sameScope = state.historyScope === requestedTaskId;
    const merged = new Map(
      (sameScope ? state.events : []).map((event) => [event.seq, event]),
    );
    for (const event of data.events) merged.set(event.seq, event);
    const events = [...merged.values()].sort((a, b) => a.seq - b.seq);
    state.events = events.slice(-5000);
    state.hasMore =
      events.length > 5000 ||
      (sameScope ? state.hasMore : data.events.length === 300);
    if (!sameScope) state.pinnedEvent = null;
    state.historyScope = requestedTaskId;
    if (state.route.eventId) {
      const id = Number(state.route.eventId);
      const event =
        state.events.find((event) => event.seq === id) ??
        (state.pinnedEvent?.seq === id ? state.pinnedEvent : null);
      if (event) state.pinnedEvent = event;
      else if (
        Number.isSafeInteger(id) &&
        id >= 0 &&
        id < Number.MAX_SAFE_INTEGER
      ) {
        const history = await api(
          "/history?before=" +
            (id + 1) +
            "&limit=1" +
            (requestedTaskId
              ? "&taskId=" + encodeURIComponent(requestedTaskId)
              : ""),
        );
        if (state.route.taskId !== requestedTaskId) {
          refreshAgain = true;
          return;
        }
        state.pinnedEvent =
          history.events.find((event) => event.seq === id) ?? null;
      }
    }
    state.data = data;
    render();
    startStream(data.cursor);
  } catch (error) {
    if (error.status === 401) {
      state.connection = "locked";
      showConnection();
      renderConnection();
    } else if (error.status === 404 && state.route.taskId) {
      toast("That task is no longer available.");
      navigate({ taskId: null, jobId: null, eventId: null });
    } else {
      state.connection = "offline";
      renderConnection();
      if (!state.data)
        $("#workspace").innerHTML =
          `<div class="empty-state"><h1>Unable to reach the runtime</h1><p>${escape(error.message)}</p><button class="button" data-action="reconnect">Try again</button></div>`;
    }
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      scheduleRefresh();
    }
  }
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 90);
}
function scheduleRender() {
  if (!renderTimer)
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      render();
    }, 90);
}
async function startStream(cursor) {
  streamController?.abort();
  const generation = ++streamGeneration;
  const controller = (streamController = new AbortController());
  let failures = 0;
  while (!controller.signal.aborted) {
    try {
      const response = await fetch("/events?after=" + cursor, {
        headers: state.token ? { authorization: "Bearer " + state.token } : {},
        signal: controller.signal,
      });
      if (response.status === 401) {
        showConnection();
        return;
      }
      if (!response.ok || !response.body) throw new Error("Stream unavailable");
      if (generation !== streamGeneration) return;
      state.connection = "live";
      renderConnection();
      failures = 0;
      const parse = sseParser((event) => {
        if (generation !== streamGeneration || event.seq <= cursor) return;
        cursor = event.seq;
        if (!state.route.taskId || event.taskId === state.route.taskId) {
          state.events.push(event);
          if (state.events.length > 5000) {
            state.events.shift();
            state.hasMore = true;
          }
        }
        const detail = selected();
        if (event.kind === "job.output") {
          const job = detail?.jobs.find((j) => j.id === event.data.jobId);
          if (job) {
            if (job.outputAttempt !== event.data.attempt) {
              job.output = "";
              job.outputAttempt = event.data.attempt;
            }
            job.output = (job.output ?? "") + event.data.text;
            scheduleRender();
          }
        } else scheduleRefresh();
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
      }
      if (!controller.signal.aborted) throw new Error("Connection closed");
    } catch (error) {
      if (controller.signal.aborted || generation !== streamGeneration) return;
      state.connection = "reconnecting";
      renderConnection();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(10000, 500 * 2 ** failures++)),
      );
    }
  }
}
function renderConnection() {
  const labels = {
    live: "Connected",
    connecting: "Connecting",
    reconnecting: "Reconnecting",
    offline: "Offline",
    locked: "Token required",
  };
  $("#connection-label").textContent = labels[state.connection];
  $("#connection-dot").className =
    "status-dot " + (state.connection === "live" ? "completed" : "waiting");
  const banner = $("#connection-banner");
  banner.hidden = !["reconnecting", "offline"].includes(state.connection);
  banner.textContent =
    state.connection === "reconnecting"
      ? "Connection interrupted. Reconnecting from the last received event…"
      : "The runtime is offline. Your saved results remain in its database.";
}
function renderSidebar() {
  const { tasks, jobs, config, demo } = state.data;
  $("#mode-badge").innerHTML = demo
    ? '<span class="demo-badge">OFFLINE DEMO</span>'
    : "";
  $("#task-total").textContent = tasks.length;
  $("#overview-link").classList.toggle("selected", !state.route.taskId);
  const visible = tasks
    .filter((task) => {
      const summary = taskSummary(task, jobs);
      return (
        (state.taskFilter === "all" ||
          (state.taskFilter === "active"
            ? task.state === "active"
            : summary.attention)) &&
        task.intent.toLowerCase().includes(state.taskQuery.toLowerCase())
      );
    })
    .sort((a, b) => {
      const rank = (task) =>
        taskSummary(task, jobs).attention
          ? 0
          : task.state === "active"
            ? 1
            : task.state === "waiting"
              ? 2
              : 3;
      return rank(a) - rank(b) || b.createdAt - a.createdAt;
    });
  $("#task-list").innerHTML = visible.length
    ? visible
        .map((task) => {
          const summary = taskSummary(task, jobs);
          return `<button class="task-item ${state.route.taskId === task.id ? "selected" : ""}" data-task="${escape(task.id)}" ${state.route.taskId === task.id ? 'aria-current="page"' : ""}><span class="task-item-title"><span class="status-dot ${escape(task.state)}"></span><span>${escape(task.intent)}</span></span><span class="task-item-meta">${escape(summary.label)}<span>${task.policy}</span></span></button>`;
        })
        .join("")
    : `<p class="sidebar-empty">${tasks.length ? "No matching tasks." : "Your tasks will appear here."}</p>`;
  for (const element of document.querySelectorAll("[data-task-filter]"))
    element.classList.toggle(
      "selected",
      element.dataset.taskFilter === state.taskFilter,
    );
  const count = (lane) =>
    jobs.filter(
      (j) =>
        j.state === "running" &&
        tasks.find((t) => t.id === j.taskId)?.lane === lane,
    ).length;
  $("#runtime-capacity").innerHTML =
    `<div class="capacity-row"><span><i class="capacity-mark interactive"></i>Interactive</span><span>${count("interactive")} <span class="muted">/ ${config.interactiveSlots}</span></span></div><div class="capacity-row"><span><i class="capacity-mark"></i>Background</span><span>${count("background")} <span class="muted">/ ${config.backgroundSlots}</span></span></div>`;
}
function render() {
  if (!state.data) return;
  const focus = document.activeElement;
  const focusId = focus?.id;
  const selection = focus?.selectionStart;
  const scrolls = [...document.querySelectorAll("[data-scroll-key]")].map(
    (element) => [
      element.dataset.scrollKey,
      element.scrollTop,
      element.scrollLeft,
      element.hasAttribute("data-follow-live") &&
        element.scrollHeight - element.clientHeight - element.scrollTop < 40,
    ],
  );
  renderSidebar();
  renderConnection();
  $("#workspace").innerHTML = selected()
    ? taskWorkspace(selected())
    : overview();
  renderInspector();
  for (const [key, top, left, follow] of scrolls) {
    const element = [...document.querySelectorAll("[data-scroll-key]")].find(
      (e) => e.dataset.scrollKey === key,
    );
    if (element) {
      element.scrollTop = follow ? element.scrollHeight : top;
      element.scrollLeft = left;
    }
  }
  if (focusId && document.getElementById(focusId)) {
    const element = document.getElementById(focusId);
    if (element !== document.activeElement) {
      element.focus({ preventScroll: true });
      if (
        typeof selection === "number" &&
        element.setSelectionRange &&
        element.type !== "number"
      )
        element.setSelectionRange(selection, selection);
    }
  }
  for (const link of document.querySelectorAll(".markdown a")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  requestAnimationFrame(drawGraph);
}
function overview() {
  const { tasks, jobs, demo } = state.data;
  const active = tasks.filter((t) => t.state === "active");
  const waiting = tasks.filter((t) => t.state === "waiting");
  const attention = tasks.filter((t) => taskSummary(t, jobs).attention);
  const running = jobs.filter((j) => j.state === "running");
  return `<div class="page-top"><div class="breadcrumb">Workspace <span>/</span> Overview</div><div class="page-heading"><div><span class="eyebrow">RUNTIME OVERVIEW</span><h1>Work in motion<span class="title-dot">.</span></h1><p>Follow the work. Understand the decisions. Step in where it matters.</p></div><span class="today">${new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</span></div></div>
  <div class="overview-body" data-scroll-key="overview"><div class="metric-strip"><div><span class="metric-number">${active.length.toString().padStart(2, "0")}</span><span>Active tasks</span></div><div><span class="metric-number">${running.length.toString().padStart(2, "0")}</span><span>Running steps</span></div><div><span class="metric-number ${attention.length ? "amber" : ""}">${attention.length.toString().padStart(2, "0")}</span><span>Need attention</span></div><div><span class="metric-number">${waiting.length.toString().padStart(2, "0")}</span><span>Waiting for events</span></div></div>
  ${
    !tasks.length
      ? `<div class="welcome-card"><div class="welcome-graphic" aria-hidden="true"><span>${icon("layers")}</span><i></i><div><span>${icon("branch")}</span><span>${icon("file")}</span><span>${icon("check")}</span></div></div><span class="eyebrow">ONE WORKSPACE. MANY LIVING TASKS.</span><h2>A clear view of delegated work.</h2><p>Start with a question or a goal. Get a useful result early, follow independent work, and keep control as it develops.</p><button class="button primary" data-action="new">Start your first task ${icon("arrow")}</button>${demo ? `<div class="welcome-demo"><span>Explore with scripted responses</span><button class="text-button" data-action="demo">Try a parallel workflow →</button><button class="text-button" data-action="demo-debug">Try a recovery scenario →</button></div>` : ""}</div>`
      : `
    ${attention.length ? `<section class="attention-section"><div class="section-heading"><h2>${icon("alert")} Needs your attention</h2><span>${attention.length} ${attention.length === 1 ? "task" : "tasks"}</span></div>${attention.map((task) => taskCard(task)).join("")}</section>` : ""}
    <section><div class="section-heading"><h2>All tasks</h2><span>Latest activity first</span></div><div class="task-table"><div class="task-table-heading"><span>Task / latest state</span><span>Execution</span><span>Policy</span><span>Updated</span><span></span></div>${[
      ...tasks,
    ]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((task) => taskCard(task))
      .join("")}</div></section>
    ${demo ? `<div class="demo-footer">Scripted offline workspace <span>·</span><button class="text-button" data-action="demo">Add a parallel workflow</button><button class="text-button" data-action="demo-debug">Add a recovery scenario</button></div>` : ""}`
  }
  </div>`;
}
function taskCard(task) {
  const summary = taskSummary(task, state.data.jobs);
  return `<button class="task-row" data-task="${escape(task.id)}"><div class="task-row-main"><span class="status-symbol ${escape(task.state)}">${icon(task.state === "completed" ? "check" : summary.attention ? "alert" : task.state === "waiting" ? "clock" : "layers")}</span><div><strong>${escape(task.intent)}</strong><span>${escape(summary.label)}${task.stopReason && summary.attention ? " · " + escape(task.stopReason) : ""}</span></div></div><div class="step-tally">${summary.completed} <span>/ ${summary.current.length} steps finished</span>${summary.running.length ? '<i class="live-pulse"></i>' : ""}</div><span class="policy-tag">${task.policy}</span><span class="date-cell">${date(task.updatedAt)}</span>${icon("chevron")}</button>`;
}
function taskWorkspace(detail) {
  const { task, jobs } = detail;
  const summary = taskSummary(task, jobs);
  const views = [
    ["overview", "Overview"],
    ["results", "Results"],
    ["execution", "Execution"],
    ["activity", "Activity"],
  ];
  const controls =
    task.state === "active"
      ? `<button class="button small" data-action="pause">${icon("pause")} Pause</button>`
      : task.state === "waiting"
        ? `<button class="button small" data-action="resume">${icon("play")} Run now</button>`
        : task.state === "paused"
          ? `<button class="button small" data-action="resume">${icon("play")} Resume</button>`
          : "";
  return `<div class="page-top task-top"><div class="breadcrumb"><button data-action="home">Workspace</button><span>/</span><span>Task ${escape(short(task.id))}</span><span class="revision-tag">REV ${task.revision}</span></div><div class="task-heading"><div><div class="task-status">${badge(task.state, summary.label)}<span class="policy-tag">${task.policy}</span></div><h1>${escape(task.intent)}</h1></div><div class="task-controls">${controls}${!["completed", "cancelled", "failed"].includes(task.state) ? `<button class="button small" data-action="steer">${icon("branch")} Redirect</button><button class="icon-button" data-action="cancel" title="Cancel task" aria-label="Cancel task">${icon("stop")}</button>` : `<button class="button small" data-action="copy-task">Use this intent ${icon("arrow")}</button>`}</div></div><nav class="view-tabs" aria-label="Task views">${views.map(([id, label]) => `<button data-view="${id}" class="${state.route.view === id ? "selected" : ""}" ${state.route.view === id ? 'aria-current="page"' : ""}>${label}${id === "results" ? `<span>${detail.artifacts.length}</span>` : id === "execution" ? `<span>${jobs.filter((j) => j.revision === task.revision).length}</span>` : ""}</button>`).join("")}<span class="task-meta">${task.calls} / ${task.maxCalls} model calls</span></nav></div>
    <div class="task-content" data-scroll-key="task-${task.id}-${state.route.view}">${state.route.view === "results" ? resultsView(detail) : state.route.view === "execution" ? executionView(detail) : state.route.view === "activity" ? activityView(detail) : taskOverview(detail, summary)}</div>`;
}
function taskOverview(detail, summary) {
  const { task, jobs, artifacts, subscriptions, timers } = detail;
  const latest = artifacts.find((a) => a.id === task.latestArtifactId);
  const live = jobs
    .filter(
      (j) =>
        j.revision === task.revision &&
        j.state === "running" &&
        j.kind === "controller",
    )
    .at(-1);
  const decisions = jobs
    .filter((j) => decisionFor(j))
    .slice(-3)
    .reverse();
  return `${summary.attention ? `<div class="notice attention"><span>${icon("alert")}</span><div><strong>${task.state === "failed" ? "This task needs a recovery decision." : "This task is paused."}</strong><p>${escape(task.stopReason)}</p></div><button class="button small" data-view="execution">Inspect execution ${icon("arrow")}</button></div>` : ""}
    <div class="task-overview-grid"><div class="primary-column"><section class="surface result-surface"><div class="section-heading"><h2>${icon("file")} ${live ? "Response in progress" : "Latest useful result"}</h2>${live ? '<span class="live-label"><i class="live-pulse"></i>Streaming</span>' : latest ? `<span>Revision ${latest.revision}</span>` : ""}</div>${live?.output ? `<div class="stream-caption">Provisional response · accepted results appear below when the step completes</div><div class="markdown live-output" data-follow-live data-scroll-key="live-${escape(live.id)}">${md(live.output)}</div>` : live ? `<div class="result-placeholder"><span class="spinner"></span><h3>Preparing a first useful response</h3><p>You can inspect the active step while the response arrives.</p></div>` : latest ? `<div class="result-title"><h3>${escape(latest.title)}</h3><span class="confidence">${escape(latest.confidence)}</span></div><div class="markdown result-preview">${md(latest.body)}</div>` : `<div class="result-placeholder">${icon("file")}<h3>No result for this revision yet</h3><p>${artifacts.length ? "Earlier results are preserved in Results." : "The first useful response will appear here."}</p></div>`}<div class="surface-footer"><button class="text-button" data-view="results">Open all results ${icon("arrow")}</button>${live ? `<button class="text-button" data-job="${escape(live.id)}">Inspect active step</button>` : latest?.jobId ? `<button class="text-button" data-job="${escape(latest.jobId)}">How was this produced?</button>` : ""}</div></section>
    <section class="surface"><div class="section-heading"><h2>${icon("branch")} Recorded decisions</h2><span>Action and stated basis</span></div>${
      decisions.length
        ? decisions
            .map((job) => {
              const decision = decisionFor(job);
              return `<button class="decision-row" data-job="${escape(job.id)}"><span class="decision-icon">${icon("branch")}</span><div><strong>${escape(decision.reason || "Decision recorded")}</strong><span>${escape(stepLabel(job))} · Revision ${job.revision} · ${decision.next === "continue" ? `${decision.operations.length} independent operations requested` : decision.next === "wait" ? "Waiting for new events" : "Work marked complete"}</span></div>${icon("chevron")}</button>`;
            })
            .join("")
        : '<p class="section-empty">Decisions appear after a controller step completes.</p>'
    }</section></div>
    <div class="secondary-column"><section class="surface"><div class="section-heading"><h2>Execution now</h2><button class="text-button" data-view="execution">View all ${icon("arrow")}</button></div><div class="execution-counts"><div><strong>${summary.running.length}</strong><span>Running</span></div><div><strong>${summary.blocked.length}</strong><span>Waiting on steps</span></div><div><strong>${summary.completed}</strong><span>Finished</span></div></div>${
      [...summary.running, ...summary.blocked, ...summary.failed]
        .slice(0, 5)
        .map((job) => miniJob(job))
        .join("") ||
      `<p class="section-empty">${task.state === "waiting" ? "No inference is running. This task is waiting for an event or a manual resume." : task.state === "completed" ? "All scheduled work has settled." : "No step is currently running."}</p>`
    }</section>
    <section class="surface"><div class="section-heading"><h2>Task context</h2></div><dl class="metadata"><div><dt>Created</dt><dd>${date(task.createdAt)}</dd></div><div><dt>Current revision</dt><dd>${task.revision}</dd></div><div><dt>Execution lane</dt><dd>${task.lane}</dd></div><div><dt>Completed steps</dt><dd>${summary.completed} of ${summary.current.length} scheduled</dd></div><div><dt>Model calls</dt><dd>${task.calls} of ${task.maxCalls}</dd></div></dl></section>
    ${task.policy === "persistent" ? `<section class="surface"><div class="section-heading"><h2>${icon("clock")} Wake conditions</h2></div>${subscriptions.length || timers.length ? `<div class="wake-list">${subscriptions.map((s) => `<div><strong>${escape(s.source)}</strong><code>${escape(s.subject)} · ${escape(s.type)}</code></div>`).join("")}${timers.map((t) => `<div><strong>${t.intervalMs ? "Recurring timer" : "Timer"}</strong><span>Next: ${date(t.dueAt)}</span></div>`).join("")}</div>` : '<p class="section-empty">No event subscriptions or timers are configured for this task. You can run it again manually.</p>'}</section>` : ""}</div></div>`;
}
function miniJob(job) {
  return `<button class="mini-job" data-job="${escape(job.id)}"><span class="status-dot ${escape(job.state)}"></span><div><strong>${escape(stepLabel(job))}</strong><span>${escape(job.instruction)}</span></div>${icon("chevron")}</button>`;
}
function resultsView(detail) {
  const { task, jobs, artifacts } = detail;
  const artifact =
    artifacts.find((a) => a.id === state.route.artifactId) ??
    artifacts.find((a) => a.id === task.latestArtifactId) ??
    artifacts.at(-1);
  const running = jobs
    .filter(
      (j) =>
        j.revision === task.revision &&
        j.state === "running" &&
        j.kind === "controller",
    )
    .at(-1);
  return `${running ? `<section class="surface streaming-result"><div class="section-heading"><h2>Live response</h2><span class="live-label"><i class="live-pulse"></i>Provisional · attempt ${running.attempts}</span></div><div class="markdown live-output" data-follow-live data-scroll-key="live-${escape(running.id)}">${running.output ? md(running.output) : '<p class="muted">Waiting for response text…</p>'}</div><div class="surface-footer"><button class="text-button" data-job="${escape(running.id)}">Inspect this step ${icon("arrow")}</button></div></section>` : ""}
    <section class="surface result-detail"><div class="section-heading"><h2>Published results</h2>${
      artifacts.length
        ? `<select id="artifact-select" aria-label="Select published result">${[
            ...artifacts,
          ]
            .reverse()
            .map(
              (a) =>
                `<option value="${escape(a.id)}" ${a.id === artifact?.id ? "selected" : ""}>Rev ${a.revision} · ${escape(a.title)} · ${time(a.createdAt)}</option>`,
            )
            .join("")}</select>`
        : ""
    }</div>${artifact ? `<div class="result-detail-heading"><div><span class="eyebrow">REVISION ${artifact.revision} ${artifact.revision !== task.revision ? "· HISTORICAL RESULT" : ""}</span><h2>${escape(artifact.title)}</h2><span class="muted">Published ${date(artifact.createdAt)}</span></div><button class="button small" data-copy="${escape(artifact.id)}">Copy result</button></div><div class="markdown full-result">${md(artifact.body)}</div><div class="evidence-section"><div class="section-heading"><h3>Evidence and provenance</h3>${artifact.jobId ? `<button class="text-button" data-job="${escape(artifact.jobId)}">Inspect producing step ${icon("arrow")}</button>` : ""}</div><p>Model assessment: <strong>${escape(artifact.confidence)}</strong>. Evaluate the recorded sources before relying on the conclusion.</p>${artifact.evidence.length ? `<ul>${artifact.evidence.map((e) => `<li>${escape(e)}</li>`).join("")}</ul>` : '<p class="muted">No supporting source references were attached to this result.</p>'}</div>` : `<div class="result-placeholder">${icon("file")}<h3>Results will appear as the task develops</h3><p>Each accepted useful result is saved with its task revision.</p></div>`}</section>`;
}
function revisionJobs(detail) {
  return detail.jobs.filter(
    (j) =>
      state.route.revision === "all" ||
      j.revision === Number(state.route.revision ?? detail.task.revision),
  );
}
function executionView(detail) {
  const jobs = revisionJobs(detail);
  const revisions = [...new Set(detail.jobs.map((j) => j.revision))].sort(
    (a, b) => b - a,
  );
  const failures = jobs.filter((j) =>
    ["failed", "uncertain"].includes(j.state),
  );
  return `<div class="execution-toolbar"><div><h2>How this task is executing</h2><p>Follow dependencies. Select a step to inspect its inputs, output, and available actions.</p></div><select id="revision-select" aria-label="Execution revision"><option value="all" ${state.route.revision === "all" ? "selected" : ""}>All revisions</option>${revisions.map((revision) => `<option value="${revision}" ${Number(state.route.revision ?? detail.task.revision) === revision ? "selected" : ""}>Revision ${revision}${revision === detail.task.revision ? " · current" : ""}</option>`).join("")}</select></div>
    ${failures.length ? `<div class="notice attention"><span>${icon("alert")}</span><div><strong>${failures.length} ${failures.length === 1 ? "step needs" : "steps need"} inspection</strong><p>${escape(failures[0].error ?? "An operation has an uncertain outcome.")}</p></div><button class="button small" data-job="${escape(failures[0].id)}">Inspect step</button></div>` : ""}
    <section class="surface graph-surface"><div class="section-heading"><h2>${icon("branch")} Execution map</h2><span>Each connection is a recorded dependency</span></div><div class="graph-scroll" data-scroll-key="graph"><div class="graph-canvas"><svg class="graph-lines" aria-hidden="true"></svg>${layers(
      jobs,
    )
      .map(
        (group, index) =>
          `<div class="graph-layer"><span class="layer-label">${index === 0 ? "START" : group.some((j) => j.kind === "controller") ? "SYNTHESIZE / CONTINUE" : "INDEPENDENT WORK"}</span>${group.map((job) => `<button class="graph-node ${job.state} ${state.route.jobId === job.id ? "selected" : ""}" data-job="${escape(job.id)}" data-node="${escape(job.id)}"><div><span class="node-kind">${escape(stepLabel(job))}</span><span class="status-dot ${escape(job.state)}"></span></div><strong>${escape(job.instruction)}</strong><span class="node-meta">${escape(job.state)} <span>rev ${job.revision} · attempt ${job.attempts}</span></span></button>`).join("")}</div>`,
      )
      .join(
        "",
      )}</div></div><div class="graph-legend"><span><i class="status-dot running"></i>Running</span><span><i class="status-dot queued"></i>Queued / dependent</span><span><i class="status-dot completed"></i>Completed</span><span><i class="status-dot failed"></i>Needs inspection</span></div></section>
    <section class="surface"><div class="section-heading"><h2>Step ledger</h2><span>${jobs.length} scheduled steps</span></div><div class="step-ledger">${jobs.map((job, index) => `<button class="ledger-row ${state.route.jobId === job.id ? "selected" : ""}" data-job="${escape(job.id)}"><span class="ledger-index">${String(index + 1).padStart(2, "0")}</span><div><strong>${escape(stepLabel(job))}</strong><span>${escape(job.instruction)}</span></div>${badge(job.state)}<span class="ledger-duration">${job.startedAt ? duration((job.finishedAt ?? Date.now()) - job.startedAt) : "—"}</span>${icon("chevron")}</button>`).join("") || '<p class="section-empty">No steps in this revision.</p>'}</div></section>`;
}
function drawGraph() {
  const canvas = $(".graph-canvas");
  if (!canvas || !selected()) return;
  const svg = $(".graph-lines");
  const rect = canvas.getBoundingClientRect();
  const jobs = revisionJobs(selected());
  svg.setAttribute("width", canvas.scrollWidth);
  svg.setAttribute("height", canvas.scrollHeight);
  svg.innerHTML = jobs
    .flatMap((job) => {
      const target = [...canvas.querySelectorAll("[data-node]")]
        .find((node) => node.dataset.node === job.id)
        ?.getBoundingClientRect();
      if (!target) return [];
      return dependencies(job, jobs).flatMap((parent) => {
        const source = [...canvas.querySelectorAll("[data-node]")]
          .find((node) => node.dataset.node === parent.id)
          ?.getBoundingClientRect();
        if (!source) return [];
        const x1 = source.right - rect.left,
          y1 = source.top + source.height / 2 - rect.top,
          x2 = target.left - rect.left,
          y2 = target.top + target.height / 2 - rect.top;
        return [
          `<path class="${job.state === "running" ? "active-edge" : ""}" d="M ${x1} ${y1} C ${x1 + 28} ${y1}, ${x2 - 28} ${y2}, ${x2} ${y2}"/>`,
        ];
      });
    })
    .join("");
}
function activityView() {
  const events = filterEvents(state.events, state.eventFilter, state.eventQuery)
    .slice()
    .reverse();
  return `<div class="execution-toolbar"><div><h2>Activity trace</h2><p>Recorded events for this task, including earlier revisions.</p></div><div class="trace-filters"><label class="search-field">${icon("search")}<input id="event-search" type="search" placeholder="Search the trace…" value="${escape(state.eventQuery)}" aria-label="Search trace"></label><select id="event-filter" aria-label="Filter trace">${[
    ["all", "All activity"],
    ["decisions", "Decisions & results"],
    ["failures", "Failures & retries"],
    ["control", "User interventions"],
    ["external", "External events"],
    ["output", "Response chunks"],
  ]
    .map(
      ([id, label]) =>
        `<option value="${id}" ${id === state.eventFilter ? "selected" : ""}>${label}</option>`,
    )
    .join("")}</select></div></div>
    <section class="surface timeline-surface"><div class="timeline-caption"><span>${events.length} matching events</span><span>Newest first · local time</span></div>${events.map((event) => `<button class="timeline-event ${String(event.seq) === state.route.eventId ? "selected" : ""}" data-event="${event.seq}"><time>${time(event.createdAt)}</time><span class="timeline-marker ${/failed|error|uncertain|limit/.test(event.kind) ? "failed" : /completed|published/.test(event.kind) ? "completed" : ""}"></span><div><strong>${escape(eventLabel(event))}</strong><span>${escape(event.data?.reason ?? event.data?.error ?? event.data?.instruction ?? (event.data?.jobId ? "Step " + short(event.data.jobId) : event.data?.event ? `${event.data.event.source} · ${event.data.event.type}` : "Task " + short(event.taskId)))}</span></div><span class="event-sequence">#${event.seq}</span>${icon("chevron")}</button>`).join("") || '<div class="section-empty">No events match this filter.</div>'}${state.hasMore ? '<div class="load-more"><button class="button small" data-action="older">Load earlier events</button></div>' : ""}</section>`;
}
function renderInspector() {
  const aside = $("#inspector");
  const detail = selected();
  const event =
    detail && state.route.eventId
      ? (state.events.find((e) => String(e.seq) === state.route.eventId) ??
        (String(state.pinnedEvent?.seq) === state.route.eventId
          ? state.pinnedEvent
          : null))
      : null;
  const job = detail?.jobs.find((j) => j.id === state.route.jobId);
  aside.hidden = !job && !event;
  if (aside.hidden) {
    aside.innerHTML = "";
    return;
  }
  if (event && !job) {
    aside.innerHTML = `<div class="inspector-heading"><span class="eyebrow">EVENT DETAILS</span><button class="icon-button" data-action="close-inspector" aria-label="Close inspector">×</button></div><div class="inspector-body" data-scroll-key="event-inspector"><h2>${escape(eventLabel(event))}</h2><p class="muted">${date(event.createdAt)} · #${event.seq}</p>${event.data?.jobId ? `<button class="button small" data-job="${escape(event.data.jobId)}">Inspect related step ${icon("arrow")}</button>` : ""}<h3>Recorded payload</h3><pre class="json-block">${escape(JSON.stringify(event.data, null, 2))}</pre></div>`;
    return;
  }
  if (!job) return;
  const decision = decisionFor(job);
  const artifact = detail.artifacts.find((a) => a.jobId === job.id);
  const parents = dependencies(job, detail.jobs);
  const children = detail.jobs.filter(
    (j) => j.dependsOn.includes(job.id) || j.parentId === job.id,
  );
  const relatedEvents = state.events.filter(
    (e) => e.data?.jobId === job.id && e.kind !== "job.output",
  );
  const blocker = retryBlocker(job, detail.jobs, detail.task);
  aside.innerHTML = `<div class="inspector-heading"><span class="eyebrow">STEP INSPECTOR</span><button class="icon-button" data-action="close-inspector" aria-label="Close inspector">×</button></div><div class="inspector-title"><div>${badge(job.state)}<span class="mono">${escape(short(job.id))}</span></div><h2>${escape(stepLabel(job))}</h2><p>${escape(job.instruction)}</p></div><div class="inspector-tabs">${[
    ["context", "Context"],
    ["output", "Output"],
    ["events", "Events"],
  ]
    .map(
      ([id, label]) =>
        `<button data-inspector-tab="${id}" class="${state.inspectorTab === id ? "selected" : ""}">${label}</button>`,
    )
    .join(
      "",
    )}</div><div class="inspector-body" data-scroll-key="inspector-${job.id}-${state.inspectorTab}">
    ${job.error ? `<div class="inspector-error"><strong>${job.state === "uncertain" ? "Outcome needs reconciliation" : "Recorded error"}</strong><p>${escape(job.error)}</p></div>` : ""}
    ${
      state.inspectorTab === "output"
        ? `<div class="section-heading"><h3>${job.state === "running" ? "Live response" : "Recorded output"}</h3>${job.state === "running" ? '<i class="live-pulse"></i>' : ""}</div>${job.kind === "controller" ? `<div class="markdown">${md(artifact?.body ?? job.output ?? "") || '<p class="muted">No response text has been recorded yet.</p>'}</div>${decision ? `<details class="protocol-details"><summary>Structured decision</summary><pre>${escape(JSON.stringify(decision, null, 2))}</pre></details>` : ""}` : `<div class="markdown">${md(job.result ?? job.output ?? "") || '<p class="muted">No output has been recorded yet.</p>'}</div>`}<p class="inspector-note">${job.state === "running" ? "Streamed text is provisional until the step completes." : job.state === "completed" ? "Output recorded from the completed step." : "Partial output belongs to this attempt and may be incomplete."}</p>`
        : state.inspectorTab === "events"
          ? relatedEvents
              .map(
                (e) =>
                  `<button class="inspector-event" data-event="${e.seq}"><span>${escape(eventLabel(e))}</span><time>${time(e.createdAt)}</time></button>`,
              )
              .join("") ||
            '<p class="muted">No events are loaded for this step.</p>'
          : `<section class="inspector-section"><h3>Decision and stated basis</h3>${decision ? `<p>${escape(decision.reason || "No rationale was attached.")}</p><span class="decision-outcome">${decision.next === "continue" ? `${decision.operations.length} operations requested` : decision.next === "wait" ? "Wait for an event" : "Complete the task"}</span>` : `<p class="muted">${job.kind === "controller" ? "The accepted decision will appear when this step completes." : "This worker was assigned a bounded operation by its parent step."}</p>`}</section>
    <section class="inspector-section"><h3>Task intent at this step</h3><p>${escape(job.basedOn?.intent ?? (job.revision === detail.task.revision ? detail.task.intent : "Intent was not recorded for this historical step."))}</p></section><section class="inspector-section"><h3>Execution context</h3><dl class="metadata"><div><dt>Revision</dt><dd>${job.revision}${job.revision !== detail.task.revision ? " · historical" : ""}</dd></div><div><dt>Attempt</dt><dd>${job.attempts}</dd></div><div><dt>Started</dt><dd>${job.startedAt ? time(job.startedAt) : "Not started"}</dd></div><div><dt>Duration</dt><dd>${job.startedAt ? duration((job.finishedAt ?? Date.now()) - job.startedAt) : "—"}</dd></div></dl></section>
    <section class="inspector-section"><h3>Depends on</h3>${parents.length ? parents.map((parent) => miniJob(parent)).join("") : '<p class="muted">No earlier step is required.</p>'}</section>
    <section class="inspector-section"><h3>Inputs available to this call</h3>${
      job.basedOn
        ? `${job.basedOn.artifactIds
            .map((id) => {
              const a = detail.artifacts.find((a) => a.id === id);
              return a
                ? `<button class="context-reference" data-artifact="${escape(id)}">${icon("file")}<span>${escape(a.title)}<small>Result · revision ${a.revision}</small></span>${icon("arrow")}</button>`
                : "";
            })
            .join("")}${job.basedOn.jobIds
            .map((id) => {
              const j = detail.jobs.find((j) => j.id === id);
              return j
                ? `<button class="context-reference" data-job="${escape(id)}">${icon("layers")}<span>${escape(stepLabel(j))}<small>Worker observation · revision ${j.revision}</small></span>${icon("arrow")}</button>`
                : "";
            })
            .join(
              "",
            )}${(job.basedOn.memory ?? []).map((memory) => `<details class="memory-input"><summary>${escape(memory.key)} · v${memory.version}</summary><p>${escape(memory.value)}</p><small>Source: ${escape(memory.source)}</small></details>`).join("")}${job.basedOn.eventIds.length ? `<p class="muted">${job.basedOn.eventIds.length} delivered event(s) included. Inspect the task activity for their payloads.</p>` : ""}${!job.basedOn.artifactIds.length && !job.basedOn.jobIds.length && !job.basedOn.eventIds.length ? '<p class="muted">Task intent and configured context; no earlier results or worker observations.</p>' : ""}`
        : '<p class="muted">Input references were not recorded for this earlier execution.</p>'
    }</section>
    <section class="inspector-section"><h3>Work that follows</h3>${children.length ? children.map((child) => miniJob(child)).join("") : '<p class="muted">No dependent steps are scheduled.</p>'}</section>`
    }
    </div>${job.state === "failed" ? `<div class="inspector-controls"><button class="button primary" data-action="retry" ${blocker ? "disabled" : ""}>${icon("refresh")} Retry this step</button><p>${escape(blocker || "Completed independent work will be preserved.")}</p></div>` : job.state === "uncertain" ? `<div class="inspector-controls"><button class="button" data-action="reconcile">Record observed outcome</button><p>Check the actual outcome before resuming this task.</p></div>` : ""}`;
}

function showConnection() {
  const dialog = $("#connection-dialog");
  if (!dialog.open) dialog.showModal();
  $("#runtime-token").focus();
}
function toggleNavigation(open) {
  $(".sidebar").classList.toggle("mobile-open", open);
  $(".sidebar").inert = matchMedia("(max-width:700px)").matches && !open;
  $("#mobile-menu").setAttribute("aria-expanded", String(open));
}
function newTask(intent = "", policy = "focused") {
  toggleNavigation(false);
  $("#task-form").reset();
  $("#task-intent").value = intent;
  $("#task-policy").value = policy;
  $("#task-error").textContent = "";
  $("#task-model-note").textContent = state.data?.demo
    ? "Scripted offline responses"
    : (state.data?.model ?? "");
  $("#task-dialog").showModal();
  $("#task-intent").focus();
}
function showAction(kind) {
  const detail = selected();
  const job = detail?.jobs.find((j) => j.id === state.route.jobId);
  if (!detail && kind !== "info") return;
  action = { kind, taskId: detail?.task.id, jobId: job?.id };
  $("#action-form").reset();
  $("#action-error").textContent = "";
  $("#action-submit").hidden = false;
  $("#action-submit").className = "button primary";
  $("#action-eyebrow").textContent =
    kind === "info" ? "CONNECTION & CAPACITY" : "TASK CONTROL";
  let title = "",
    description = "",
    fields = "",
    submit = "";
  if (kind === "pause") {
    title = "Pause this task";
    description =
      "Running steps will be interrupted and checkpointed. Existing results remain available. You can resume the task later.";
    submit = "Pause task";
  }
  if (kind === "cancel") {
    title = "Cancel this task?";
    description =
      "Pending work will stop. Completed results remain in the task history. Cancellation is permanent for this task.";
    submit = "Cancel task";
    $("#action-submit").className = "button danger";
  }
  if (kind === "resume") {
    title =
      detail.task.state === "waiting"
        ? "Run this task again"
        : "Resume this task";
    description =
      "Continue from the saved execution state and existing findings.";
    submit = "Resume task";
    fields = `<label for="extra-calls">Additional model calls</label><input id="extra-calls" type="number" min="0" max="1000" value="${detail.task.calls >= detail.task.maxCalls ? 10 : 0}"><p class="muted">${detail.task.calls} of ${detail.task.maxCalls} calls used so far.</p>`;
  }
  if (kind === "steer") {
    title = "Redirect the task";
    description =
      "Replace the full intent. Pending work in the current revision will stop; previous results stay in history and remain available as context.";
    submit = "Start a new revision";
    fields = `<label for="revised-intent">Complete revised intent</label><textarea id="revised-intent" rows="6" maxlength="32000" required>${escape(detail.task.intent)}</textarea>`;
  }
  if (kind === "retry") {
    title = "Retry this step";
    description =
      "Retry the failed operation and continue its waiting dependencies. Completed independent work is preserved.";
    submit = "Retry step";
    fields = `<div class="action-step">${escape(job.instruction)}</div><label for="extra-calls">Additional model calls</label><input id="extra-calls" type="number" min="0" max="1000" value="${detail.task.calls >= detail.task.maxCalls ? 5 : 0}">`;
  }
  if (kind === "reconcile") {
    title = "Record the actual outcome";
    description =
      "Enter what you verified in the filesystem or external system. This records an observation so the task can be resumed.";
    submit = "Record outcome";
    fields =
      '<label for="observed-outcome">Observed outcome</label><textarea id="observed-outcome" rows="5" required placeholder="Checked the external system: …"></textarea>';
  }
  if (kind === "info") {
    title = "Your local runtime";
    description = "This panel connects directly to the process serving it.";
    fields = `<dl class="metadata"><div><dt>Address</dt><dd>${escape(location.origin)}</dd></div><div><dt>Model</dt><dd>${escape(state.data?.model)}</dd></div><div><dt>Interactive slots</dt><dd>${state.data?.config.interactiveSlots}</dd></div><div><dt>Background slots</dt><dd>${state.data?.config.backgroundSlots}</dd></div><div><dt>Workers per task</dt><dd>${state.data?.config.maxWorkersPerTask}</dd></div><div><dt>Last event</dt><dd>#${state.events.at(-1)?.seq ?? state.data?.cursor ?? 0}</dd></div></dl><button type="button" class="text-button" data-action="token">Change runtime token →</button>`;
    $("#action-submit").hidden = true;
  }
  $("#action-title").textContent = title;
  $("#action-description").textContent = description;
  $("#action-fields").innerHTML = fields;
  $("#action-submit").textContent = submit;
  $("#action-dialog").showModal();
}
async function runDemo(debug) {
  try {
    const result = await api("/demo/scenario", { debug });
    navigate({
      taskId: result.taskId,
      view: debug ? "execution" : "overview",
      jobId: null,
      eventId: null,
    });
    scheduleRefresh();
  } catch (error) {
    toast(error.message);
  }
}
async function loadOlder() {
  try {
    const before = state.events[0]?.seq ?? Number.MAX_SAFE_INTEGER;
    const data = await api(
      "/history?limit=300&before=" +
        before +
        (state.route.taskId
          ? "&taskId=" + encodeURIComponent(state.route.taskId)
          : ""),
    );
    const existing = new Set(state.events.map((e) => e.seq));
    state.events = [
      ...data.events.filter((e) => !existing.has(e.seq)),
      ...state.events,
    ];
    state.hasMore = data.hasMore;
    render();
  } catch (error) {
    toast(error.message);
  }
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button, [data-task]");
  if (!target) return;
  if (target.classList.contains("close-dialog")) {
    target.closest("dialog").close();
    return;
  }
  if (target.dataset.task) {
    toggleNavigation(false);
    state.inspectorTab = "context";
    navigate({
      taskId: target.dataset.task,
      view: "overview",
      jobId: null,
      eventId: null,
      artifactId: null,
      revision: null,
    });
    return;
  }
  if (target.dataset.view) {
    navigate({ view: target.dataset.view });
    return;
  }
  if (target.dataset.job) {
    const job = selected()?.jobs.find((j) => j.id === target.dataset.job);
    state.inspectorTab = "context";
    navigate({
      jobId: target.dataset.job,
      eventId: null,
      ...(job ? { revision: String(job.revision) } : {}),
    });
    return;
  }
  if (target.dataset.event) {
    state.pinnedEvent =
      state.events.find((e) => String(e.seq) === target.dataset.event) ?? null;
    navigate({ eventId: target.dataset.event, jobId: null });
    return;
  }
  if (target.dataset.artifact) {
    navigate({ artifactId: target.dataset.artifact, view: "results" });
    return;
  }
  if (target.dataset.inspectorTab) {
    state.inspectorTab = target.dataset.inspectorTab;
    render();
    return;
  }
  if (target.dataset.taskFilter) {
    state.taskFilter = target.dataset.taskFilter;
    renderSidebar();
    return;
  }
  if (target.dataset.copy) {
    const artifact = selected()?.artifacts.find(
      (a) => a.id === target.dataset.copy,
    );
    try {
      await navigator.clipboard.writeText(artifact.body);
      toast("Result copied.");
    } catch {
      toast("Clipboard access is unavailable in this browser.");
    }
    return;
  }
  switch (target.dataset.action) {
    case "new":
      newTask();
      break;
    case "home":
      navigate({
        taskId: null,
        jobId: null,
        eventId: null,
        artifactId: null,
        view: "overview",
      });
      break;
    case "close-inspector":
      navigate({ jobId: null, eventId: null });
      break;
    case "copy-task":
      newTask(selected().task.intent, selected().task.policy);
      break;
    case "pause":
    case "resume":
    case "steer":
    case "cancel":
    case "retry":
    case "reconcile":
      showAction(target.dataset.action);
      break;
    case "demo":
      await runDemo(false);
      break;
    case "demo-debug":
      await runDemo(true);
      break;
    case "older":
      await loadOlder();
      break;
    case "reconnect":
      refresh();
      break;
    case "token":
      $("#action-dialog").close();
      showConnection();
      break;
  }
});
$("#new-task-top").onclick = $("#new-task-side").onclick = () => newTask();
$("#mobile-menu").onclick = () =>
  toggleNavigation(!$(".sidebar").classList.contains("mobile-open"));
$("#overview-link").onclick = () => {
  toggleNavigation(false);
  navigate({
    taskId: null,
    jobId: null,
    eventId: null,
    artifactId: null,
    view: "overview",
  });
};
$("#connection-button").onclick = $("#runtime-info").onclick = () =>
  state.connection === "locked" ? showConnection() : showAction("info");
$("#task-search").addEventListener("input", (event) => {
  state.taskQuery = event.target.value;
  renderSidebar();
});
document.addEventListener("input", (event) => {
  if (event.target.id === "event-search") {
    state.eventQuery = event.target.value;
    scheduleRender();
  }
});
document.addEventListener("change", (event) => {
  if (event.target.id === "event-filter") {
    state.eventFilter = event.target.value;
    render();
  }
  if (event.target.id === "revision-select")
    navigate({ revision: event.target.value });
  if (event.target.id === "artifact-select")
    navigate({ artifactId: event.target.value });
});
$("#task-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("#task-error").textContent = "";
  try {
    const task = await api("/tasks", {
      intent: $("#task-intent").value,
      policy: $("#task-policy").value,
      maxParallel: Number($("#task-parallel").value),
      ...($("#task-budget").value
        ? { maxCalls: Number($("#task-budget").value) }
        : {}),
    });
    $("#task-dialog").close();
    navigate({
      taskId: task.id,
      view: "overview",
      jobId: null,
      artifactId: null,
      eventId: null,
      revision: null,
    });
    scheduleRefresh();
  } catch (error) {
    $("#task-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$("#action-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!action || action.kind === "info") return;
  const button = $("#action-submit");
  button.disabled = true;
  $("#action-error").textContent = "";
  try {
    const { kind, taskId, jobId } = action;
    if (kind === "retry")
      await api(`/jobs/${jobId}/retry`, {
        extraCalls: Number($("#extra-calls").value),
      });
    else if (kind === "reconcile")
      await api(`/jobs/${jobId}/reconcile`, {
        result: $("#observed-outcome").value,
      });
    else
      await api(
        `/tasks/${taskId}/${kind}`,
        kind === "resume"
          ? { extraCalls: Number($("#extra-calls").value) }
          : kind === "steer"
            ? { intent: $("#revised-intent").value }
            : {},
      );
    $("#action-dialog").close();
    toast(
      {
        pause: "Task paused.",
        resume: "Task resumed.",
        steer: "New direction saved.",
        cancel: "Task cancelled.",
        retry: "Step queued for retry.",
        reconcile: "Outcome recorded. You can now resume the task.",
      }[kind],
    );
    if (kind === "steer")
      navigate({
        jobId: null,
        eventId: null,
        artifactId: null,
        revision: null,
      });
    await refresh();
  } catch (error) {
    $("#action-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$("#connection-form").onsubmit = async (event) => {
  event.preventDefault();
  state.token = $("#runtime-token").value.trim();
  $("#connection-error").textContent = "";
  try {
    await api("/health");
    sessionStorage.setItem("living.token", state.token);
    $("#runtime-token").value = "";
    $("#connection-dialog").close();
    await refresh();
  } catch (error) {
    $("#connection-error").textContent = error.message;
  }
};
window.addEventListener("hashchange", () => {
  const taskId = state.route.taskId;
  state.route = parseRoute(location.hash);
  if (taskId !== state.route.taskId) refresh();
  else render();
});
window.addEventListener("resize", () => {
  toggleNavigation($(".sidebar").classList.contains("mobile-open"));
  drawGraph();
});
window.addEventListener("beforeunload", () => streamController?.abort());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
    toggleNavigation(false);
    if (state.route.jobId || state.route.eventId)
      navigate({ jobId: null, eventId: null });
  }
  const editing =
    /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) ||
    document.activeElement.isContentEditable;
  if (
    event.key.toLowerCase() === "n" &&
    !editing &&
    !document.querySelector("dialog[open]") &&
    !event.metaKey &&
    !event.ctrlKey
  ) {
    event.preventDefault();
    newTask();
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key === "Enter" &&
    $("#task-dialog").open
  ) {
    event.preventDefault();
    $("#task-form").requestSubmit($('#task-form button[type="submit"]'));
  }
});
toggleNavigation(false);
void refresh();
