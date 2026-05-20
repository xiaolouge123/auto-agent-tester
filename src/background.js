const DEFAULT_SETTINGS = {
  baseUrl: "https://api.openai.com/v1",
  model: "",
  temperature: 0.1,
  allowedHosts: ""
};

const MAX_STEP_LIMIT = 100;
const DEFAULT_MAX_STEP = 100;

const ACTION_TYPES = new Set([
  "click",
  "double_click",
  "hover",
  "focus",
  "type",
  "clear",
  "select",
  "set_checked",
  "drag",
  "press_key",
  "scroll",
  "wait",
  "done",
  "fail"
]);

const activeAgentTabs = new Set();
const activeAgentRuns = new Map();
let runKeepAliveCount = 0;
let runKeepAliveInterval = null;

const REFERENCE_STORAGE_KEY = "referenceExample";
const RECORDING_SUMMARY_MIN_CHARS = 200;
const RECORDING_SUMMARY_MAX_CHARS = 500;
const recordingState = {
  active: false,
  tabId: null,
  startedAt: null,
  startUrl: "",
  events: [],
  port: null
};

initializeSidePanelBehavior();

chrome.runtime.onInstalled.addListener(() => {
  initializeSidePanelBehavior();
});

chrome.action.onClicked.addListener((tab) => {
  openSidePanelFromAction(tab).catch((error) => {
    console.warn("Could not open side panel from action click", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "CONTENT_READY" && sender.tab?.id) {
    if (activeAgentTabs.has(sender.tab.id)) {
      setAgentActivity(sender.tab.id, true).catch(() => {});
    }
    if (recordingState.active && sender.tab.id === recordingState.tabId) {
      sendTabRecordingMessage(sender.tab.id, { type: "START_RECORDING" }).catch(() => {});
    }
  }

  if (message?.type === "STOP_AGENT_FROM_PAGE" && sender.tab?.id) {
    const run = activeAgentRuns.get(sender.tab.id);
    if (run) {
      requestStop(run.port, run.state, "keyboard");
    } else {
      activeAgentTabs.delete(sender.tab.id);
      setAgentActivity(sender.tab.id, false).catch(() => {});
    }
  }

  if (message?.type === "RECORDING_EVENT" && message.event) {
    if (recordingState.active && (!recordingState.tabId || sender.tab?.id === recordingState.tabId)) {
      recordingState.events.push(message.event);
      if (recordingState.port) {
        post(recordingState.port, {
          type: "RECORDING_EVENT_TICK",
          count: recordingState.events.length,
          lastEvent: { type: message.event.type, ts: message.event.ts }
        });
      }
    }
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "agent-panel") return;

  const state = createRunState();

  port.onDisconnect.addListener(() => {
    if (recordingState.active && recordingState.port === port) {
      const tabId = recordingState.tabId;
      recordingState.active = false;
      recordingState.tabId = null;
      recordingState.events = [];
      recordingState.startedAt = null;
      recordingState.startUrl = "";
      recordingState.port = null;
      stopRunKeepAlive();
      if (tabId != null) {
        sendTabRecordingMessage(tabId, { type: "STOP_RECORDING" }).catch(() => {});
      }
    }

    if (!state.running && !state.tabId) return;

    state.cancelled = true;
    addTranscriptEvent(state, { type: "panel_disconnected" });
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
    cleanupRunState(state).catch(() => {});
    state.running = false;
  });

  port.onMessage.addListener((message) => {
    if (message?.type === "RUN_AGENT" && !state.running) {
      state.cancelled = false;
      state.finalSent = false;
      state.running = true;
      startRunKeepAlive();
      runAgent(port, state, message.payload)
        .catch((error) => {
          const message = getErrorMessage(error);
          if (state.cancelled || isAbortError(error)) {
            postFinal(port, state, {
              status: "stopped",
              summary: "Stopped by user.",
              data: null,
              observations: state.observations || []
            });
            return;
          }
          if (state.currentStepRecord && !state.currentStepRecord.error) {
            state.currentStepRecord.error = message;
          }
          postFinal(port, state, {
            status: "error",
            summary: message,
            data: null,
            observations: state.observations || []
          });
        })
        .finally(() => {
          stopRunKeepAlive();
          cleanupRunState(state).catch(() => {});
          state.running = false;
          post(port, { type: "status", state: "idle" });
        });
    }

    if (message?.type === "STOP_AGENT") {
      requestStop(port, state);
    }

    if (message?.type === "START_RECORDING") {
      startRecording(port, message.payload || {}).catch((error) => {
        post(port, { type: "RECORDING_ERROR", message: getErrorMessage(error) });
      });
    }

    if (message?.type === "STOP_RECORDING") {
      stopRecording(port).catch((error) => {
        post(port, { type: "RECORDING_ERROR", message: getErrorMessage(error) });
      });
    }

    if (message?.type === "CLEAR_REFERENCE") {
      chrome.storage.local.remove(REFERENCE_STORAGE_KEY).then(() => {
        post(port, { type: "REFERENCE_CLEARED" });
      }).catch((error) => {
        post(port, { type: "RECORDING_ERROR", message: getErrorMessage(error) });
      });
    }

    if (message?.type === "GET_REFERENCE") {
      chrome.storage.local.get(REFERENCE_STORAGE_KEY).then((data) => {
        post(port, { type: "REFERENCE_STATE", reference: data?.[REFERENCE_STORAGE_KEY] || null });
      }).catch(() => {});
    }
  });
});

async function initializeSidePanelBehavior() {
  if (!chrome.sidePanel?.setPanelBehavior) return;

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn("Could not configure side panel action behavior", error);
  }
}

async function openSidePanelFromAction(tab) {
  await initializeSidePanelBehavior();
  if (!chrome.sidePanel?.open) {
    console.warn("chrome.sidePanel.open is unavailable. Use Chrome 116 or newer.");
    return;
  }

  if (tab?.windowId != null) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    return;
  }

  const currentWindow = await chrome.windows.getCurrent();
  if (currentWindow?.id != null) {
    await chrome.sidePanel.open({ windowId: currentWindow.id });
  }
}

