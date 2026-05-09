# Auto Agent Tester

A Manifest V3 Chrome extension that lets an LLM inspect the active page, choose browser actions, execute clicks/text input/scrolling, and return structured test or collection results.

## What it does

- Captures a compact BrowserGym-inspired page observation: URL, title, viewport state, a hierarchical accessibility-tree-like text view, and actionable element IDs.
- Marks the observation as partial when content above or below the viewport is omitted, so the model knows when to scroll.
- Sends that snapshot plus your goal to an OpenAI-compatible `/chat/completions` LLM endpoint with browser actions exposed as tool calls.
- Executes one browser tool call per step: `click`, `type_text`, `select_option`, `press_key`, `scroll`, `wait`, or `finish`.
- Shows a side-panel run log and a lightweight final summary.
- Exports a full run transcript with page observations, prompts, LLM request bodies, raw responses, exposed reasoning fields when the provider returns them, parsed actions, and action results.
- Records the controlled tab while a run is active and exposes the recording as a `.webm` download after the run stops.
- Shows an animated marquee border around the active page while the agent is running.
- Keeps the Manifest V3 background service worker alive during Agent runs so slower LLM calls are less likely to disconnect the side panel.
- Supports an optional host allowlist so runs are limited to known test domains.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository directory.
5. Open the extension options and set:
   - `Base URL`: an OpenAI-compatible API root, for example `https://api.openai.com/v1`
   - `Model`: the model name supported by that endpoint
   - `API key`: optional for local endpoints, required by most hosted providers
   - `Allowed hosts`: optional, one host per line

Click the extension icon to open the side panel, enter a testing or collection goal, then start a run on the active tab.

After a run finishes, use **Download Recording** to save the captured tab video. Recording starts from the Start button click and stops on normal completion, max-step stop, error, manual Stop, or the `A` emergency shortcut. The extension first tries silent tab recording with `tabCapture`. If Chrome has not granted `activeTab` capture access for the current page, it falls back to Chrome's manual tab/window/screen picker; select the current test tab to continue recording. Chrome internal pages such as `chrome://extensions` cannot be captured or controlled by this Agent.

## LLM action contract

The background service worker asks the model to call one browser tool per step. Example tool call:

```json
{
  "tool_calls": [
    {
      "type": "function",
      "function": {
        "name": "click",
        "arguments": "{\"elementId\":\"e12\"}"
      }
    }
  ]
}
```

Completion uses the `finish` tool:

```json
{
  "tool_calls": [
    {
      "type": "function",
      "function": {
        "name": "finish",
        "arguments": "{\"status\":\"done\",\"summary\":\"Collected product details.\",\"data\":{\"title\":\"Example\",\"price\":\"$10\"}}"
      }
    }
  ]
}
```

When the provider returns `reasoning_content` with tool calls, the extension keeps it in the transcript and sends it back in the next chat-completions request alongside the assistant `tool_calls` and matching tool result.

## Files

- `manifest.json`: Chrome extension manifest.
- `src/background.js`: LLM loop, settings, host scope, content-script messaging.
- `src/contentScript.js`: DOM snapshot and action executor.
- `src/sidepanel.*`: run UI.
- `src/options.*`: LLM and allowlist settings.

## Notes

API keys are stored in `chrome.storage.local` for this browser profile. Use a low-privilege key and prefer staging/test environments. The built-in prompt blocks purchases, payments, CAPTCHA bypass, and irreversible production actions unless the goal and page clearly indicate a test environment.
