const elements = {
  goal: document.getElementById("goal"),
  maxStep: document.getElementById("maxStep"),
  startRun: document.getElementById("startRun"),
  stopRun: document.getElementById("stopRun"),
  batchFile: document.getElementById("batchFile"),
  batchIdField: document.getElementById("batchIdField"),
  batchPromptField: document.getElementById("batchPromptField"),
  startBatch: document.getElementById("startBatch"),
  batchStatus: document.getElementById("batchStatus"),
  clearLog: document.getElementById("clearLog"),
  copyResult: document.getElementById("copyResult"),
  exportResult: document.getElementById("exportResult"),
  downloadArtifact: document.getElementById("downloadArtifact"),
  downloadRecording: document.getElementById("downloadRecording"),
  openOptions: document.getElementById("openOptions"),
  log: document.getElementById("log"),
  result: document.getElementById("result"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  tabInfo: document.getElementById("tabInfo")
};

const RECORDING_MIME_TYPES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm"
];

const DEFAULT_ID_FIELD = "id";
const DEFAULT_PROMPT_FIELD = "prompt";
const DEFAULT_MAX_STEP = 100;
const ZIP_UTF8_FLAG = 0x0800;

let port = null;
let latestResult = null;
let latestSummary = null;
let runActive = false;
let activeRunTabId = null;
let currentRunLogEntries = [];
let pendingRunCompletion = null;
let batchRows = [];
let batchHeaders = [];
let batchActive = false;
let batchAbortRequested = false;
let mediaRecorder = null;
let recordingStream = null;
let recordedChunks = [];
let recordingBlob = null;
let recordingUrl = "";
let recordingMimeType = "video/webm";
let recordingStartedAt = "";
let recordingEndedAt = "";
let recordingStopPromise = null;
let recordingKeepStreamOnStop = false;
let currentRunCheckpointScreenshots = [];
let currentRunCheckpoints = [];
let currentRunFinalSnapshot = null;
let latestRunScreenshots = [];
let latestRunCheckpoints = [];
let latestRunFinalSnapshot = null;

connectPort();
restoreDraft();

elements.startRun.addEventListener("click", async () => {
  const goal = elements.goal.value.trim();
  const maxStep = Number.parseInt(elements.maxStep.value, 10) || DEFAULT_MAX_STEP;
  if (!goal) {
    addLog("error", "Goal is required.");
    return;
  }

  chrome.storage.local.set({ lastGoal: goal, lastMaxStep: maxStep });
  await startAgentRun({ goal, maxStep });
});

elements.stopRun.addEventListener("click", () => {
  requestStop();
});

elements.batchFile.addEventListener("change", async () => {
  const file = elements.batchFile.files?.[0];
  if (!file) {
    batchRows = [];
    batchHeaders = [];
    refreshBatchControls();
    setBatchStatus("No batch file");
    return;
  }

  setBatchStatus("Parsing batch file...");
  try {
    const parsed = await parseBatchFile(file);
    batchRows = parsed.rows;
    batchHeaders = parsed.headers;
    autoFillBatchFields(batchHeaders);
    setBatchStatus(`${batchRows.length} task(s) loaded`);
    addLog("ok", `Batch file loaded: ${file.name} (${batchRows.length} task(s)).`);
  } catch (error) {
    batchRows = [];
    batchHeaders = [];
    setBatchStatus("Could not parse file");
    addLog("error", `Could not parse batch file: ${getErrorMessage(error)}`);
  } finally {
    refreshBatchControls();
  }
});

elements.startBatch.addEventListener("click", () => {
  runBatch().catch((error) => {
    setBatchRunning(false);
    setStatus("error", "Batch failed");
    addLog("error", `Batch failed: ${getErrorMessage(error)}`);
    stopRecordingStream();
  });
});

window.addEventListener("keydown", (event) => {
  if (!runActive) return;
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key?.toLowerCase() !== "a" && event.code !== "KeyA") return;

  event.preventDefault();
  event.stopImmediatePropagation();
  requestStop("keyboard shortcut");
}, true);

elements.clearLog.addEventListener("click", () => {
  elements.log.textContent = "";
});

elements.copyResult.addEventListener("click", async () => {
  if (!latestSummary) return;
  await navigator.clipboard.writeText(JSON.stringify(latestSummary, null, 2));
  addLog("ok", "Summary JSON copied.");
});

elements.exportResult.addEventListener("click", async () => {
  if (!latestResult) return;
  elements.exportResult.disabled = true;
  addLog("info", "Preparing JSON download.");
  await delayFrame();
  try {
    exportJson(latestResult);
    addLog("ok", "Full JSON download started.");
  } finally {
    elements.exportResult.disabled = false;

    elements.downloadArtifact.disabled = false;
  }
});

elements.downloadRecording.addEventListener("click", () => {
  if (!recordingBlob) return;
  exportRecording();
});

elements.openOptions.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function startAgentRun({
  goal,
  maxStep,
  batchItem = null,
  keepRecordingStream = false
}) {
  setRunning(true);
  setStatus("running", batchItem ? `Running batch ${batchItem.index + 1}/${batchItem.total}` : "Running");
  latestResult = null;
  latestSummary = null;
  activeRunTabId = null;
  currentRunLogEntries = [];
  currentRunCheckpointScreenshots = [];
  currentRunCheckpoints = [];
  currentRunFinalSnapshot = null;
  latestRunScreenshots = [];
  latestRunCheckpoints = [];
  latestRunFinalSnapshot = null;
  pendingRunCompletion = null;
  elements.result.textContent = "";
  elements.copyResult.disabled = true;
  elements.exportResult.disabled = true;
  resetRecordingState({ preserveStream: keepRecordingStream });

  const completionPromise = new Promise((resolve) => {
    pendingRunCompletion = { resolve, batchItem };
  });

  if (batchItem) {
    addLog("info", `Batch item ${batchItem.index + 1}/${batchItem.total}: ${batchItem.id}`);
  }

  const recordingReady = await startRecording({ keepStreamWhenStopped: keepRecordingStream });
  if (!postToAgent({ type: "RUN_AGENT", payload: { goal, max_step: maxStep } })) {
    await stopRecording("agent start failed");
    resolveCurrentRun({
      status: "error",
      summary: "Could not connect to background.",
      result: latestResult,
      recording: getRecordingArtifact(),
      logs: currentRunLogEntries.slice(),

      screenshots: latestRunScreenshots.slice(),
      checkpoints: latestRunCheckpoints.slice(),
      finalSnapshot: latestRunFinalSnapshot
    });
    return { ok: false, completion: completionPromise };
  }

  addLog("info", "Run started.");
  if (!recordingReady) {
    addLog("warn", "Agent is running without recording.");
  }

  return { ok: true, completion: completionPromise };
}

function connectPort() {
  if (port) return port;

  port = chrome.runtime.connect({ name: "agent-panel" });
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || "";
    port = null;
    if (runActive) {
      setRunning(false);
      setStatus("error", "Background connection lost");
      addLog("error", `Background connection lost${reason ? `: ${reason}` : ""}. Start the run again.`);
      cleanupActivePageFromPanel();
      stopRecording("background connection lost").then(() => {
        resolveCurrentRun({
          status: "error",
          summary: `Background connection lost${reason ? `: ${reason}` : ""}.`,
          result: latestResult,
          recording: getRecordingArtifact(),
          logs: currentRunLogEntries.slice(),

          screenshots: latestRunScreenshots.slice(),
          checkpoints: latestRunCheckpoints.slice(),
          finalSnapshot: latestRunFinalSnapshot
        });
      });
      activeRunTabId = null;
    }
  });
  return port;
}

function postToAgent(message) {
  try {
    connectPort().postMessage(message);
    return true;
  } catch (error) {
    port = null;
  }

  try {
    connectPort().postMessage(message);
    return true;
  } catch (error) {
    port = null;
    setRunning(false);
    setStatus("error", "Could not connect to background");
    addLog("error", `Could not connect to background: ${getErrorMessage(error)}`);
    return false;
  }
}