function createRunState() {
  return {
    abortController: null,
    cancelled: false,
    currentStepRecord: null,
    finalSent: false,
    observations: [],
    running: false,
    tabId: null,
    transcript: null
  };
}

async function runAgent(port, state, payload) {
  const goal = String(payload?.goal || "").trim();
  const maxStep = clampInteger(payload?.max_step ?? payload?.maxStep ?? payload?.maxSteps, 1, MAX_STEP_LIMIT, DEFAULT_MAX_STEP);

  if (!goal) {
    throw new Error("Goal is required.");
  }

  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) {
    throw new Error("No active tab found.");
  }

  if (!/^https?:\/\//i.test(tab.url)) {
    throw new Error("This extension can only control http and https pages.");
  }

  const settings = await loadSettings();
  assertSettings(settings);
  assertAllowedHost(tab.url, settings.allowedHosts);

  const transcript = createTranscript({
    goal,
    maxStep,
    settings,
    tab
  });
  const observations = [];
  state.abortController = null;
  state.cancelled = false;
  state.currentStepRecord = null;
  state.finalSent = false;
  state.observations = observations;
  state.tabId = tab.id;
  state.transcript = transcript;
  activeAgentRuns.set(tab.id, { port, state });

  post(port, { type: "status", state: "running", tab: { id: tab.id, title: tab.title, url: tab.url } });
  post(port, { type: "log", level: "info", message: `Starting on ${new URL(tab.url).host}` });
  addTranscriptEvent(state, { type: "run_started", tab: transcript.tab });

  activeAgentTabs.add(tab.id);
  await setAgentActivity(tab.id, true);

  try {
    let currentSnapshot = await getSnapshot(tab.id);
    let step = 1;
    const referenceExample = await loadReferenceExample();
    if (referenceExample?.summary) {
      post(port, { type: "log", level: "info", message: `Using human-recorded reference flow (${referenceExample.eventCount || 0} events).` });
      addTranscriptEvent(state, { type: "reference_flow_injected", recordedAt: referenceExample.recordedAt, eventCount: referenceExample.eventCount });
    }
    const messages = buildMessages(goal, step, currentSnapshot, observations, referenceExample);

    while (step <= maxStep) {
      if (state.cancelled) {
        postFinal(port, state, {
          status: "stopped",
          summary: "Stopped by user.",
          data: null,
          observations
        });
        return;
      }

      const stepRecord = {
        step,
        startedAt: new Date().toISOString()
      };
      transcript.steps.push(stepRecord);
      state.currentStepRecord = stepRecord;

      if (state.cancelled) {
        postFinal(port, state, {
          status: "stopped",
          summary: "Stopped by user.",
          data: null,
          observations
        });
        return;
      }
      await setAgentActivity(tab.id, true);
      stepRecord.page = snapshotForTranscript(currentSnapshot);
      addTranscriptEvent(state, {
        type: "snapshot",
        step,
        title: currentSnapshot.title,
        url: currentSnapshot.url,
        actionTargetCount: currentSnapshot.elements.length
      });
      post(port, {
        type: "snapshot",
        step,
        title: currentSnapshot.title,
        url: currentSnapshot.url,
        elementCount: currentSnapshot.elements.length
      });

      stepRecord.prompt = { messages: cloneForTranscript(messages) };
      state.abortController = new AbortController();
      let modelResult;
      try {
        modelResult = await askModel(settings, messages, state.abortController.signal);
      } catch (error) {
        if (error.exchange) {
          stepRecord.llm = error.exchange;
        }
        throw error;
      } finally {
        state.abortController = null;
      }
      const { assistantMessage, exchange } = modelResult;
      stepRecord.llm = exchange;
      stepRecord.assistantMessage = assistantMessage;
      messages.push(messageForConversation(assistantMessage));

      if (state.cancelled) {
        postFinal(port, state, {
          status: "stopped",
          summary: "Stopped by user.",
          data: null,
          observations
        });
        return;
      }

      const toolCall = (assistantMessage.tool_calls || [])[0];
      if (!toolCall) {
        stepRecord.endedAt = new Date().toISOString();
        const finalPageSnapshot = await getPageArchiveSnapshot(tab.id);
        await postCheckpoint(port, {
          step,
          snapshot: currentSnapshot,
          pageSnapshot: finalPageSnapshot,
          windowId: tab.windowId,
          eventType: "final_result_stable",
          trigger: {
            type: "model_no_tool_call"
          }
        });
        postFinal(port, state, {
          status: "done",
          summary: getAssistantContent(assistantMessage) || "Model returned without a tool call.",
          data: null,
          observations
        });
        return;
      }
      const skippedToolResults = buildSkippedToolResults((assistantMessage.tool_calls || []).slice(1));
      if (skippedToolResults.length > 0) {
        stepRecord.skippedToolResults = skippedToolResults;
      }

      const toolDecision = toolCallToDecision(toolCall);
      stepRecord.parsed = {
        thought: getAssistantContent(assistantMessage),
        toolCall,
        action: toolDecision.action || null,
        final: toolDecision.final || null
      };

      if (toolDecision.final) {
        stepRecord.endedAt = new Date().toISOString();
        const finalPageSnapshot = await getPageArchiveSnapshot(tab.id);
        await postCheckpoint(port, {
          step,
          snapshot: currentSnapshot,
          pageSnapshot: finalPageSnapshot,
          windowId: tab.windowId,
          eventType: "final_result_stable",
          trigger: {
            type: "finish",
            final: toolDecision.final
          }
        });
        const toolResult = {
          ok: true,
          status: toolDecision.final.status,
          summary: toolDecision.final.summary,
          data: toolDecision.final.data ?? null
        };
        stepRecord.toolResults = [{ toolCall, result: toolResult }];
        messages.push(toolResultMessage(toolCall, toolResult));
        for (const skipped of skippedToolResults) {
          messages.push(toolResultMessage(skipped.toolCall, skipped.result));
        }
        postFinal(port, state, {
          status: toolDecision.final.status,
          summary: toolDecision.final.summary,
          data: toolDecision.final.data ?? null,
          observations
        });
        return;
      }

      const action = normalizeAction(toolDecision.action);
      addTranscriptEvent(state, {
        type: "decision",
        step,
        thought: getAssistantContent(assistantMessage),
        action
      });

      post(port, {
        type: "decision",
        step,
        thought: getAssistantContent(assistantMessage),
        action
      });

      const result = await executeAction(tab.id, action);
      if (state.cancelled) {
        postFinal(port, state, {
          status: "stopped",
          summary: "Stopped by user.",
          data: null,
          observations
        });
        return;
      }
      const observation = {
        step,
        action: compactAction(action),
        result
      };
      observations.push(observation);
      trimObservations(observations);
      stepRecord.actionResult = result;
      stepRecord.endedAt = new Date().toISOString();

      await delay(getPostActionDelay(action.type));
      currentSnapshot = await getSnapshot(tab.id);
      await postCheckpoint(port, {
        step,
        snapshot: currentSnapshot,
        windowId: tab.windowId,
        eventType: checkpointEventTypeForAction(action),
        trigger: {
          type: "tester_action",
          action: compactAction(action),
          result
        }
      });
      const toolResult = buildToolResult(step, action, result, currentSnapshot);
      stepRecord.toolResults = [{ toolCall, result: toolResult }];
      messages.push(toolResultMessage(toolCall, toolResult));
      for (const skipped of skippedToolResults) {
        messages.push(toolResultMessage(skipped.toolCall, skipped.result));
      }

      addTranscriptEvent(state, {
        type: "action_result",
        step,
        result
      });

      post(port, { type: "action_result", step, result });

      state.currentStepRecord = null;
      step += 1;
    }

    postFinal(port, state, {
      status: "max_steps",
      summary: `Reached the max_step limit (${maxStep}).`,
      data: null,
      observations
    });
  } finally {
    await cleanupRunState(state);
  }
}

