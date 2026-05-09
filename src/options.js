const DEFAULT_SETTINGS = {
  baseUrl: "https://api.openai.com/v1",
  model: "",
  temperature: 0.1,
  allowedHosts: ""
};

const elements = {
  form: document.getElementById("settingsForm"),
  baseUrl: document.getElementById("baseUrl"),
  model: document.getElementById("model"),
  apiKey: document.getElementById("apiKey"),
  temperature: document.getElementById("temperature"),
  allowedHosts: document.getElementById("allowedHosts"),
  status: document.getElementById("status")
};

loadSettings();

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const syncSettings = {
    baseUrl: elements.baseUrl.value.trim().replace(/\/+$/, ""),
    model: elements.model.value.trim(),
    temperature: Number(elements.temperature.value) || 0,
    allowedHosts: elements.allowedHosts.value.trim()
  };

  await chrome.storage.sync.set(syncSettings);
  await chrome.storage.local.set({ apiKey: elements.apiKey.value.trim() });
  showStatus("Saved");
});

async function loadSettings() {
  const syncSettings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const localSettings = await chrome.storage.local.get({ apiKey: "" });

  elements.baseUrl.value = syncSettings.baseUrl || DEFAULT_SETTINGS.baseUrl;
  elements.model.value = syncSettings.model || DEFAULT_SETTINGS.model;
  elements.temperature.value = syncSettings.temperature ?? DEFAULT_SETTINGS.temperature;
  elements.allowedHosts.value = syncSettings.allowedHosts || "";
  elements.apiKey.value = localSettings.apiKey || "";
}

function showStatus(message) {
  elements.status.textContent = message;
  window.setTimeout(() => {
    elements.status.textContent = "";
  }, 1800);
}
