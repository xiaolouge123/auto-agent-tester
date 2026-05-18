# Auto Agent Tester

A Manifest V3 Chrome extension that lets an LLM inspect the active page, choose browser actions, execute clicks, text input, hover/focus/key/drag/scroll interactions, and return structured test or collection results.

## What it does

- Captures a compact BrowserGym-inspired page observation: URL, title, viewport state, a hierarchical accessibility-tree-like text view, and actionable element IDs.
- Captures a full-page DOM observation for short pages, and an expanded viewport-centered observation for longer pages.
- Marks the observation as partial when content above or below the expanded scope is omitted, so the model knows when to scroll.
- Sends that snapshot plus your goal to an OpenAI-compatible `/chat/completions` LLM endpoint with browser actions exposed as tool calls.
- Executes one browser tool call per step: `click`, `double_click`, `hover`, `focus`, `type_text`, `clear_text`, `select_option`, `set_checked`, `press_key`, `drag`, `scroll`, `wait`, or `finish`.
- Shows a side-panel run log and a lightweight final summary.
- Exports a full run transcript with page observations, prompts, LLM request bodies, raw responses, exposed reasoning fields when the provider returns them, parsed actions, and action results.
- Runs batch tasks from a CSV or `.xlsx` file. By default it reads `id` and `prompt` columns, then exports one `<id>.zip` per row containing `metadata.json`, `result.json`, `log.txt`, and the recording when available.
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

For batch mode, upload a CSV or `.xlsx` file in the side panel. The file should include an ID column and a prompt column, for example:

```csv
id,prompt
case-001,"Search for wireless keyboard and collect the first result title and price."
case-002,"Open the cart and verify the empty cart message."
```

The batch runner executes rows sequentially against the current controlled tab. In batch mode, the side-panel `Goal` field is treated as a template when it contains placeholders such as `{{prompt}}`, `{{id}}`, or any other CSV/XLSX column name. If the `Goal` field has no placeholder, it is prepended to the row prompt as shared instructions. Each row downloads a zip named from the ID value; the zip contains an ID-named folder with the prompt metadata, full JSON transcript, run log, and `.webm` recording if capture was available.

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

Available browser tools:

- `click`, `double_click`, `hover`, and `focus` target an observed `elementId` or a fallback CSS `selector`.
- `type_text` enters text and can clear first with `clear`; `clear_text` clears a text input, textarea, select, or contenteditable element.
- `select_option` selects a native `<select>` option by value; `set_checked` sets checkbox/radio/switch state deterministically.
- `press_key` can target an element before pressing a key and supports `shift`, `ctrl`, `alt`, and `meta` modifiers.
- `drag` drags a target by `deltaX`/`deltaY` viewport pixels; range inputs are adjusted directly from the delta.
- `scroll` can scroll the page or a targeted scrollable element, including `up`, `down`, `left`, and `right`.

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