async function loadSettings() {
  const syncSettings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const localSettings = await chrome.storage.local.get({ apiKey: "" });
  return {
    ...DEFAULT_SETTINGS,
    ...syncSettings,
    apiKey: localSettings.apiKey || ""
  };
}

function createTranscript({ goal, maxStep, settings, tab }) {
  return {
    id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    startedAt: new Date().toISOString(),
    endedAt: null,
    goal,
    max_step: maxStep,
    tab: {
      id: tab.id,
      windowId: tab.windowId ?? null,
      title: tab.title || "",
      url: tab.url || ""
    },
    llm: {
      baseUrl: settings.baseUrl,
      model: settings.model,
      temperature: Number(settings.temperature) || 0
    },
    allowedHosts: settings.allowedHosts || "",
    events: [],
    steps: [],
    final: null
  };
}

function snapshotForTranscript(snapshot) {
  return {
    title: snapshot.title,
    url: snapshot.url,
    viewport: snapshot.viewport,
    scroll: snapshot.scroll,
    observationScope: snapshot.observationScope || {},
    focusedElementId: snapshot.focusedElementId || "",
    actionTargetCount: snapshot.elements?.length || 0,
    observationText: snapshot.observationText || snapshot.text || "",
    actionTargets: (snapshot.elements || []).map((element) => ({
      id: element.id,
      role: element.role,
      tag: element.tag,
      type: element.type,
      label: element.label,
      value: element.value,
      placeholder: element.placeholder,
      name: element.name,
      href: element.href,
      enabled: element.enabled,
      checked: element.checked,
      rect: element.rect
    }))
  };
}

function postFinal(port, state, final) {
  if (state.finalSent) return;
  if (state.tabId) {
    activeAgentTabs.delete(state.tabId);
    setAgentActivity(state.tabId, false).catch(() => {});
  }
  addTranscriptEvent(state, {
    type: "final",
    status: final.status,
    summary: final.summary
  });
  const transcript = finalizeTranscript(state.transcript, final);
  state.finalSent = true;
  post(port, {
    type: "final",
    ...final,
    transcript
  });
}

function finalizeTranscript(transcript, final) {
  if (!transcript) return null;
  transcript.endedAt = new Date().toISOString();
  transcript.final = {
    status: final.status,
    summary: final.summary,
    data: final.data ?? null,
    observations: final.observations || []
  };
  return transcript;
}

async function cleanupRunState(state) {
  if (state.tabId) {
    activeAgentTabs.delete(state.tabId);
    activeAgentRuns.delete(state.tabId);
    await setAgentActivity(state.tabId, false);
  }
  state.abortController = null;
  state.currentStepRecord = null;
  state.tabId = null;
}