function handlePortMessage(message) {
  if (!message?.type) return;

  if (message.type === "status") {
    if (message.state === "running") {
      setRunning(true);
      setStatus("running", "Running");
      if (message.tab) {
        activeRunTabId = message.tab.id || null;
        elements.tabInfo.textContent = `${message.tab.title || "Untitled"} - ${message.tab.url}`;
      }
    }

    if (message.state === "idle") {
      setRunning(false);
      cleanupActivePageFromPanel();
      activeRunTabId = null;
      if (!latestResult) setStatus("idle", "Idle");
    }
    return;
  }

  if (message.type === "log") {
    addLog(message.level || "info", message.message || "");
    return;
  }

  if (message.type === "snapshot") {
    addLog("info", `Step ${message.step}: ${message.title || "Untitled"} (${message.elementCount} action targets found).`);
    return;
  }

  if (message.type === "decision") {
    const action = message.action || {};
    const target = action.elementId ? ` ${action.elementId}` : "";
    const thought = message.thought ? ` - ${message.thought}` : "";
    addLog("info", `Step ${message.step}: ${action.type}${target}${thought}`);
    return;
  }

  if (message.type === "action_result") {
    const result = message.result || {};
    addLog(result.ok ? "ok" : "error", `Step ${message.step}: ${result.message || result.error || "Action finished."}`);
    return;
  }

  if (message.type === "checkpoint") {
    const step = Number(message.step) || 0;
    currentRunCheckpoints = currentRunCheckpoints.filter((item) => item.step !== step);
    currentRunCheckpoints.push({
      step,
      eventType: message.eventType || "website_state_stable",
      stability: message.stability || "stable",
      createdAt: message.createdAt || message.screenshot?.capturedAt || new Date().toISOString(),
      page: message.page || null,
      pageSnapshot: message.pageSnapshot ? summarizePageArchiveSnapshot(message.pageSnapshot) : null,
      trigger: message.trigger || {},
      screenshotError: message.screenshotError || "",
      screenshot: message.screenshot?.dataUrl
        ? {
            dataUrl: message.screenshot.dataUrl,
            mimeType: message.screenshot.mimeType || "image/png",
            width: Number(message.screenshot.width) || 0,
            height: Number(message.screenshot.height) || 0,
            capturedAt: message.screenshot.capturedAt || message.createdAt || new Date().toISOString()
          }
        : null
    });
    if (message.screenshot?.dataUrl) {
      currentRunCheckpointScreenshots = currentRunCheckpointScreenshots.filter((item) => item.step !== step);
      currentRunCheckpointScreenshots.push({
        step,
        dataUrl: message.screenshot.dataUrl,
        mimeType: message.screenshot.mimeType || "image/png",
        width: Number(message.screenshot.width) || 0,
        height: Number(message.screenshot.height) || 0,
        capturedAt: message.screenshot.capturedAt || new Date().toISOString()
      });
    }
    if (message.pageSnapshot) {
      currentRunFinalSnapshot = {
        ...message.pageSnapshot,
        step,
        eventType: message.eventType || "final_result_stable",
        checkpointCapturedAt: message.createdAt || new Date().toISOString()
      };
    }
    if (message.screenshotError && !message.screenshot?.dataUrl) {
      addLog("warn", `Step ${step}: screenshot capture failed (${message.screenshotError}).`);
    } else if (message.screenshot?.dataUrl) {
      addLog("info", `Step ${step}: website screenshot captured (${message.eventType || "website_state_stable"}).`);
    } else {
      addLog("warn", `Step ${step}: no screenshot was captured.`);
    }
    return;
  }

  if (message.type === "final") {
    completeRunFromFinalMessage(message).catch((error) => {
      addLog("error", `Could not finalize run: ${getErrorMessage(error)}`);
    });
    return;
  }

  if (message.type === "error") {
    completeRunFromErrorMessage(message).catch((error) => {
      addLog("error", `Could not finalize error: ${getErrorMessage(error)}`);
    });
  }
}

async function completeRunFromFinalMessage(message) {
  latestResult = {
    status: message.status,
    summary: message.summary,
    data: message.data,
    observations: message.observations || [],
    transcript: message.transcript || null
  };
  latestSummary = createResultSummary(latestResult);

  latestRunScreenshots = currentRunCheckpointScreenshots.slice();
  latestRunCheckpoints = currentRunCheckpoints.slice();
  latestRunFinalSnapshot = currentRunFinalSnapshot;
  elements.result.textContent = JSON.stringify(latestSummary, null, 2);
  elements.copyResult.disabled = false;
  elements.exportResult.disabled = false;

  elements.downloadArtifact.disabled = false;
  setRunning(false);
  setStatus(["fail", "error"].includes(message.status) ? "error" : "done", message.summary || message.status || "Done");
  addLog(["fail", "error"].includes(message.status) ? "error" : "ok", message.summary || "Run finished.");
  await cleanupActivePageFromPanel(message.transcript?.tab?.id);
  await stopRecording("run finished");
  activeRunTabId = null;
  resolveCurrentRun({
    status: message.status,
    summary: message.summary,
    result: latestResult,
    recording: getRecordingArtifact(),
    logs: currentRunLogEntries.slice(),

    screenshots: latestRunScreenshots.slice(),
    checkpoints: latestRunCheckpoints.slice(),
    finalSnapshot: latestRunFinalSnapshot
  });
}

async function completeRunFromErrorMessage(message) {
  setRunning(false);
  await stopRecording("run error");
  await cleanupActivePageFromPanel(message.transcript?.tab?.id);
  activeRunTabId = null;
  if (message.transcript && !latestResult) {
    latestResult = {
      status: "error",
      summary: message.message || "Error",
      data: null,
      observations: [],
      transcript: message.transcript
    };
    latestSummary = createResultSummary(latestResult);

    latestRunScreenshots = currentRunCheckpointScreenshots.slice();
    latestRunCheckpoints = currentRunCheckpoints.slice();
    latestRunFinalSnapshot = currentRunFinalSnapshot;
    elements.result.textContent = JSON.stringify(latestSummary, null, 2);
    elements.copyResult.disabled = false;
    elements.exportResult.disabled = false;

    elements.downloadArtifact.disabled = false;
  }
  setStatus("error", message.message || "Error");
  addLog("error", message.message || "Unknown error.");
  resolveCurrentRun({
    status: "error",
    summary: message.message || "Error",
    result: latestResult,
    recording: getRecordingArtifact(),
    logs: currentRunLogEntries.slice(),

    screenshots: latestRunScreenshots.slice(),
    checkpoints: latestRunCheckpoints.slice(),
    finalSnapshot: latestRunFinalSnapshot
  });
}

function resolveCurrentRun(payload) {
  if (!pendingRunCompletion) return;
  const completion = pendingRunCompletion;
  pendingRunCompletion = null;
  completion.resolve({
    batchItem: completion.batchItem,
    ...payload
  });
}

async function restoreDraft() {
  const data = await chrome.storage.local.get({ lastGoal: "", lastMaxStep: 0, lastMaxSteps: DEFAULT_MAX_STEP });
  elements.goal.value = data.lastGoal || "";
  elements.maxStep.value = data.lastMaxStep || data.lastMaxSteps || DEFAULT_MAX_STEP;
}

function setRunning(isRunning) {
  runActive = isRunning;
  elements.startRun.disabled = isRunning || batchActive;
  elements.stopRun.disabled = !isRunning;
  refreshBatchControls();
}

function setStatus(kind, text) {
  elements.statusDot.className = `dot ${kind}`;
  elements.statusText.textContent = text;
}

function addLog(level, message) {
  const at = new Date().toISOString();
  currentRunLogEntries.push({ at, level, message });

  const item = document.createElement("li");
  const meta = document.createElement("span");
  const body = document.createElement("span");

  meta.className = `meta ${level}`;
  meta.textContent = `${new Date(at).toLocaleTimeString()} - ${level.toUpperCase()}`;
  body.textContent = message;

  item.append(meta, body);
  elements.log.appendChild(item);
  elements.log.scrollTop = elements.log.scrollHeight;
}

function requestStop(source = "Stop button") {
  if (!runActive) return;
  if (batchActive) {
    batchAbortRequested = true;
  }
  postToAgent({ type: "STOP_AGENT" });
  elements.stopRun.disabled = true;
  setStatus("running", "Stopping");
  addLog("warn", `Stop requested by ${source}.`);
  stopRecording("user stopped");
  cleanupActivePageFromPanel();
}

async function cleanupActivePageFromPanel(tabId = activeRunTabId) {
  if (!tabId) return;

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "SET_AGENT_ACTIVITY",
      active: false
    });
  } catch (_error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["src/contentScript.js"]
      });
      await delay(100);
      await chrome.tabs.sendMessage(tabId, {
        type: "SET_AGENT_ACTIVITY",
        active: false
      });
    } catch (_nestedError) {
      // The page may have navigated away or become unavailable; there is nothing else to clean up from the panel.
    }
  }
}

