const elements = {
  goal: document.getElementById("goal"),
  maxStep: document.getElementById("maxStep"),
  startRun: document.getElementById("startRun"),
  stopRun: document.getElementById("stopRun"),
  clearLog: document.getElementById("clearLog"),
  copyResult: document.getElementById("copyResult"),
  exportResult: document.getElementById("exportResult"),
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

let port = null;
let latestResult = null;
let latestSummary = null;
let runActive = false;
let activeRunTabId = null;
let mediaRecorder = null;
let recordingStream = null;
let recordedChunks = [];
let recordingBlob = null;
let recordingUrl = "";
let recordingMimeType = "video/webm";
let recordingStartedAt = "";
let recordingEndedAt = "";
let recordingStopPromise = null;

connectPort();
restoreDraft();

elements.startRun.addEventListener("click", async () => {
  const goal = elements.goal.value.trim();
  const maxStep = Number.parseInt(elements.maxStep.value, 10) || 8;
  if (!goal) {
    addLog("error", "Goal is required.");
    return;
  }

  chrome.storage.local.set({ lastGoal: goal, lastMaxStep: maxStep });
  setRunning(true);
  setStatus("running", "Running");
  latestResult = null;
  latestSummary = null;
  activeRunTabId = null;
  elements.result.textContent = "";
  elements.copyResult.disabled = true;
  elements.exportResult.disabled = true;
  resetRecordingState();
  const recordingReady = await startRecording();

  if (postToAgent({ type: "RUN_AGENT", payload: { goal, max_step: maxStep } })) {
    addLog("info", "Run started.");
    if (!recordingReady) {
      addLog("warn", "Agent is running without recording.");
    }
  } else {
    await stopRecording("agent start failed");
  }
});

elements.stopRun.addEventListener("click", () => {
  requestStop();
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
  }
});

elements.downloadRecording.addEventListener("click", () => {
  if (!recordingBlob) return;
  exportRecording();
});

elements.openOptions.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

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
      stopRecording("background connection lost");
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

  if (message.type === "final") {
    latestResult = {
      status: message.status,
      summary: message.summary,
      data: message.data,
      observations: message.observations || [],
      transcript: message.transcript || null
    };
    latestSummary = createResultSummary(latestResult);
    elements.result.textContent = JSON.stringify(latestSummary, null, 2);
    elements.copyResult.disabled = false;
    elements.exportResult.disabled = false;
    setRunning(false);
    setStatus(["fail", "error"].includes(message.status) ? "error" : "done", message.summary || message.status || "Done");
    addLog(["fail", "error"].includes(message.status) ? "error" : "ok", message.summary || "Run finished.");
    cleanupActivePageFromPanel(message.transcript?.tab?.id);
    stopRecording("run finished");
    activeRunTabId = null;
    return;
  }

  if (message.type === "error") {
    setRunning(false);
    stopRecording("run error");
    cleanupActivePageFromPanel(message.transcript?.tab?.id);
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
      elements.result.textContent = JSON.stringify(latestSummary, null, 2);
      elements.copyResult.disabled = false;
      elements.exportResult.disabled = false;
    }
    setStatus("error", message.message || "Error");
    addLog("error", message.message || "Unknown error.");
  }
}

async function restoreDraft() {
  const data = await chrome.storage.local.get({ lastGoal: "", lastMaxStep: 0, lastMaxSteps: 8 });
  elements.goal.value = data.lastGoal || "";
  elements.maxStep.value = data.lastMaxStep || data.lastMaxSteps || 8;
}

function setRunning(isRunning) {
  runActive = isRunning;
  elements.startRun.disabled = isRunning;
  elements.stopRun.disabled = !isRunning;
}

function setStatus(kind, text) {
  elements.statusDot.className = `dot ${kind}`;
  elements.statusText.textContent = text;
}

function addLog(level, message) {
  const item = document.createElement("li");
  const meta = document.createElement("span");
  const body = document.createElement("span");

  meta.className = `meta ${level}`;
  meta.textContent = `${new Date().toLocaleTimeString()} - ${level.toUpperCase()}`;
  body.textContent = message;

  item.append(meta, body);
  elements.log.appendChild(item);
  elements.log.scrollTop = elements.log.scrollHeight;
}

function requestStop(source = "Stop button") {
  if (!runActive) return;
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
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  anchor.href = url;
  anchor.download = `auto-agent-tester-${timestamp}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function startRecording() {
  if (typeof MediaRecorder === "undefined") {
    addLog("warn", "Recording unavailable: MediaRecorder is not available in this browser.");
    return false;
  }

  try {
    const activeTab = await getActiveTabForRecording();
    if (activeTab?.url && !/^https?:\/\//i.test(activeTab.url)) {
      addLog("warn", `Recording skipped: Chrome cannot capture this page type (${activeTab.url}).`);
      return false;
    }

    recordingStream = await captureRecordingStream();
    if (!recordingStream) {
      return false;
    }

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
    stopRecordingStream();
    return Promise.resolve(false);
  }

  if (recordingStopPromise) {
    return recordingStopPromise;
  }

  if (recorder.state === "inactive") {
    stopRecordingStream();
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

  stopRecordingStream();

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

function resetRecordingState() {
  if (recordingUrl) {
    URL.revokeObjectURL(recordingUrl);
  }
  stopRecordingStream();
  mediaRecorder = null;
  recordedChunks = [];
  recordingBlob = null;
  recordingUrl = "";
  recordingMimeType = "video/webm";
  recordingStartedAt = "";
  recordingEndedAt = "";
  recordingStopPromise = null;
  elements.downloadRecording.disabled = true;
}

function exportRecording() {
  const anchor = document.createElement("a");
  const timestamp = (recordingStartedAt || new Date().toISOString()).replace(/[:.]/g, "-");
  const extension = recordingMimeType.includes("mp4") ? "mp4" : "webm";
  anchor.href = recordingUrl || URL.createObjectURL(recordingBlob);
  anchor.download = `auto-agent-tester-recording-${timestamp}.${extension}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  addLog("ok", "Recording download started.");
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