function requestStop(port, state, source = "button") {
  if (!state.running && !state.tabId) return;

  state.cancelled = true;
  addTranscriptEvent(state, { type: "stop_requested", source });
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }

  if (state.tabId) {
    activeAgentTabs.delete(state.tabId);
    setAgentActivity(state.tabId, false).catch(() => {});
  }

  const sourceLabel = source === "keyboard" ? "keyboard shortcut" : "Stop button";
  post(port, { type: "log", level: "warn", message: `Stop requested by ${sourceLabel}. Cancelling the current LLM/action step.` });
  postFinal(port, state, {
    status: "stopped",
    summary: "Stopped by user.",
    data: null,
    observations: state.observations || []
  });
}

function addTranscriptEvent(state, event) {
  if (!state.transcript) return;
  state.transcript.events.push({
    at: new Date().toISOString(),
    ...event
  });
}

function startRunKeepAlive() {
  runKeepAliveCount += 1;
  if (runKeepAliveInterval) return;

  pingServiceWorkerKeepAlive();
  runKeepAliveInterval = setInterval(pingServiceWorkerKeepAlive, 20 * 1000);
}

function stopRunKeepAlive() {
  runKeepAliveCount = Math.max(0, runKeepAliveCount - 1);
  if (runKeepAliveCount > 0 || !runKeepAliveInterval) return;

  clearInterval(runKeepAliveInterval);
  runKeepAliveInterval = null;
}

function pingServiceWorkerKeepAlive() {
  try {
    chrome.runtime.getPlatformInfo(() => {
      void chrome.runtime.lastError;
    });
  } catch (_error) {
    // Keep-alive pings are best-effort; the run should still surface its own error.
  }
}

function assertSettings(settings) {
  if (!settings.baseUrl || !/^https?:\/\//i.test(settings.baseUrl)) {
    throw new Error("Set a valid LLM base URL in the extension options.");
  }
  if (!settings.model) {
    throw new Error("Set a model name in the extension options.");
  }
}

function assertAllowedHost(tabUrl, allowedHosts) {
  const rules = parseAllowedHosts(allowedHosts);
  if (rules.length === 0) return;

  const host = new URL(tabUrl).host.toLowerCase();
  const allowed = rules.some((rule) => host === rule || host.endsWith(`.${rule}`));
  if (!allowed) {
    throw new Error(`The active tab host (${host}) is not in the allowlist.`);
  }
}

function parseAllowedHosts(raw) {
  return String(raw || "")
    .split(/[\n,]/)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
    .map((host) => host.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getSnapshot(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "GET_SNAPSHOT" });
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/contentScript.js"]
    });
    await delay(150);
    return chrome.tabs.sendMessage(tabId, { type: "GET_SNAPSHOT" });
  }
}

async function getPageArchiveSnapshot(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_ARCHIVE_SNAPSHOT" });
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["src/contentScript.js"]
      });
      await delay(150);
      return await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_ARCHIVE_SNAPSHOT" });
    } catch (nestedError) {
      console.warn("Could not capture final page snapshot", nestedError);
      return {
        schema_version: "page-snapshot.v1",
        capture_type: "final_page_snapshot",
        captured_at: new Date().toISOString(),
        error: getErrorMessage(nestedError),
        url: "",
        title: "",
        html: "",
        resources: []
      };
    }
  }
}

async function captureVisibleTabDataUrl(windowId) {
  if (!chrome.tabs.captureVisibleTab) {
    return { dataUrl: null, error: "chrome.tabs.captureVisibleTab is unavailable." };
  }

  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await delay(250 + attempt * 250);
    }

    try {
      const dataUrl = await new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(windowId ?? undefined, { format: "png" }, (value) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message || "Capture failed."));
            return;
          }
          resolve(typeof value === "string" && value ? value : null);
        });
      });
      if (dataUrl) {
        return { dataUrl, error: "" };
      }
      lastError = "Capture returned empty image data.";
    } catch (error) {
      lastError = getErrorMessage(error);
      console.warn("Could not capture checkpoint screenshot", error);
    }
  }

  return { dataUrl: null, error: lastError || "Capture failed." };
}

async function postCheckpoint(port, options) {
  const capturedAt = new Date().toISOString();
  const screenshotCapture = await captureVisibleTabDataUrl(options.windowId);
  const screenshotDataUrl = screenshotCapture.dataUrl;
  const snapshot = options.snapshot || {};
  post(port, {
    type: "checkpoint",
    step: options.step,
    eventType: options.eventType || "website_state_stable",
    stability: options.stability || "stable",
    createdAt: capturedAt,
    page: snapshotForTranscript(snapshot),
    pageSnapshot: options.pageSnapshot || null,
    trigger: options.trigger || {},
    screenshotError: screenshotCapture.error || "",
    screenshot: screenshotDataUrl
      ? {
          dataUrl: screenshotDataUrl,
          mimeType: "image/png",
          width: snapshot.viewport?.width || 0,
          height: snapshot.viewport?.height || 0,
          capturedAt
        }
      : null
  });
}

function checkpointEventTypeForAction(action) {
  switch (action?.type) {
    case "scroll":
      return "viewport_state_stable";
    case "wait":
      return "assistant_output_stable";
    case "click":
    case "type_text":
    case "select_option":
    case "press_key":
    case "hover":
    case "drag":
      return "website_state_stable";
    default:
      return "website_state_stable";
  }
}

async function executeAction(tabId, action) {
  return chrome.tabs.sendMessage(tabId, {
    type: "EXECUTE_ACTION",
    action
  });
}

async function setAgentActivity(tabId, active) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "SET_AGENT_ACTIVITY",
      active
    });
  } catch (error) {
    if (!active) return { ok: false };
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["src/contentScript.js"]
      });
      await delay(100);
      return await chrome.tabs.sendMessage(tabId, {
        type: "SET_AGENT_ACTIVITY",
        active
      });
    } catch (_nestedError) {
      return { ok: false };
    }
  }
}