async function runBatch() {
  if (batchActive || runActive) return;
  if (batchRows.length === 0) {
    addLog("error", "Load a CSV or XLSX batch file first.");
    return;
  }

  const idField = elements.batchIdField.value.trim() || DEFAULT_ID_FIELD;
  const promptField = elements.batchPromptField.value.trim() || DEFAULT_PROMPT_FIELD;
  const idKey = findHeaderKey(batchHeaders, idField);
  const promptKey = findHeaderKey(batchHeaders, promptField);
  if (!promptKey) {
    addLog("error", `Prompt field not found: ${promptField}`);
    return;
  }
  if (!idKey) {
    addLog("error", `ID field not found: ${idField}`);
    return;
  }

  const maxStep = Number.parseInt(elements.maxStep.value, 10) || DEFAULT_MAX_STEP;
  const goalTemplate = elements.goal.value.trim();
  setBatchRunning(true);
  batchAbortRequested = false;
  setBatchStatus(`Running 0/${batchRows.length}`);
  chrome.storage.local.set({ lastGoal: goalTemplate, lastMaxStep: maxStep });
  addLog("info", `Batch started with ${batchRows.length} task(s).`);

  try {
    for (let index = 0; index < batchRows.length; index += 1) {
      if (batchAbortRequested) break;

      const row = batchRows[index];
      const rawId = String(row[idKey] ?? "").trim();
      const id = rawId || `row-${index + 1}`;
      const prompt = String(row[promptKey] ?? "").trim();
      const goal = renderBatchGoal({
        template: goalTemplate,
        row,
        id,
        idKey,
        prompt,
        promptKey
      });
      if (!goal) {
        addLog("warn", `Batch item ${index + 1} skipped: empty rendered goal.`);
        continue;
      }

      elements.goal.value = goal;
      setBatchStatus(`Running ${index + 1}/${batchRows.length}: ${id}`);
      const started = await startAgentRun({
        goal,
        maxStep,
        keepRecordingStream: true,
        batchItem: {
          id,
          index,
          total: batchRows.length,
          row,
          prompt,
          goalTemplate,
          renderedGoal: goal
        }
      });
      const completed = await started.completion;
      await exportBatchRunZip({
        id,
        index,
        total: batchRows.length,
        row,
        promptField: promptKey,
        idField: idKey,
        goalTemplate,
        renderedGoal: goal,
        completed
      });

      if (!started.ok || completed.status === "error" || completed.status === "stopped") {
        if (completed.status === "stopped" || batchAbortRequested) {
          batchAbortRequested = true;
          break;
        }
      }

      await delayFrame();
    }

    setBatchStatus(batchAbortRequested ? "Batch stopped" : `Batch finished (${batchRows.length} task(s))`);
    addLog(batchAbortRequested ? "warn" : "ok", batchAbortRequested ? "Batch stopped." : "Batch finished.");
  } finally {
    elements.goal.value = goalTemplate;
    stopRecordingStream();
    setBatchRunning(false);
  }
}

function setBatchRunning(isRunning) {
  batchActive = isRunning;
  elements.startRun.disabled = isRunning || runActive;
  refreshBatchControls();
}

function refreshBatchControls() {
  const hasRows = batchRows.length > 0;
  elements.startBatch.disabled = batchActive || runActive || !hasRows;
  elements.batchFile.disabled = batchActive || runActive;
  elements.batchIdField.disabled = batchActive || runActive;
  elements.batchPromptField.disabled = batchActive || runActive;
}

function setBatchStatus(text) {
  elements.batchStatus.textContent = text;
}

function autoFillBatchFields(headers) {
  const idKey = findHeaderKey(headers, DEFAULT_ID_FIELD) || findHeaderKey(headers, "ID");
  const promptKey = findHeaderKey(headers, DEFAULT_PROMPT_FIELD) || findHeaderKey(headers, "goal") || findHeaderKey(headers, "task");
  if (idKey) elements.batchIdField.value = idKey;
  if (promptKey) elements.batchPromptField.value = promptKey;
}

function findHeaderKey(headers, name) {
  const normalized = normalizeHeaderName(name);
  return headers.find((header) => normalizeHeaderName(header) === normalized) || "";
}

function normalizeHeaderName(value) {
  return String(value || "").trim().toLowerCase();
}

function renderBatchGoal({ template, row, id, idKey, prompt, promptKey }) {
  const trimmedTemplate = String(template || "").trim();
  if (!trimmedTemplate) return prompt;

  const values = new Map();
  for (const [key, value] of Object.entries(row)) {
    values.set(normalizeHeaderName(key), String(value ?? ""));
  }
  values.set("id", String(row[idKey] ?? id ?? ""));
  values.set("prompt", String(row[promptKey] ?? prompt ?? ""));

  if (!hasTemplatePlaceholder(trimmedTemplate)) {
    return [trimmedTemplate, prompt].filter(Boolean).join("\n\n");
  }

  return trimmedTemplate
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, name) => {
      return values.get(normalizeHeaderName(name)) ?? "";
    })
    .trim();
}

function hasTemplatePlaceholder(template) {
  return /\{\{\s*[^{}]+?\s*\}\}/.test(template);
}

async function exportBatchRunZip({ id, index, total, row, promptField, idField, goalTemplate, renderedGoal, completed }) {
  const safeId = sanitizeFileName(id, `row-${index + 1}`);
  const folder = safeId;
  const result = completed.result || {
    status: completed.status || "unknown",
    summary: completed.summary || "",
    data: null,
    observations: [],
    transcript: null
  };
  const recording = completed.recording || getRecordingArtifact();
  const screenshots = Array.isArray(completed.screenshots) ? completed.screenshots : [];
  const checkpoints = Array.isArray(completed.checkpoints) ? completed.checkpoints : [];
  const finalSnapshot = completed.finalSnapshot || null;
  const metadata = {
    id,
    rowIndex: index + 1,
    total,
    idField,
    promptField,
    goalTemplate,
    renderedGoal,
    row,
    exportedAt: new Date().toISOString(),
    status: completed.status,
    summary: completed.summary
  };
  const runArtifact = buildRunArtifactFromResult(result, {
    recording,
    screenshots,
    checkpoints,
    finalSnapshot,
    runId: result.transcript?.id || safeId,
    taskId: id,
    taskGoal: renderedGoal,
    taskAttrs: {
      batch_row: row,
      batch_row_index: index + 1,
      batch_total: total,
      prompt_field: promptField,
      id_field: idField,
      goal_template: goalTemplate,
      rendered_goal: renderedGoal
    }
  });
  const assetFiles = await buildRunArtifactAssetFiles(runArtifact, {
    recording,
    prefix: folder
  });
  const exportArtifact = stripInlineArtifactData(runArtifact);
  const files = [
    {
      path: `${folder}/metadata.json`,
      data: JSON.stringify(metadata, null, 2)
    },
    {
      path: `${folder}/result.json`,
      data: JSON.stringify(result, null, 2)
    },
    {
      path: `${folder}/run-artifact.v1.json`,
      data: JSON.stringify(exportArtifact, null, 2)
    },
    {
      path: `${folder}/log.txt`,
      data: logsToText(completed.logs || [])
    },
    ...assetFiles
  ];

  const zipBlob = await createZipBlob(files);
  downloadBlob(zipBlob, `${safeId}.zip`);
  addLog("ok", `Batch item ${index + 1}/${total} exported: ${safeId}.zip`);
}

function logsToText(entries) {
  return entries
    .map((entry) => `${entry.at} [${entry.level.toUpperCase()}] ${entry.message}`)
    .join("\n")
    .concat(entries.length ? "\n" : "");
}

function createResultSummary(result) {
  const transcript = result.transcript || null;
  return {
    status: result.status,
    summary: result.summary,
    data: result.data,
    observations: result.observations || [],
    transcript: transcript
      ? {
          id: transcript.id,
          startedAt: transcript.startedAt,
          endedAt: transcript.endedAt,
          goal: transcript.goal,
          max_step: transcript.max_step,
          tab: transcript.tab,
          llm: transcript.llm,
          stepCount: Array.isArray(transcript.steps) ? transcript.steps.length : 0,
          eventCount: Array.isArray(transcript.events) ? transcript.events.length : 0,
          final: transcript.final,
          note: "Full prompt/response/tool transcript is available via Download JSON."
        }
      : null
  };
}

function exportJson(value) {
  const json = JSON.stringify(value, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadBlob(blob, `auto-agent-tester-${timestamp}.json`, true);
}

async function startRecording(options = {}) {
  recordingKeepStreamOnStop = Boolean(options.keepStreamWhenStopped);
  if (typeof MediaRecorder === "undefined") {
    addLog("warn", "Recording unavailable: MediaRecorder is not available in this browser.");
    return false;
  }

  try {
    if (!hasActiveRecordingStream()) {
      const activeTab = await getActiveTabForRecording();
      if (activeTab?.url && !/^https?:\/\//i.test(activeTab.url)) {
        addLog("warn", `Recording skipped: Chrome cannot capture this page type (${activeTab.url}).`);
        return false;
      }

      recordingStream = await captureRecordingStream();
      if (!recordingStream) {
        return false;
      }
    }

    recordedChunks = [];
    recordingBlob = null;
    recordingUrl = "";
    recordingEndedAt = "";

    recordingMimeType = getSupportedRecordingMimeType();
    const recorderOptions = recordingMimeType ? { mimeType: recordingMimeType } : undefined;
    mediaRecorder = new MediaRecorder(recordingStream, recorderOptions);
    recordingMimeType = mediaRecorder.mimeType || recordingMimeType || "video/webm";
    recordingStartedAt = new Date().toISOString();

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size > 0) {
        recordedChunks.push(event.data);
      }
    });

    mediaRecorder.addEventListener("stop", finalizeRecording, { once: true });
    mediaRecorder.addEventListener("error", (event) => {
      const message = event.error?.message || "MediaRecorder error.";
      addLog("error", `Recording error: ${message}`);
    });

    for (const track of recordingStream.getTracks()) {
      track.addEventListener("ended", () => {
        if (mediaRecorder?.state === "recording") {
          stopRecording("capture stream ended");
        }
      }, { once: true });
    }

    mediaRecorder.start(1000);
    addLog("info", "Recording started.");
    return true;
  } catch (error) {
    stopRecordingStream();
    mediaRecorder = null;
    addLog("warn", `Recording unavailable: ${explainRecordingError(error)}`);
    return false;
  }
}

async function captureRecordingStream() {
  if (!chrome.tabCapture?.capture) {
    addLog("warn", "Silent tab recording unavailable: chrome.tabCapture is not available.");
    return captureWithDesktopPicker();
  }

  try {
    return await captureActiveTab();
  } catch (error) {
    addLog("warn", `Silent tab recording failed: ${explainRecordingError(error)}`);
    return captureWithDesktopPicker();
  }
}

function captureActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture({
      audio: false,
      video: true
    }, (stream) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || "Tab capture failed."));
        return;
      }
      resolve(stream);
    });
  });
}

async function captureWithDesktopPicker() {
  if (!chrome.desktopCapture?.chooseDesktopMedia) {
    addLog("warn", "Manual recording fallback unavailable: chrome.desktopCapture is not available.");
    return null;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    addLog("warn", "Manual recording fallback unavailable: getUserMedia is not available.");
    return null;
  }

  addLog("info", "Select the current test tab in Chrome's recording picker.");
  const streamId = await chooseDesktopMedia();
  if (!streamId) {
    addLog("warn", "Recording picker was cancelled.");
    return null;
  }

  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: streamId
      }
    }
  });
}

function chooseDesktopMedia() {
  return new Promise((resolve) => {
    chrome.desktopCapture.chooseDesktopMedia(["tab", "window", "screen"], (streamId) => {
      resolve(streamId || "");
    });
  });
}

async function getActiveTabForRecording() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch (_error) {
    return null;
  }
}

function stopRecording(reason = "run finished") {
  const recorder = mediaRecorder;
  if (!recorder) {
    if (!recordingKeepStreamOnStop) {
      stopRecordingStream();
    }
    return Promise.resolve(false);
  }

  if (recordingStopPromise) {
    return recordingStopPromise;
  }

  if (recorder.state === "inactive") {
    if (!recordingKeepStreamOnStop) {
      stopRecordingStream();
    }
    return Promise.resolve(false);
  }

  addLog("info", `Stopping recording: ${reason}.`);
  recordingEndedAt = new Date().toISOString();
  recordingStopPromise = new Promise((resolve) => {
    recorder.addEventListener("stop", () => resolve(true), { once: true });
    try {
      if (recorder.state === "recording") {
        recorder.requestData();
      }
      recorder.stop();
    } catch (error) {
      addLog("warn", `Could not stop recording cleanly: ${getErrorMessage(error)}`);
      finalizeRecording();
      resolve(false);
    }
  }).finally(() => {
    recordingStopPromise = null;
  });

  return recordingStopPromise;
}

function finalizeRecording() {
  if (!recordingEndedAt) {
    recordingEndedAt = new Date().toISOString();
  }

  if (!recordingKeepStreamOnStop) {
    stopRecordingStream();
  }

  if (recordedChunks.length === 0) {
    mediaRecorder = null;
    addLog("warn", "Recording stopped, but no video data was captured.");
    return;
  }

  if (recordingUrl) {
    URL.revokeObjectURL(recordingUrl);
  }
  recordingBlob = new Blob(recordedChunks, { type: recordingMimeType || "video/webm" });
  recordingUrl = URL.createObjectURL(recordingBlob);
  mediaRecorder = null;
  elements.downloadRecording.disabled = false;
  addLog("ok", `Recording ready (${formatBytes(recordingBlob.size)}).`);
}

function stopRecordingStream() {
  if (!recordingStream) return;
  for (const track of recordingStream.getTracks()) {
    try {
      track.stop();
    } catch (_error) {
      // Ignore track stop errors; the recorder cleanup path should still finish.
    }
  }
  recordingStream = null;
}

function hasActiveRecordingStream() {
  return Boolean(recordingStream && recordingStream.getTracks().some((track) => track.readyState === "live"));
}

function resetRecordingState(options = {}) {
  if (recordingUrl) {
    URL.revokeObjectURL(recordingUrl);
  }
  if (!options.preserveStream) {
    stopRecordingStream();
  }
  mediaRecorder = null;
  recordedChunks = [];
  recordingBlob = null;
  recordingUrl = "";
  recordingMimeType = "video/webm";
  recordingStartedAt = "";
  recordingEndedAt = "";
  recordingStopPromise = null;
  recordingKeepStreamOnStop = false;
  currentRunCheckpointScreenshots = [];
  currentRunCheckpoints = [];
  currentRunFinalSnapshot = null;
  latestRunScreenshots = [];
  latestRunCheckpoints = [];
  latestRunFinalSnapshot = null;
  elements.downloadRecording.disabled = true;
  elements.downloadArtifact.disabled = true;
}

function exportRecording() {
  const timestamp = (recordingStartedAt || new Date().toISOString()).replace(/[:.]/g, "-");
  const extension = recordingMimeType.includes("mp4") ? "mp4" : "webm";
  downloadBlob(recordingBlob, `auto-agent-tester-recording-${timestamp}.${extension}`, false, recordingUrl);
  addLog("ok", "Recording download started.");
}

function getRecordingArtifact() {
  const extension = recordingMimeType.includes("mp4") ? "mp4" : "webm";
  return {
    blob: recordingBlob,
    mimeType: recordingMimeType || "video/webm",
    extension,
    startedAt: recordingStartedAt,
    endedAt: recordingEndedAt
  };
}

function downloadBlob(blob, filename, revokeUrl = true, existingUrl = "") {
  const url = existingUrl || URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (revokeUrl && !existingUrl) {
    window.setTimeout(() => URL.revokeObjectURL(url), 30 * 1000);
  }
}

function sanitizeFileName(value, fallback) {
  const text = String(value || "").trim() || fallback;
  return text
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+$/, fallback)
    .slice(0, 120) || fallback;
}

function getSupportedRecordingMimeType() {
  for (const mimeType of RECORDING_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return "";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

async function parseBatchFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) {
    return parseCsvRows(await file.text());
  }
  if (name.endsWith(".xlsx")) {
    return parseXlsxRows(await file.arrayBuffer());
  }
  throw new Error("Only CSV and XLSX files are supported.");
}

function parseCsvRows(text) {
  const delimiter = detectCsvDelimiter(text);
  const table = parseCsvTable(String(text || "").replace(/^\uFEFF/, ""), delimiter)
    .filter((row) => row.some((cell) => String(cell || "").trim() !== ""));
  if (table.length < 2) {
    throw new Error("CSV must include a header row and at least one data row.");
  }

  const headers = normalizeHeaders(table[0]);
  const rows = table.slice(1).map((row) => rowToObject(headers, row));
  return { headers, rows };
}