function buildMessages(goal, step, snapshot, observations, referenceExample) {
  const systemLines = [
    "You are a browser QA and data-collection agent.",
    "You inspect compact accessibility-tree-like page observations and choose exactly one next browser tool call.",
    "Do not output JSON actions in assistant content. Use the provided tools for every browser action and use finish when the task is complete or impossible.",
    "Actionable page nodes are shown as [elementId] role \"name\". Use the elementId without brackets, for example e12.",
    "The page observation says whether it is a full-page DOM view or an expanded viewport-centered DOM view. Use scroll when content is omitted.",
    "Indentation is meaningful: child lines belong to the nearest less-indented parent group, form, region, list item, or component.",
    "Prefer elementId over selector when targeting elements. Use scroll when the needed content is likely offscreen or omitted.",
    "Use focus before keyboard-only interactions, hover for menus that reveal on mouseover, targeted scroll for nested scrollable panes, and drag for sliders or draggable controls.",
    "Use done when the requested test/data collection goal is complete.",
    "Tool results include the updated page observation for the next step.",
    "Do not complete purchases, submit payments, bypass CAPTCHAs, or perform irreversible production actions unless the goal explicitly says this is a test environment and the page clearly confirms it."
  ];

  if (referenceExample?.summary) {
    systemLines.push(
      "",
      "Reference flow recorded by a human operator (use it as a strong hint for ordering and key decision points; parameters in the current task may differ from those in the recording, adapt as needed and do not copy values verbatim). The reference flow ends with an explicit terminal condition: as soon as the current page state matches that condition for the current Goal, call the finish tool with status 'done' and stop — do not continue performing additional actions beyond the terminal condition described in the reference.",
      "---",
      String(referenceExample.summary).trim(),
      "---"
    );
  }

  const system = systemLines.join("\n");

  const recentObservations = observations.length
    ? JSON.stringify(observations.slice(-6), null, 2)
    : "None";
  const observationText = snapshot.observationText || snapshot.text || "";
  const userContent = [
    `Goal: ${goal}`,
    `Step: ${step}`,
    `Current page: ${snapshot.title || "Untitled"}`,
    `URL: ${snapshot.url}`,
    `Viewport: ${snapshot.viewport?.width || "?"}x${snapshot.viewport?.height || "?"}`,
    `Scroll: x=${snapshot.scroll?.x ?? "?"}, y=${snapshot.scroll?.y ?? "?"}, maxY=${snapshot.scroll?.maxY ?? "?"}`,
    `Focused elementId: ${snapshot.focusedElementId || "none"}`,
    `Action target count: ${snapshot.elements?.length || 0}`,
    "",
    "Page observation:",
    observationText,
    "",
    "Recent observations:",
    recentObservations
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: userContent }
  ];
}