function detectCsvDelimiter(text) {
  const sample = String(text || "").split(/\r?\n/).find((line) => line.trim()) || "";
  const candidates = [",", "\t", ";"];
  let best = ",";
  let bestCount = -1;
  for (const candidate of candidates) {
    let count = 0;
    let quoted = false;
    for (let index = 0; index < sample.length; index += 1) {
      const char = sample[index];
      if (char === '"') quoted = !quoted;
      if (!quoted && char === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function parseCsvTable(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (!quoted && char === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

async function parseXlsxRows(buffer) {
  const files = await unzipFiles(buffer);
  const workbook = parseXmlFile(files, "xl/workbook.xml");
  const sheetPath = getFirstWorksheetPath(files, workbook);
  const sharedStrings = files.has("xl/sharedStrings.xml")
    ? parseSharedStrings(parseXmlFile(files, "xl/sharedStrings.xml"))
    : [];
  const sheet = parseXmlFile(files, sheetPath);
  const table = parseSheetRows(sheet, sharedStrings)
    .filter((row) => row.some((cell) => String(cell || "").trim() !== ""));

  if (table.length < 2) {
    throw new Error("XLSX must include a header row and at least one data row.");
  }

  const headers = normalizeHeaders(table[0]);
  const rows = table.slice(1).map((row) => rowToObject(headers, row));
  return { headers, rows };
}

function normalizeHeaders(rawHeaders) {
  const seen = new Map();
  return rawHeaders.map((header, index) => {
    const base = String(header || "").trim() || `column_${index + 1}`;
    const count = seen.get(base.toLowerCase()) || 0;
    seen.set(base.toLowerCase(), count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function rowToObject(headers, row) {
  return headers.reduce((object, header, index) => {
    object[header] = row[index] ?? "";
    return object;
  }, {});
}

function parseXmlFile(files, path) {
  const data = files.get(path);
  if (!data) throw new Error(`XLSX is missing ${path}.`);
  const text = new TextDecoder().decode(data);
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const error = getXmlElements(doc, "parsererror")[0];
  if (error) throw new Error(`Could not parse ${path}.`);
  return doc;
}

function getFirstWorksheetPath(files, workbook) {
  const firstSheet = getXmlElements(workbook, "sheet")[0];
  const relId = firstSheet?.getAttribute("r:id") || firstSheet?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
  if (!relId) {
    if (files.has("xl/worksheets/sheet1.xml")) return "xl/worksheets/sheet1.xml";
    throw new Error("XLSX workbook does not reference a worksheet.");
  }

  const rels = parseXmlFile(files, "xl/_rels/workbook.xml.rels");
  const relationship = getXmlElements(rels, "Relationship").find((item) => item.getAttribute("Id") === relId);
  const target = relationship?.getAttribute("Target");
  if (!target) throw new Error("XLSX workbook relationship is missing the worksheet target.");
  return normalizeZipPath("xl/workbook.xml", target);
}

function normalizeZipPath(basePath, target) {
  if (target.startsWith("/")) return target.replace(/^\/+/, "");
  const baseParts = basePath.split("/");
  baseParts.pop();
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return baseParts.join("/");
}

function parseSharedStrings(doc) {
  return getXmlElements(doc, "si").map((item) => collectXmlText(item));
}

function parseSheetRows(doc, sharedStrings) {
  return getXmlElements(doc, "row").map((rowElement) => {
    const cells = [];
    let nextColumn = 0;
    for (const cellElement of getXmlElements(rowElement, "c")) {
      const reference = cellElement.getAttribute("r") || "";
      const columnIndex = reference ? columnIndexFromCellReference(reference) : nextColumn;
      cells[columnIndex] = readXlsxCell(cellElement, sharedStrings);
      nextColumn = columnIndex + 1;
    }
    return cells.map((cell) => cell ?? "");
  });
}

function readXlsxCell(cellElement, sharedStrings) {
  const type = cellElement.getAttribute("t") || "";
  if (type === "inlineStr") return collectXmlText(getXmlElements(cellElement, "is")[0] || cellElement);
  const value = getXmlElements(cellElement, "v")[0]?.textContent || "";
  if (type === "s") return sharedStrings[Number.parseInt(value, 10)] || "";
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  return value;
}

function columnIndexFromCellReference(reference) {
  const letters = String(reference || "").match(/^[A-Z]+/i)?.[0] || "A";
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return Math.max(0, index - 1);
}

function getXmlElements(root, localName) {
  return Array.from(root.getElementsByTagNameNS("*", localName));
}

function collectXmlText(element) {
  if (!element) return "";
  return getXmlElements(element, "t")
    .map((node) => node.textContent || "")
    .join("");
}

async function unzipFiles(buffer) {
  const view = new DataView(buffer);
  const eocdOffset = findEndOfCentralDirectory(view);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const decoder = new TextDecoder();
  const files = new Map();
  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;

  while (offset < end) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Invalid XLSX zip central directory.");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameBytes = new Uint8Array(buffer, offset + 46, fileNameLength);
    const name = decoder.decode(nameBytes);

    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = new Uint8Array(buffer, dataOffset, compressedSize);
    if (!name.endsWith("/")) {
      files.set(name, await unzipEntryData(compressed, method));
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return files;
}

function findEndOfCentralDirectory(view) {
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("Invalid XLSX zip file.");
}

async function unzipEntryData(data, method) {
  if (method === 0) return data.slice();
  if (method !== 8) throw new Error(`Unsupported XLSX compression method: ${method}`);
  if (typeof DecompressionStream === "undefined") {
    throw new Error("XLSX decompression is not available in this Chrome version.");
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function createZipBlob(files) {
  const encoder = new TextEncoder();
  const dateParts = getDosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const pathBytes = encoder.encode(file.path);
    const data = await toUint8Array(file.data);
    const crc = crc32(data);
    const localHeader = new Uint8Array(30 + pathBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, ZIP_UTF8_FLAG, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dateParts.time, true);
    localView.setUint16(12, dateParts.date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, pathBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(pathBytes, 30);

    const centralHeader = new Uint8Array(46 + pathBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, ZIP_UTF8_FLAG, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dateParts.time, true);
    centralView.setUint16(14, dateParts.date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, pathBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(pathBytes, 46);

    localParts.push(localHeader, data);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce((total, part) => total + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralDirectorySize, true);
  eocdView.setUint32(16, centralDirectoryOffset, true);

  return new Blob([...localParts, ...centralParts, eocd], { type: "application/zip" });
}

async function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new TextEncoder().encode(String(value ?? ""));
}

function getDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

let crcTable = null;

function crc32(data) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_value, index) => {
      let crc = index;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
      return crc >>> 0;
    });
  }

  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function delayFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function getErrorMessage(error) {
  if (!error) return "Unknown error.";
  if (typeof error === "string") return error;
  return error.message || String(error);
}

function explainRecordingError(error) {
  const message = getErrorMessage(error);
  if (/not been invoked|activeTab/i.test(message)) {
    return [
      "Chrome has not granted recording permission for the current tab.",
      "Open the target page, click the extension icon on that page, then start the run.",
      "The manual picker fallback can also record if you select the test tab."
    ].join(" ");
  }
  if (/Chrome pages cannot be captured|cannot be captured/i.test(message)) {
    return "Chrome internal pages such as chrome:// URLs cannot be captured with tabCapture.";
  }
  return message;
}


async function exportRunArtifactArchive({ result, recording, screenshots, checkpoints, finalSnapshot, filename }) {
  const runArtifact = buildRunArtifactFromResult(result, {
    recording,
    screenshots,
    checkpoints,
    finalSnapshot,
    runId: result.transcript?.id || result.run_id || "run-artifact",
    taskId: result.transcript?.id || result.run_id || "run-artifact",
    taskGoal: result.transcript?.goal || result.summary || "Imported evaluation run"
  });
  const assetFiles = await buildRunArtifactAssetFiles(runArtifact, { recording });
  const exportArtifact = stripInlineArtifactData(runArtifact);
  const files = [
    {
      path: "run-artifact.v1.json",
      data: JSON.stringify(exportArtifact, null, 2)
    },
    {
      path: "result.json",
      data: JSON.stringify(result, null, 2)
    },
    {
      path: "log.txt",
      data: logsToText(currentRunLogEntries || [])
    },
    ...assetFiles
  ];

  const zipBlob = await createZipBlob(files);
  downloadBlob(
    zipBlob,
    filename || `${sanitizeFileName(result.transcript?.id || result.run_id || "run-artifact", "run-artifact")}.artifact.zip`
  );
}

async function buildRunArtifactAssetFiles(runArtifact, options = {}) {
  const prefix = options.prefix ? `${options.prefix}/` : "";
  const recording = options.recording || null;
  const files = [];
  const screenshotArtifacts = (runArtifact.artifacts || []).filter((artifact) => artifact.type === "screenshot");
  const textArtifacts = (runArtifact.artifacts || []).filter((artifact) => artifact.attrs?.data_text != null);
  const jsonArtifacts = (runArtifact.artifacts || []).filter((artifact) => artifact.attrs?.data_json != null);
  const resourceArtifacts = (runArtifact.artifacts || []).filter((artifact) => artifact.attrs?.evidence_role === "snapshot_resource");
  const videoArtifact = (runArtifact.artifacts || []).find((artifact) => artifact.type === "video");

  for (const artifact of screenshotArtifacts) {
    const dataUrl = artifact.attrs?.data_url;
    if (!dataUrl) continue;
    files.push({
      path: `${prefix}${artifact.uri || `artifacts/screenshots/${artifact.artifact_id}.png`}`,
      data: await dataUrlToBlob(dataUrl)
    });
  }

  for (const artifact of textArtifacts) {
    files.push({
      path: `${prefix}${artifact.uri || `artifacts/${artifact.artifact_id}.html`}`,
      data: String(artifact.attrs?.data_text || "")
    });
  }

  for (const artifact of jsonArtifacts) {
    const data = artifact.attrs?.data_json;
    if (!data) continue;
    files.push({
      path: `${prefix}${artifact.uri || `artifacts/${artifact.artifact_id}.json`}`,
      data: JSON.stringify(data, null, 2)
    });
  }

  for (const artifact of resourceArtifacts) {
    const fetched = await fetchSnapshotResource(artifact.attrs?.original_url);
    if (!fetched.ok) {
      artifact.attrs = {
        ...(artifact.attrs || {}),
        downloaded: false,
        fetch_error: fetched.error || "fetch failed"
      };
      continue;
    }
    artifact.mime_type = artifact.mime_type || fetched.mimeType || "application/octet-stream";
    artifact.attrs = {
      ...(artifact.attrs || {}),
      downloaded: true,
      byte_length: fetched.blob.size
    };
    files.push({
      path: `${prefix}${artifact.uri}`,
      data: fetched.blob
    });
  }

  if (videoArtifact) {
    if (recording?.blob?.size > 0) {
      files.push({
        path: `${prefix}${videoArtifact.uri || "artifacts/video.webm"}`,
        data: recording.blob
      });
    } else {
      files.push({
        path: `${prefix}artifacts/video-unavailable.txt`,
        data: "Recording was unavailable or no video data was captured for this run.\n"
      });
    }
  }

  return files;
}

function buildRunArtifactFromResult(result, options = {}) {
  const transcript = result.transcript || {};
  const steps = Array.isArray(transcript.steps) ? transcript.steps : [];
  const screenshots = Array.isArray(options.screenshots) ? options.screenshots : [];
  const checkpointRecords = Array.isArray(options.checkpoints) ? options.checkpoints : [];
  const finalSnapshot = options.finalSnapshot || null;
  const screenshotsByStep = new Map(screenshots.map((item) => [Number(item.step), item]));
  const recording = options.recording || null;
  const startedAt = parseDate(transcript.startedAt) || parseDate(recording?.startedAt) || new Date();
  const runId = options.runId || transcript.id || result.run_id || `run_${Date.now()}`;
  const taskId = options.taskId || transcript.id || result.run_id || runId;
  const taskGoal = options.taskGoal || transcript.goal || result.summary || "";
  const checkpoints = [];
  const testerEvents = [];
  const artifacts = [];
  const checkpointIdByStep = new Map();
  let screenshotCounter = 0;

  if (checkpointRecords.length) {
    for (let index = 0; index < checkpointRecords.length; index += 1) {
      const record = checkpointRecords[index] || {};
      const stepNumber = Number.isFinite(Number(record.step)) ? Number(record.step) : index + 1;
      const step = steps.find((item) => Number(item.step) === stepNumber) || steps[index] || {};
      const checkpointId = `cp_${String(index + 1).padStart(3, "0")}`;
      const eventId = `te_${String(index + 1).padStart(3, "0")}`;
      const page = record.page || step.toolResults?.[0]?.result?.page || step.page || {};
      const createdAt = record.createdAt || record.screenshot?.capturedAt || step.endedAt || step.startedAt || "";
      const elapsed = diffMs(startedAt, parseDate(createdAt) || parseDate(step.endedAt) || parseDate(step.startedAt) || startedAt);
      const screenshotRecord = record.screenshot || screenshotsByStep.get(stepNumber);
      let screenshotArtifactId = "";

      if (screenshotRecord?.dataUrl) {
        screenshotCounter += 1;
        screenshotArtifactId = `shot_${String(screenshotCounter).padStart(3, "0")}`;
        artifacts.push({
          artifact_id: screenshotArtifactId,
          type: "screenshot",
          uri: `artifacts/screenshots/${screenshotArtifactId}.png`,
          mime_type: screenshotRecord.mimeType || "image/png",
          checkpoint_id: checkpointId,
          video_ts_ms: Math.max(0, elapsed),
          attrs: {
            data_url: screenshotRecord.dataUrl,
            width: screenshotRecord.width || 0,
            height: screenshotRecord.height || 0,
            captured_at: screenshotRecord.capturedAt || createdAt || ""
          }
        });
      }

      checkpointIdByStep.set(stepNumber, checkpointId);
      checkpoints.push(buildCheckpointFromCapturedRecord({
        checkpointId,
        index,
        eventId,
        record,
        step,
        page,
        screenshotArtifactId,
        transcript,
        result,
        startedAt,
        elapsed,
        createdAt
      }));
    }
  } else {
    for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] || {};
    const stepNumber = Number.isFinite(Number(step.step)) ? Number(step.step) : index + 1;
    const checkpointId = `cp_${String(index + 1).padStart(3, "0")}`;
    const eventId = `te_${String(index + 1).padStart(3, "0")}`;
    const page = step.toolResults?.[0]?.result?.page || step.page || {};
    const elapsed = diffMs(startedAt, parseDate(step.endedAt) || parseDate(step.startedAt) || startedAt);
    const screenshotRecord = screenshotsByStep.get(stepNumber);
    let screenshotArtifactId = "";

    if (screenshotRecord?.dataUrl) {
      screenshotCounter += 1;
      screenshotArtifactId = `shot_${String(screenshotCounter).padStart(3, "0")}`;
      artifacts.push({
        artifact_id: screenshotArtifactId,
        type: "screenshot",
        uri: `artifacts/screenshots/${screenshotArtifactId}.png`,
        mime_type: screenshotRecord.mimeType || "image/png",
        checkpoint_id: checkpointId,
        video_ts_ms: Math.max(0, elapsed),
        attrs: {
          data_url: screenshotRecord.dataUrl,
          width: screenshotRecord.width || 0,
          height: screenshotRecord.height || 0,
          captured_at: screenshotRecord.capturedAt || ""
        }
      });
    }

    checkpoints.push(buildCheckpointFromStep({
      checkpointId,
      index,
      eventId,
      step,
      page,
      screenshotArtifactId,
      transcript,
      result,
      startedAt,
      elapsed
    }));
    checkpointIdByStep.set(stepNumber, checkpointId);
    }
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] || {};
    const stepNumber = Number.isFinite(Number(step.step)) ? Number(step.step) : index + 1;
    const checkpointId = checkpointIdByStep.get(stepNumber) || `cp_${String(Math.min(index + 1, Math.max(1, checkpoints.length))).padStart(3, "0")}`;
    const eventId = `te_${String(index + 1).padStart(3, "0")}`;
    testerEvents.push(buildTesterEventFromStep(step, eventId, checkpointId, index));
  }

  if (recording?.blob?.size > 0) {
    artifacts.unshift({
      artifact_id: "video_001",
      type: "video",
      uri: "artifacts/video.webm",
      mime_type: recording.mimeType || "video/webm"
    });
  } else {
    artifacts.unshift({
      artifact_id: "video_001",
      type: "video",
      mime_type: recording?.mimeType || "video/webm",
      attrs: {
        unavailable: true
      }
    });
  }

  attachEvidenceBundle({
    checkpoints,
    artifacts,
    checkpointRecords,
    finalSnapshot,
    steps,
    transcript,
    result
  });

  return {
    schema_version: "1.0",
    run_id: runId,
    task: {
      task_id: taskId,
      goal: taskGoal,
      domain: options.domain || "unknown",
      source: {
        type: options.sourceType || "browser-run",
        name: options.sourceName || transcript.tab?.title || "auto-agent-tester"
      },
      reference_answer: options.referenceAnswer || "",
      expected_outcome: options.expectedOutcome || "",
      rubric: Array.isArray(options.rubric) ? options.rubric : [],
      attrs: {
        migrated_from: "auto-agent-tester",
        ...(options.taskAttrs || {})
      }
    },
    run: {
      status: result.status || transcript.final?.status || "partial",
      started_at: transcript.startedAt || startedAt.toISOString(),
      ended_at: transcript.endedAt || new Date().toISOString(),
      entry_url: transcript.tab?.url || "",
      browser: {
        name: "Chrome",
        version: "unknown"
      },
      extension: {
        name: "auto-agent-tester",
        version: chrome.runtime.getManifest().version
      },
      attrs: {
        allowed_hosts: transcript.allowedHosts || "",
        source_format: "auto-agent-tester-run-artifact-v1"
      }
    },
    checkpoints,
    tester_events: testerEvents,
    annotations: Array.isArray(result.annotations) ? result.annotations : [],
    artifacts,
    evidence: buildEvidenceManifest({ checkpoints, artifacts }),
    attrs: {
      source_format: "auto-agent-tester-run-artifact-v1",
      has_screenshots: screenshots.length > 0,
      has_final_snapshot: Boolean(checkpoints[checkpoints.length - 1]?.snapshot_ref),
      ...(options.runAttrs || {})
    }
  };
}

function attachEvidenceBundle({ checkpoints, artifacts, checkpointRecords, finalSnapshot, steps, transcript, result }) {
  const finalCheckpoint = checkpoints[checkpoints.length - 1] || null;
  if (!finalCheckpoint) return;

  const finalSnapshotSource = finalSnapshot || getFinalSnapshotSource({ checkpointRecords, steps });
  if (!finalSnapshotSource) return;

  const snapshotHtmlArtifactId = "final_snapshot_html_001";
  const snapshotManifestArtifactId = "final_snapshot_manifest_001";
  const snapshotResourceArtifacts = buildSnapshotResourceArtifacts(finalSnapshotSource);

  finalCheckpoint.snapshot_ref = snapshotHtmlArtifactId;
  finalCheckpoint.attrs = {
    ...(finalCheckpoint.attrs || {}),
    evidence_role: "final_checkpoint",
    final_snapshot_artifact_id: snapshotHtmlArtifactId,
    final_snapshot_manifest_artifact_id: snapshotManifestArtifactId
  };

  if (!artifacts.some((artifact) => artifact.artifact_id === snapshotHtmlArtifactId)) {
    artifacts.push({
      artifact_id: snapshotHtmlArtifactId,
      type: "html",
      uri: "artifacts/final_snapshot/index.html",
      mime_type: "text/html",
      checkpoint_id: finalCheckpoint.checkpoint_id,
      video_ts_ms: finalCheckpoint.video_ts_ms || 0,
      attrs: {
        evidence_role: "final_snapshot",
        captured_at: finalSnapshotSource.captured_at || finalCheckpoint.created_at || "",
        original_url: finalSnapshotSource.url || finalCheckpoint.page?.url || "",
        title: finalSnapshotSource.title || finalCheckpoint.page?.title || "",
        resource_count: Array.isArray(finalSnapshotSource.resources) ? finalSnapshotSource.resources.length : 0,
        data_text: finalSnapshotSource.html || ""
      }
    });
  }

  if (!artifacts.some((artifact) => artifact.artifact_id === snapshotManifestArtifactId)) {
    artifacts.push({
      artifact_id: snapshotManifestArtifactId,
      type: "json",
      uri: "artifacts/final_snapshot/snapshot.json",
      mime_type: "application/json",
      checkpoint_id: finalCheckpoint.checkpoint_id,
      video_ts_ms: finalCheckpoint.video_ts_ms || 0,
      attrs: {
        evidence_role: "final_snapshot_manifest",
        data_json: {
          schema_version: "final-page-snapshot.v1",
          checkpoint_id: finalCheckpoint.checkpoint_id,
          created_at: finalCheckpoint.created_at,
          run_id: transcript.id || "",
          task_goal: transcript.goal || result.summary || "",
          page: summarizePageArchiveSnapshot(finalSnapshotSource),
          resources: Array.isArray(finalSnapshotSource.resources) ? finalSnapshotSource.resources : [],
          html_artifact_id: snapshotHtmlArtifactId,
          resource_artifact_ids: snapshotResourceArtifacts.map((artifact) => artifact.artifact_id),
          blocks: finalCheckpoint.blocks || [],
          summary: finalCheckpoint.summary || "",
          change_summary: finalCheckpoint.change_summary || "",
          screenshot_ref: finalCheckpoint.screenshot_ref || "",
          video_ts_ms: finalCheckpoint.video_ts_ms || 0
        }
      }
    });
  }

  for (const artifact of snapshotResourceArtifacts) {
    if (!artifacts.some((item) => item.artifact_id === artifact.artifact_id)) {
      artifacts.push(artifact);
    }
  }
}

function getFinalSnapshotSource({ checkpointRecords, steps }) {
  const finalRecord = Array.isArray(checkpointRecords) && checkpointRecords.length
    ? checkpointRecords[checkpointRecords.length - 1]
    : null;
  if (finalRecord?.page) return finalRecord.page;

  const finalStep = Array.isArray(steps) && steps.length ? steps[steps.length - 1] : null;
  return finalStep?.toolResults?.[0]?.result?.page || finalStep?.page || null;
}

function summarizePageArchiveSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    schema_version: snapshot.schema_version || "page-snapshot.v1",
    capture_type: snapshot.capture_type || "final_page_snapshot",
    captured_at: snapshot.captured_at || "",
    url: snapshot.url || "",
    title: snapshot.title || "",
    base_uri: snapshot.base_uri || "",
    text: truncate(snapshot.text || "", 8000),
    viewport: snapshot.viewport || {},
    scroll: snapshot.scroll || {},
    document: snapshot.document || {},
    resource_count: Array.isArray(snapshot.resources) ? snapshot.resources.length : 0,
    error: snapshot.error || ""
  };
}

function buildSnapshotResourceArtifacts(snapshot) {
  const resources = Array.isArray(snapshot?.resources) ? snapshot.resources : [];
  const artifacts = [];
  const seen = new Set();

  for (const resource of resources) {
    const url = String(resource.url || "");
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const index = artifacts.length + 1;
    const artifactId = `snapshot_res_${String(index).padStart(4, "0")}`;
    artifacts.push({
      artifact_id: artifactId,
      type: "other",
      uri: `artifacts/final_snapshot/resources/${String(index).padStart(4, "0")}-${resourceFileName(url, resource.type)}`,
      mime_type: "",
      attrs: {
        evidence_role: "snapshot_resource",
        original_url: url,
        resource_id: resource.id || "",
        resource_type: resource.type || "",
        tag: resource.tag || "",
        attr: resource.attr || "",
        rel: resource.rel || "",
        media: resource.media || "",
        as: resource.as || ""
      }
    });
  }

  return artifacts;
}

function resourceFileName(url, type) {
  let name = "";
  try {
    const parsed = new URL(url);
    name = parsed.pathname.split("/").filter(Boolean).pop() || "";
  } catch (_error) {
    name = "";
  }
  const fallback = `resource${extensionForResourceType(type)}`;
  return sanitizeFileName(name || fallback, fallback);
}

function extensionForResourceType(type) {
  switch (String(type || "").toLowerCase()) {
    case "stylesheet":
      return ".css";
    case "script":
      return ".js";
    case "image":
    case "icon":
      return ".img";
    case "font":
      return ".font";
    case "video":
      return ".video";
    case "audio":
      return ".audio";
    case "manifest":
      return ".json";
    default:
      return ".bin";
  }
}

async function fetchSnapshotResource(url) {
  if (!url || !/^https?:\/\//i.test(String(url))) {
    return { ok: false, error: "not an HTTP(S) resource" };
  }
  try {
    const response = await fetch(url, {
      credentials: "include",
      cache: "force-cache",
      redirect: "follow"
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const blob = await response.blob();
    return {
      ok: true,
      blob,
      mimeType: response.headers.get("content-type") || blob.type || "application/octet-stream"
    };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

function stripInlineArtifactData(runArtifact) {
  const copy = JSON.parse(JSON.stringify(runArtifact));
  for (const artifact of copy.artifacts || []) {
    if (!artifact.attrs) continue;
    delete artifact.attrs.data_url;
    delete artifact.attrs.data_json;
    delete artifact.attrs.data_text;
  }
  return copy;
}

function buildEvidenceManifest({ checkpoints, artifacts }) {
  const finalCheckpoint = checkpoints[checkpoints.length - 1] || null;
  const video = artifacts.find((artifact) => artifact.type === "video") || null;
  const finalSnapshot = artifacts.find((artifact) => artifact.attrs?.evidence_role === "final_snapshot") || null;
  const finalSnapshotManifest = artifacts.find((artifact) => artifact.attrs?.evidence_role === "final_snapshot_manifest") || null;
  const snapshotResources = artifacts.filter((artifact) => artifact.attrs?.evidence_role === "snapshot_resource");
  const screenshots = artifacts.filter((artifact) => artifact.type === "screenshot");
  const finalScreenshot = finalCheckpoint?.screenshot_ref
    ? artifacts.find((artifact) => artifact.artifact_id === finalCheckpoint.screenshot_ref)
    : null;

  return {
    video_ref: video?.artifact_id || "",
    final_checkpoint_id: finalCheckpoint?.checkpoint_id || "",
    final_snapshot_ref: finalSnapshot?.artifact_id || "",
    final_snapshot_manifest_ref: finalSnapshotManifest?.artifact_id || "",
    snapshot_resource_refs: snapshotResources.map((artifact) => artifact.artifact_id),
    final_screenshot_ref: finalScreenshot?.artifact_id || "",
    intermediate_screenshot_refs: screenshots
      .filter((artifact) => !finalCheckpoint || artifact.checkpoint_id !== finalCheckpoint.checkpoint_id)
      .map((artifact) => artifact.artifact_id),
    checkpoint_count: checkpoints.length
  };
}

function buildCheckpointFromStep({
  checkpointId,
  index,
  eventId,
  step,
  page,
  screenshotArtifactId,
  transcript,
  result,
  startedAt,
  elapsed
}) {
  return {
    checkpoint_id: checkpointId,
    index,
    created_at: step.endedAt || step.startedAt || isoNow(startedAt, elapsed),
    actor: "website_agent",
    event_type: step.parsed?.final ? "final_result_stable" : "assistant_output_stable",
    stability: "stable",
    trigger_event_id: eventId,
    page: buildCheckpointPage(page, transcript),
    blocks: buildCheckpointBlocks(step, page, screenshotArtifactId, index + 1, result),
    summary: buildCheckpointSummary(step, page, result, transcript),
    change_summary: buildCheckpointChangeSummary(step, page, result, transcript),
    screenshot_ref: screenshotArtifactId || undefined,
    video_ts_ms: Math.max(0, elapsed)
  };
}

function buildCheckpointFromCapturedRecord({
  checkpointId,
  index,
  eventId,
  record,
  step,
  page,
  screenshotArtifactId,
  transcript,
  result,
  startedAt,
  elapsed,
  createdAt
}) {
  return {
    checkpoint_id: checkpointId,
    index,
    created_at: createdAt || step.endedAt || step.startedAt || isoNow(startedAt, elapsed),
    actor: "website_agent",
    event_type: record.eventType || (step.parsed?.final ? "final_result_stable" : "website_state_stable"),
    stability: record.stability || "stable",
    trigger_event_id: eventId,
    page: buildCheckpointPage(page, transcript),
    blocks: buildCheckpointBlocks(step, page, screenshotArtifactId, index + 1, result),
    summary: buildCheckpointSummary(step, page, result, transcript),
    change_summary: buildCheckpointChangeSummary(step, page, result, transcript),
    screenshot_ref: screenshotArtifactId || undefined,
    video_ts_ms: Math.max(0, elapsed),
    attrs: {
      source: "checkpoint_message",
      step: Number(record.step) || index + 1,
      trigger: record.trigger || {}
    }
  };
}

function buildCheckpointPage(page, transcript) {
  const actionTargets = Array.isArray(page.actionTargets) ? page.actionTargets : [];
  return {
    url: page.url || transcript.tab?.url || "",
    title: page.title || transcript.tab?.title || "",
    viewport: page.viewport || {},
    scroll: normalizeCheckpointScroll(page.scroll || {}),
    active_tab: transcript.tab?.title || "",
    section: page.section || "main_thread",
    breadcrumb: transcript.tab?.title ? [transcript.tab.title] : [],
    summary: page.observationText ? truncate(page.observationText, 220) : "",
    observation_text: page.observationText ? truncate(page.observationText, 12000) : "",
    observation_scope: page.observationScope || {},
    action_targets: actionTargets.slice(0, 80),
    attrs: {
      step_summary: page.observationText ? truncate(page.observationText, 220) : "",
      action_target_count: actionTargets.length
    }
  };
}

function normalizeCheckpointScroll(scroll) {
  return {
    ...scroll,
    max_y: scroll.max_y ?? scroll.maxY ?? 0
  };
}

function buildCheckpointBlocks(step, page, screenshotArtifactId, checkpointIndex, result) {
  const blocks = [];
  const observationText = String(page.observationText || "").trim();
  if (observationText) {
    blocks.push({
      block_id: `b_${String(checkpointIndex).padStart(3, "0")}_001`,
      type: "observation_text",
      text: truncate(observationText, 2000),
      order: 1,
      source: screenshotArtifactId ? { artifact_id: screenshotArtifactId } : {},
      attrs: {
        source: "accessibility_tree"
      }
    });
  }

  const actionTargets = Array.isArray(page.actionTargets)
    ? page.actionTargets
    : Array.isArray(step.page?.actionTargets)
      ? step.page.actionTargets
      : [];
  const targetLines = actionTargets
    .slice(0, 6)
    .map((target) => [target.id, target.role, target.label || target.value || target.placeholder].filter(Boolean).join(" · "))
    .filter(Boolean);
  if (targetLines.length) {
    blocks.push({
      block_id: `b_${String(checkpointIndex).padStart(3, "0")}_002`,
      type: "action_targets",
      text: targetLines.join("\n"),
      order: blocks.length + 1,
      source: screenshotArtifactId ? { artifact_id: screenshotArtifactId } : {},
      attrs: {
        source: "visible_targets"
      }
    });
  }

  const finalSummary = step.parsed?.final?.summary || result.summary || "";
  if (step.parsed?.final?.summary || finalSummary) {
    blocks.push({
      block_id: `b_${String(checkpointIndex).padStart(3, "0")}_003`,
      type: step.parsed?.final ? "final_summary" : "summary_note",
      text: truncate(finalSummary, 1200),
      order: blocks.length + 1,
      source: screenshotArtifactId ? { artifact_id: screenshotArtifactId } : {}
    });
  }

  return blocks;
}

function buildCheckpointSummary(step, page, result, transcript) {
  return truncate(
    page.observationText || step.actionResult?.message || step.parsed?.final?.summary || result.summary || transcript.final?.summary || "",
    240
  );
}

function buildCheckpointChangeSummary(step, page, result, transcript) {
  return truncate(
    step.actionResult?.message || step.parsed?.thought || transcript.final?.summary || result.summary || page.observationText || "",
    320
  );
}

function buildTesterEventFromStep(step, eventId, checkpointId, index) {
  const action = step.parsed?.final
    ? buildLegacyAction(step, step.parsed?.final, "finish", null)
    : buildLegacyAction(
        step,
        step.parsed?.action || step.actionResult?.action || null,
        normalizeActionType(step.parsed?.action?.type || step.actionResult?.action?.type),
        step.actionResult || step.toolResults?.[0]?.result || null
      );

  return {
    event_id: eventId,
    index,
    created_at: step.startedAt || step.endedAt || new Date().toISOString(),
    actor: "tester",
    action,
    before_checkpoint_id: index > 0 ? `cp_${String(index).padStart(3, "0")}` : undefined,
    after_checkpoint_id: checkpointId
  };
}

function buildLegacyAction(step, action, actionType, actionResult) {
  const nextAction = {
    type: actionType || "unknown"
  };

  if (action?.elementId || step.parsed?.action?.elementId) {
    nextAction.target = {
      element_id: action?.elementId || step.parsed?.action?.elementId
    };
  }

  if (action?.selector || step.parsed?.action?.selector) {
    nextAction.target = {
      ...(nextAction.target || {}),
      selector: action?.selector || step.parsed?.action?.selector
    };
  }

  if (action?.text != null) {
    nextAction.input = { ...(nextAction.input || {}), text: action.text };
  }
  if (action?.value != null) {
    nextAction.input = { ...(nextAction.input || {}), value: action.value };
  }
  if (action?.key != null) {
    nextAction.input = { ...(nextAction.input || {}), key: action.key };
  }
  if (action?.direction != null) {
    nextAction.input = { ...(nextAction.input || {}), direction: action.direction };
  }
  if (action?.amount != null) {
    nextAction.input = { ...(nextAction.input || {}), amount: action.amount };
  }
  if (action?.ms != null) {
    nextAction.input = { ...(nextAction.input || {}), ms: action.ms };
  }
  if (action?.checked != null) {
    nextAction.input = { ...(nextAction.input || {}), checked: action.checked };
  }
  for (const modifier of ["shift", "ctrl", "alt", "meta"]) {
    if (action?.[modifier] != null) {
      nextAction.input = { ...(nextAction.input || {}), [modifier]: action[modifier] };
    }
  }
  if (action?.deltaX != null) {
    nextAction.input = { ...(nextAction.input || {}), deltaX: action.deltaX };
  }
  if (action?.deltaY != null) {
    nextAction.input = { ...(nextAction.input || {}), deltaY: action.deltaY };
  }
  if (action?.steps != null) {
    nextAction.input = { ...(nextAction.input || {}), steps: action.steps };
  }
  if (step.parsed?.final) {
    nextAction.input = {
      ...(nextAction.input || {}),
      status: step.parsed.final.status,
      summary: step.parsed.final.summary,
      data: step.parsed.final.data
    };
    nextAction.result = {
      ok: true,
      status: step.parsed.final.status,
      message: step.parsed.final.summary || step.parsed.final.status,
      data: step.parsed.final.data ?? null
    };
    return nextAction;
  }

  nextAction.result = {
    ok: Boolean(actionResult?.ok),
    message: actionResult?.message || actionResult?.error || "",
    error: actionResult?.error || ""
  };

  return nextAction;
}

function normalizeActionType(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "unknown";
  if (text === "type_text") return "type_text";
  if (text === "select_option") return "select_option";
  if (text === "press_key") return "press_key";
  if (text === "scroll") return "scroll";
  if (text === "wait") return "wait";
  if (text === "click") return "click";
  if (text === "finish") return "finish";
  return text;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function diffMs(start, end) {
  return Math.max(0, Math.round(end.getTime() - start.getTime()));
}

function isoNow(start, offsetMs) {
  return new Date(start.getTime() + Math.max(0, offsetMs)).toISOString();
}

function truncate(text, maxLength) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}



elements.downloadArtifact.addEventListener("click", async () => {
  if (!latestResult) return;
  elements.downloadArtifact.disabled = true;
  addLog("info", "Preparing artifact archive download.");
  await delayFrame();
  try {
    await exportRunArtifactArchive({
      result: latestResult,
      recording: getRecordingArtifact(),
      screenshots: latestRunScreenshots.slice(),
      checkpoints: latestRunCheckpoints.slice(),
      finalSnapshot: latestRunFinalSnapshot,
      filename: sanitizeFileName(latestResult.transcript?.id || latestResult.summary || "run-artifact", "run-artifact") + ".artifact.zip"
    });
    addLog("ok", "Artifact archive download started.");
  } catch (error) {
    addLog("error", "Could not export artifact archive: " + getErrorMessage(error));
  } finally {
    elements.downloadArtifact.disabled = false;
  }
});