function createBrowserTools() {
  const targetProperties = {
    elementId: {
      type: "string",
      description: "Actionable or scrollable element id from the observation, such as e12."
    },
    selector: {
      type: "string",
      description: "Optional CSS selector only when no elementId is available."
    }
  };

  return [
    {
      type: "function",
      function: {
        name: "click",
        description: "Click an actionable page element.",
        parameters: {
          type: "object",
          properties: targetProperties,
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "double_click",
        description: "Double-click an actionable page element.",
        parameters: {
          type: "object",
          properties: targetProperties,
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "hover",
        description: "Move the pointer over an element to reveal hover menus or tooltips.",
        parameters: {
          type: "object",
          properties: targetProperties,
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "focus",
        description: "Focus an element without clicking it.",
        parameters: {
          type: "object",
          properties: targetProperties,
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "type_text",
        description: "Type text into an input, textarea, or contenteditable element.",
        parameters: {
          type: "object",
          properties: {
            ...targetProperties,
            text: { type: "string", description: "Text to enter." },
            clear: { type: "boolean", description: "Whether to clear existing text first." }
          },
          required: ["text"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "clear_text",
        description: "Clear text from an input, textarea, select, or contenteditable element.",
        parameters: {
          type: "object",
          properties: targetProperties,
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "select_option",
        description: "Select an option in a select element by value.",
        parameters: {
          type: "object",
          properties: {
            ...targetProperties,
            value: { type: "string", description: "Option value to select." }
          },
          required: ["value"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "set_checked",
        description: "Set a checkbox, radio button, or switch to a desired checked state.",
        parameters: {
          type: "object",
          properties: {
            ...targetProperties,
            checked: { type: "boolean", description: "Desired checked state." }
          },
          required: ["checked"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "press_key",
        description: "Press a keyboard key on the currently focused element or an explicitly targeted element.",
        parameters: {
          type: "object",
          properties: {
            ...targetProperties,
            key: { type: "string", description: "Keyboard key, such as Enter, Escape, ArrowDown, Tab." },
            shift: { type: "boolean", description: "Hold Shift while pressing the key." },
            ctrl: { type: "boolean", description: "Hold Control while pressing the key." },
            alt: { type: "boolean", description: "Hold Alt/Option while pressing the key." },
            meta: { type: "boolean", description: "Hold Command/Windows while pressing the key." }
          },
          required: ["key"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "drag",
        description: "Drag an element by a viewport pixel delta, useful for sliders and draggable controls.",
        parameters: {
          type: "object",
          properties: {
            ...targetProperties,
            deltaX: { type: "integer", minimum: -5000, maximum: 5000 },
            deltaY: { type: "integer", minimum: -5000, maximum: 5000 },
            steps: { type: "integer", minimum: 1, maximum: 30 }
          },
          required: ["deltaX", "deltaY"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "scroll",
        description: "Scroll the page or a targeted scrollable element to inspect omitted content.",
        parameters: {
          type: "object",
          properties: {
            ...targetProperties,
            direction: { type: "string", enum: ["down", "up", "left", "right"] },
            amount: { type: "integer", minimum: 1, maximum: 5000 }
          },
          required: ["direction"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "wait",
        description: "Wait for page updates or loading.",
        parameters: {
          type: "object",
          properties: {
            ms: { type: "integer", minimum: 0, maximum: 10000 }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "finish",
        description: "Finish the task with success or failure.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["done", "fail"] },
            summary: { type: "string" },
            reason: { type: "string" },
            data: {
              type: "object",
              description: "Structured data collected from the page.",
              additionalProperties: true
            }
          },
          required: ["status"],
          additionalProperties: false
        }
      }
    }
  ];
}

async function askModel(settings, messages, signal) {
  const endpoint = `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const requestBody = {
    model: settings.model,
    messages,
    tools: createBrowserTools(),
    tool_choice: "auto",
    reasoning_effort: "high",
    thinking: { type: "enabled" }
  };

  const exchange = {
    endpoint,
    attempts: [],
    content: "",
    reasoning: null,
    toolCalls: [],
    usage: null,
    model: settings.model,
    usedFallbackWithoutThinkingMode: false
  };

  let attempt = await performChatCompletionAttempt(endpoint, settings.apiKey, requestBody, signal);
  exchange.attempts.push(attempt);

  if (!attempt.response.ok && [400, 404, 422].includes(attempt.response.status)) {
    const fallbackBody = { ...requestBody };
    delete fallbackBody.reasoning_effort;
    delete fallbackBody.thinking;
    fallbackBody.temperature = Number(settings.temperature) || 0;
    exchange.usedFallbackWithoutThinkingMode = true;
    attempt = await performChatCompletionAttempt(endpoint, settings.apiKey, fallbackBody, signal);
    exchange.attempts.push(attempt);
  }

  if (!attempt.response.ok) {
    const error = new Error(`LLM request failed (${attempt.response.status}): ${attempt.responseText.slice(0, 500)}`);
    error.exchange = exchange;
    throw error;
  }

  const payload = attempt.responseJson;
  const message = payload?.choices?.[0]?.message || {};
  const content = getAssistantContent(message);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (!content && toolCalls.length === 0) {
    const error = new Error("LLM response did not include message content.");
    error.exchange = exchange;
    throw error;
  }

  exchange.content = content;
  exchange.reasoning = extractReasoning(payload);
  exchange.toolCalls = toolCalls;
  exchange.usage = payload?.usage || null;
  exchange.model = payload?.model || settings.model;

  return {
    assistantMessage: {
      role: "assistant",
      content: content || "",
      reasoning_content: exchange.reasoning,
      tool_calls: toolCalls
    },
    exchange
  };
}

async function performChatCompletionAttempt(endpoint, apiKey, body, signal) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const requestBody = cloneForTranscript(body);
  const response = await fetchChatCompletion(endpoint, apiKey, body, signal);
  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = JSON.parse(responseText);
  } catch (_error) {
    responseJson = null;
  }

  return {
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    request: {
      endpoint,
      body: requestBody
    },
    response: {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body: responseJson ?? responseText
    },
    responseJson,
    responseText
  };
}

function fetchChatCompletion(endpoint, apiKey, body, signal) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal
  });
}

function getAssistantContent(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        return part?.text || part?.content || "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractReasoning(payload) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const candidates = [
    message.reasoning_content,
    message.reasoning,
    message.reasoning_details,
    message.provider_specific_fields?.reasoning_content,
    message.provider_specific_fields?.reasoning,
    choice.reasoning,
    payload?.reasoning
  ];
  return candidates.find((candidate) => candidate != null && candidate !== "") ?? null;
}

function messageForConversation(message) {
  const nextMessage = {
    role: "assistant",
    content: message.content || ""
  };
  if (message.reasoning_content != null && message.reasoning_content !== "") {
    nextMessage.reasoning_content = message.reasoning_content;
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    nextMessage.tool_calls = message.tool_calls;
  }
  return nextMessage;
}

function toolCallToDecision(toolCall) {
  const name = toolCall?.function?.name || "";
  const args = parseToolArguments(toolCall?.function?.arguments);

  if (name === "finish") {
    const status = args.status === "fail" ? "fail" : "done";
    return {
      final: {
        status,
        summary: String(args.summary || args.reason || status),
        data: args.data ?? null
      }
    };
  }

  const baseTarget = {
    elementId: args.elementId ? String(args.elementId) : undefined,
    selector: args.selector ? String(args.selector) : undefined
  };

  const map = {
    click: () => ({ type: "click", ...baseTarget }),
    double_click: () => ({ type: "double_click", ...baseTarget }),
    hover: () => ({ type: "hover", ...baseTarget }),
    focus: () => ({ type: "focus", ...baseTarget }),
    type_text: () => ({
      type: "type",
      ...baseTarget,
      text: String(args.text ?? ""),
      clear: Boolean(args.clear)
    }),
    clear_text: () => ({
      type: "clear",
      ...baseTarget
    }),
    select_option: () => ({
      type: "select",
      ...baseTarget,
      value: String(args.value ?? "")
    }),
    set_checked: () => ({
      type: "set_checked",
      ...baseTarget,
      checked: Boolean(args.checked)
    }),
    press_key: () => ({
      type: "press_key",
      ...baseTarget,
      shift: Boolean(args.shift),
      ctrl: Boolean(args.ctrl),
      alt: Boolean(args.alt),
      meta: Boolean(args.meta),
      key: String(args.key || "Enter")
    }),
    drag: () => ({
      type: "drag",
      ...baseTarget,
      deltaX: args.deltaX,
      deltaY: args.deltaY,
      steps: args.steps
    }),
    scroll: () => ({
      type: "scroll",
      ...baseTarget,
      direction: String(args.direction || "down"),
      amount: args.amount
    }),
    wait: () => ({
      type: "wait",
      ms: args.ms
    })
  };

  if (!map[name]) {
    throw new Error(`Unsupported tool call: ${name || "(missing)"}`);
  }

  return { action: map[name]() };
}

function parseToolArguments(rawArguments) {
  if (!rawArguments) return {};
  if (typeof rawArguments === "object") return rawArguments;
  try {
    return JSON.parse(rawArguments);
  } catch (error) {
    throw new Error(`Could not parse tool arguments: ${String(rawArguments).slice(0, 300)}`);
  }
}

function buildToolResult(step, action, result, snapshot) {
  return {
    ok: Boolean(result?.ok),
    step,
    nextStep: step + 1,
    action: compactAction(action),
    result,
    page: {
      title: snapshot.title,
      url: snapshot.url,
      viewport: snapshot.viewport,
      scroll: snapshot.scroll,
      observationScope: snapshot.observationScope || {},
      focusedElementId: snapshot.focusedElementId || "",
      actionTargetCount: snapshot.elements?.length || 0,
      observationText: snapshot.observationText || snapshot.text || ""
    }
  };
}

function buildSkippedToolResults(toolCalls) {
  return toolCalls.map((toolCall) => ({
    toolCall,
    result: {
      ok: false,
      error: "Only one browser tool call is executed per assistant response. Call exactly one tool in the next response."
    }
  }));
}

function toolResultMessage(toolCall, result) {
  return {
    role: "tool",
    tool_call_id: toolCall.id || `${toolCall?.function?.name || "tool"}_${Date.now()}`,
    name: toolCall?.function?.name || "",
    content: JSON.stringify(result)
  };
}

function cloneForTranscript(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseJsonResponse(content) {
  const trimmed = String(content).trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error(`Could not parse LLM JSON: ${trimmed.slice(0, 300)}`);
  }
}

function normalizeAction(rawAction) {
  if (!rawAction || typeof rawAction !== "object") {
    throw new Error("LLM response must include an action object.");
  }

  const type = String(rawAction.type || "").trim().toLowerCase();
  if (!ACTION_TYPES.has(type)) {
    throw new Error(`Unsupported action type: ${type || "(missing)"}`);
  }

  const action = { ...rawAction, type };
  if (action.elementId) action.elementId = String(action.elementId);
  if (action.selector) action.selector = String(action.selector);
  if (action.text != null) action.text = String(action.text);
  if (action.value != null) action.value = String(action.value);
  if (action.key != null) action.key = String(action.key);
  if (action.direction != null) action.direction = String(action.direction).toLowerCase();
  if (action.amount != null) action.amount = clampInteger(action.amount, 1, 5000, 700);
  if (action.ms != null) action.ms = clampInteger(action.ms, 0, 10000, 1000);
  if (action.clear != null) action.clear = Boolean(action.clear);
  if (action.checked != null) action.checked = Boolean(action.checked);
  if (action.shift != null) action.shift = Boolean(action.shift);
  if (action.ctrl != null) action.ctrl = Boolean(action.ctrl);
  if (action.alt != null) action.alt = Boolean(action.alt);
  if (action.meta != null) action.meta = Boolean(action.meta);
  if (action.deltaX != null) action.deltaX = clampInteger(action.deltaX, -5000, 5000, 0);
  if (action.deltaY != null) action.deltaY = clampInteger(action.deltaY, -5000, 5000, 0);
  if (action.steps != null) action.steps = clampInteger(action.steps, 1, 30, 10);
  return action;
}

function compactAction(action) {
  const clone = { ...action };
  if (clone.text && clone.text.length > 120) {
    clone.text = `${clone.text.slice(0, 120)}...`;
  }
  return clone;
}

function trimObservations(observations) {
  while (JSON.stringify(observations).length > 12000 && observations.length > 2) {
    observations.shift();
  }
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPostActionDelay(actionType) {
  if (actionType === "wait") return 0;
  if (actionType === "click" || actionType === "double_click") return 1200;
  if (actionType === "press_key") return 900;
  if (actionType === "scroll") return 350;
  if (actionType === "hover" || actionType === "focus" || actionType === "drag") return 500;
  return 500;
}

function isAbortError(error) {
  return Boolean(error && (error.name === "AbortError" || error.message === "The user aborted a request."));
}

function getErrorMessage(error) {
  if (!error) return "Unknown error.";
  if (typeof error === "string") return error;
  return error.message || String(error);
}

function post(port, message) {
  try {
    port.postMessage(message);
  } catch (error) {
    console.warn("Could not post message to panel", error);
  }
}

async function loadReferenceExample() {
  try {
    const data = await chrome.storage.local.get(REFERENCE_STORAGE_KEY);
    return data?.[REFERENCE_STORAGE_KEY] || null;
  } catch (_error) {
    return null;
  }
}

async function startRecording(port, payload) {
  if (recordingState.active) {
    post(port, { type: "RECORDING_ERROR", message: "A recording is already in progress." });
    return;
  }

  let tabId = payload?.tabId;
  if (!tabId) {
    const tab = await getActiveTab();
    tabId = tab?.id;
  }
  if (!tabId) {
    throw new Error("No active tab to record.");
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    throw new Error("Recording target tab is not accessible.");
  }
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error("Recording only works on http and https pages.");
  }

  recordingState.active = true;
  recordingState.tabId = tabId;
  recordingState.startedAt = new Date().toISOString();
  recordingState.startUrl = tab.url;
  recordingState.events = [];
  recordingState.port = port;
  startRunKeepAlive();

  try {
    await sendTabRecordingMessage(tabId, { type: "START_RECORDING" });
  } catch (error) {
    recordingState.active = false;
    recordingState.tabId = null;
    recordingState.port = null;
    stopRunKeepAlive();
    throw error;
  }

  post(port, {
    type: "RECORDING_STARTED",
    startedAt: recordingState.startedAt,
    startUrl: recordingState.startUrl,
    tabId
  });
}

async function stopRecording(port) {
  if (!recordingState.active) {
    post(port, { type: "RECORDING_ERROR", message: "No active recording." });
    return;
  }

  const tabId = recordingState.tabId;
  const lastEvent = recordingState.events[recordingState.events.length - 1];
  recordingState.events.push({
    type: "stop",
    url: lastEvent?.url || recordingState.startUrl || "",
    title: lastEvent?.title || "",
    ts: new Date().toISOString(),
    note: "Recording stopped here — the human operator considered the task complete at this point. The page state shown in the immediately preceding event is the terminal state."
  });
  const events = recordingState.events.slice();
  const startedAt = recordingState.startedAt;
  const startUrl = recordingState.startUrl;

  recordingState.active = false;
  recordingState.tabId = null;
  recordingState.events = [];
  recordingState.startedAt = null;
  recordingState.startUrl = "";
  recordingState.port = null;

  if (tabId != null) {
    sendTabRecordingMessage(tabId, { type: "STOP_RECORDING" }).catch(() => {});
  }

  if (events.length === 0) {
    stopRunKeepAlive();
    post(port, { type: "RECORDING_ERROR", message: "No events captured during recording." });
    return;
  }

  post(port, { type: "RECORDING_SUMMARIZING", eventCount: events.length });

  try {
    let summary;
    try {
      summary = await summarizeRecording(events, { startUrl, startedAt });
    } catch (error) {
      post(port, { type: "RECORDING_ERROR", message: `Summary failed: ${getErrorMessage(error)}` });
      return;
    }

    const reference = {
      summary,
      recordedAt: startedAt,
      summarizedAt: new Date().toISOString(),
      eventCount: events.length,
      startUrl
    };
    await chrome.storage.local.set({ [REFERENCE_STORAGE_KEY]: reference });
    post(port, { type: "RECORDING_SUMMARIZED", reference });
  } finally {
    stopRunKeepAlive();
  }
}

async function summarizeRecording(events, context) {
  const settings = await loadSettings();
  assertSettings(settings);

  const compact = events.map((event, index) => ({
    i: index + 1,
    type: event.type,
    target: event.target ? {
      tag: event.target.tag,
      role: event.target.role,
      label: event.target.label,
      placeholder: event.target.placeholder,
      name: event.target.name,
      value: event.target.value,
      href: event.target.href
    } : null,
    value: event.value,
    key: event.key,
    modifiers: event.modifiers,
    scroll: event.scroll,
    url: event.url,
    title: event.title,
    pageBrief: event.snapshotBrief?.textBrief || ""
  }));

  const systemPrompt = [
    "You are a browser operation flow analyst.",
    "You will receive a chronological sequence of user interactions captured during a human recording: clicks, inputs, key presses, submits, and scroll events, together with the page title/URL and a short text snapshot of the page at the time of each event. The final event always has type 'stop' — it marks the moment the human operator considered the task complete; the page state described in the event immediately before 'stop' is the terminal state of a successful run.",
    "Produce a single self-contained paragraph in fluent natural language (no numbered list, no JSON, no markdown headings) that describes the operation flow as a reusable reference for an automation agent.",
    "Requirements:",
    "- Describe order, intent, and key decision points using connective language like 'first ... then ... if ... otherwise ...'.",
    "- Refer to UI elements by semantic names (e.g. 'the search input in the top bar'), never by raw CSS selectors.",
    "- Do not invent steps that did not occur in the recording.",
    "- Treat captured input/search values as illustrative examples; explicitly note that real parameters may differ.",
    "- End the paragraph with an explicit terminal-condition sentence in the form 'The task is complete once <observable page state>, at which point the run should finish.' — describe what visibly indicates success based on the last few events before 'stop'.",
    `- Target length: between ${RECORDING_SUMMARY_MIN_CHARS} and ${RECORDING_SUMMARY_MAX_CHARS} characters.`,
    "- Respond with the paragraph only, no preface."
  ].join("\n");

  const userPrompt = [
    `Recording started at: ${context.startedAt}`,
    `Start URL: ${context.startUrl}`,
    `Event count: ${events.length}`,
    "Events (JSON):",
    JSON.stringify(compact, null, 2)
  ].join("\n");

  const endpoint = `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: Number(settings.temperature) || 0.2
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120 * 1000);
  let attempt;
  try {
    attempt = await performChatCompletionAttempt(endpoint, settings.apiKey, body, controller.signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error("Summary request timed out after 120 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!attempt.response.ok) {
    throw new Error(`LLM request failed (${attempt.response.status}): ${attempt.responseText.slice(0, 300)}`);
  }
  const choice = attempt.responseJson?.choices?.[0];
  const content = getAssistantContent(choice?.message || {}) || (typeof choice?.message?.content === "string" ? choice.message.content : "");
  const text = String(content || "").trim();
  if (!text) {
    throw new Error("Model returned an empty summary.");
  }
  return text;
}

async function sendTabRecordingMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || "Tab message failed."));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}
