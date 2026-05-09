(() => {
  if (window.__autoAgentTesterLoaded) return;
  window.__autoAgentTesterLoaded = true;

  const elementCache = new Map();
  let highlightOverlay;
  let activityOverlay;
  let activityStyle;

  const MAX_ACTION_TARGETS = 220;
  const OBSERVATION_MAX_CHARS = 14000;
  const OBSERVATION_MAX_LINES = 260;
  const NEAR_VIEWPORT_MARGIN_TOP = 800;
  const NEAR_VIEWPORT_MARGIN_BOTTOM = 1800;
  const TREE_EXCLUDED_TAGS = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "meta",
    "link"
  ]);
  const TEXT_ROLES = new Set(["heading", "paragraph", "label", "listitem", "cell", "columnheader", "rowheader", "StaticText"]);
  const CONTROL_ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "option"]);
  const COMPONENT_CONTAINER_TAGS = new Set([
    "article",
    "aside",
    "details",
    "dialog",
    "fieldset",
    "form",
    "li",
    "section"
  ]);
  const GENERIC_IDENTIFIER_TOKENS = new Set([
    "app",
    "box",
    "col",
    "container",
    "content",
    "flex",
    "grid",
    "inner",
    "layout",
    "outer",
    "root",
    "row",
    "wrapper"
  ]);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_SNAPSHOT") {
      sendResponse(createSnapshot());
      return false;
    }

    if (message?.type === "EXECUTE_ACTION") {
      executeAction(message.action)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;
    }

    if (message?.type === "SET_AGENT_ACTIVITY") {
      setAgentActivity(Boolean(message.active));
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  notifyContentReady();
  window.addEventListener("keydown", handleAgentEmergencyStopKey, true);

  function createSnapshot() {
    elementCache.clear();

    const targetEntries = collectInteractiveElements()
      .slice(0, MAX_ACTION_TARGETS)
      .map((element, index) => {
        const description = describeElement(element, `e${index + 1}`);
        return description ? { element, description } : null;
      })
      .filter(Boolean);
    const targetMap = new Map(targetEntries.map(({ element, description }) => [element, description]));
    const elements = targetEntries.map(({ description }) => description);
    const observationText = buildPageObservation(targetMap, elements);

    return {
      title: document.title,
      url: location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      scroll: {
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY),
        maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      },
      text: observationText,
      observationText,
      focusedElementId: getFocusedElementId(targetMap),
      elements
    };
  }

  function collectInteractiveElements() {
    const selector = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "summary",
      "[role='button']",
      "[role='link']",
      "[role='checkbox']",
      "[role='combobox']",
      "[role='option']",
      "[role='radio']",
      "[role='searchbox']",
      "[role='slider']",
      "[role='spinbutton']",
      "[role='switch']",
      "[role='tab']",
      "[role='textbox']",
      "[role='menuitem']",
      "[contenteditable='true']",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");

    const all = Array.from(document.querySelectorAll(selector));
    const visible = all.filter(isElementUsable);

    visible.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const aInView = rectIntersectsViewport(ar) ? 0 : 1;
      const bInView = rectIntersectsViewport(br) ? 0 : 1;
      if (aInView !== bInView) return aInView - bInView;
      if (Math.abs(ar.top - br.top) > 8) return ar.top - br.top;
      return ar.left - br.left;
    });

    return visible;
  }

  function describeElement(element, id) {
    const rect = element.getBoundingClientRect();
    const label = getElementLabel(element);
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || implicitRole(element);
    const selector = buildSelector(element);

    elementCache.set(id, element);

    return {
      id,
      tag,
      role,
      type: element.getAttribute("type") || "",
      label: label.slice(0, 180),
      value: getElementValue(element).slice(0, 180),
      placeholder: (element.getAttribute("placeholder") || "").slice(0, 120),
      name: (element.getAttribute("name") || "").slice(0, 120),
      href: tag === "a" ? (element.href || "").slice(0, 240) : "",
      selector,
      enabled: !isDisabled(element),
      checked: "checked" in element ? Boolean(element.checked) : undefined,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function buildPageObservation(targetMap, targets) {
    const targetElements = Array.from(targetMap.keys());
    const containsTargetCache = new WeakMap();
    const targetCountCache = new WeakMap();
    const state = {
      lines: [],
      chars: 0,
      truncated: false,
      omittedFarBranches: 0,
      omittedHiddenBranches: 0,
      renderedTargetIds: new Set()
    };

    appendObservationLine(state, `Page ${quoteText(document.title || "Untitled", 120)}`);
    appendObservationLine(state, `URL ${location.href}`);
    appendObservationLine(state, getCoverageLine());

    const focusedId = getFocusedElementId(targetMap);
    if (focusedId) {
      appendObservationLine(state, `Focused [${focusedId}]`);
    }

    appendObservationLine(state, "");
    appendObservationLine(state, "Accessibility tree:");

    const root = document.body || document.documentElement;
    if (root) {
      walkObservationTree(root, 0);
    }

    if (state.omittedFarBranches > 0) {
      appendObservationLine(state, `... ${state.omittedFarBranches} offscreen branch(es) omitted; use scroll to inspect more.`);
    }
    if (state.omittedHiddenBranches > 0) {
      appendObservationLine(state, `... ${state.omittedHiddenBranches} hidden branch(es) omitted.`);
    }
    if (state.truncated) {
      appendObservationLine(state, "... observation budget reached; use scroll or a more specific goal to inspect more.");
    }

    const missingTargets = targets.filter((target) => !state.renderedTargetIds.has(target.id));
    if (missingTargets.length > 0 && appendObservationLine(state, "")) {
      appendObservationLine(state, "Additional action targets:");
      for (const target of missingTargets.slice(0, 40)) {
        appendObservationLine(state, formatTargetLine(target, 0));
      }
      if (missingTargets.length > 40) {
        appendObservationLine(state, `... ${missingTargets.length - 40} more target(s) omitted.`);
      }
    }

    return state.lines.join("\n");

    function walkObservationTree(element, depth) {
      if (!(element instanceof Element) || state.truncated) return;
      if (shouldSkipObservationElement(element)) return;

      if (!isElementVisibleForObservation(element)) {
        state.omittedHiddenBranches += 1;
        return;
      }

      const target = targetMap.get(element);
      const nearViewport = isNearViewport(element);
      const containsTarget = elementContainsTarget(element);
      const descendantTargetCount = countTargetDescendants(element);
      const axNode = describeAxLikeNode(element, target) || describeComponentContainerNode(element, {
        containsTarget,
        descendantTargetCount
      });

      if (!nearViewport && !target && !containsTarget && !isImportantSemanticNode(axNode)) {
        state.omittedFarBranches += 1;
        return;
      }

      const shouldPrint = Boolean(axNode) && (nearViewport || target || containsTarget || isImportantSemanticNode(axNode));
      let childDepth = depth;

      if (shouldPrint) {
        if (!appendObservationLine(state, formatAxLikeLine(axNode, depth))) return;
        childDepth = Math.min(depth + 1, 8);
        if (target) {
          state.renderedTargetIds.add(target.id);
        }
      }

      if (shouldPrint && target && CONTROL_ROLES.has(axNode.role) && axNode.name) {
        return;
      }

      for (const child of element.children) {
        walkObservationTree(child, childDepth);
        if (state.truncated) return;
      }
    }

    function elementContainsTarget(element) {
      if (containsTargetCache.has(element)) {
        return containsTargetCache.get(element);
      }
      const contains = targetElements.some((targetElement) => targetElement !== element && element.contains(targetElement));
      containsTargetCache.set(element, contains);
      return contains;
    }

    function countTargetDescendants(element) {
      if (targetCountCache.has(element)) {
        return targetCountCache.get(element);
      }
      const count = targetElements.reduce((total, targetElement) => {
        if (targetElement !== element && element.contains(targetElement)) {
          return total + 1;
        }
        return total;
      }, 0);
      targetCountCache.set(element, count);
      return count;
    }

    function countTargetBranches(element) {
      return Array.from(element.children).reduce((total, child) => {
        return total + (countTargetDescendants(child) > 0 || targetMap.has(child) ? 1 : 0);
      }, 0);
    }

    function describeComponentContainerNode(element, { containsTarget, descendantTargetCount }) {
      if (!containsTarget || descendantTargetCount === 0) return null;
      if (!shouldPreserveComponentContainer(element, descendantTargetCount)) return null;

      const name = getComponentContainerName(element);
      const attributes = getComponentContainerAttributes(element, descendantTargetCount);
      if (!name && attributes.length === 1 && countTargetBranches(element) < 2) {
        return null;
      }

      return {
        bid: "",
        role: "group",
        name,
        attributes
      };
    }

    function shouldPreserveComponentContainer(element, descendantTargetCount) {
      const tag = element.tagName.toLowerCase();
      if (tag === "html" || tag === "body") return false;
      if (COMPONENT_CONTAINER_TAGS.has(tag)) return true;
      if (getComponentContainerName(element)) return true;
      if (getComponentIdentityAttribute(element)) return true;
      return descendantTargetCount >= 2 && countTargetBranches(element) >= 2;
    }
  }

  function getCoverageLine() {
    const scrollY = Math.round(window.scrollY);
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const hasAbove = scrollY > 8;
    const hasBelow = scrollY < maxY - 8;
    const percent = maxY > 0 ? Math.round((scrollY / maxY) * 100) : 100;
    const coverage = [
      hasAbove ? "content above omitted" : "at top",
      hasBelow ? "content below omitted" : "at bottom"
    ].join("; ");

    return `Observation scope: partial viewport-centered page view; not the full page. Viewport ${window.innerWidth}x${window.innerHeight}; scrollY=${scrollY}/${maxY} (${percent}%). ${coverage}. Use scroll to inspect omitted regions.`;
  }

  function appendObservationLine(state, line) {
    const nextChars = state.chars + line.length + 1;
    if (state.lines.length >= OBSERVATION_MAX_LINES || nextChars > OBSERVATION_MAX_CHARS) {
      state.truncated = true;
      return false;
    }
    state.lines.push(line);
    state.chars = nextChars;
    return true;
  }

  function describeAxLikeNode(element, target) {
    const role = getAxLikeRole(element, target);
    if (!role) return null;

    const name = getAxLikeName(element, target, role);
    const attributes = getAxLikeAttributes(element, target, role);

    if (!target && !name && attributes.length === 0 && !isStructuralRole(role)) {
      return null;
    }

    if (!target && role === "generic") {
      return null;
    }

    return {
      bid: target?.id || "",
      role,
      name,
      attributes
    };
  }

  function getAxLikeRole(element, target) {
    if (target?.role) return target.role;

    const explicitRole = element.getAttribute("role");
    if (explicitRole) return explicitRole;

    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "p") return "paragraph";
    if (tag === "label") return "label";
    if (tag === "li") return "listitem";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "form") return "form";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "section") return element.getAttribute("aria-label") ? "region" : "";
    if (tag === "article") return "article";
    if (tag === "aside") return "complementary";
    if (tag === "dialog") return "dialog";
    if (tag === "details") return "group";
    if (tag === "table") return "table";
    if (tag === "tr") return "row";
    if (tag === "th") return element.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
    if (tag === "td") return "cell";
    if (tag === "img" && element.getAttribute("alt")) return "img";
    if (isTextCarrierElement(element)) return "StaticText";
    return "";
  }

  function getAxLikeName(element, target, role) {
    if (target) {
      return truncateText(target.label || target.placeholder || target.value || target.name || "", 180);
    }

    const ariaName = element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("alt");
    if (ariaName) return truncateText(ariaName, 180);

    if (TEXT_ROLES.has(role) || role === "img") {
      return truncateText(getReadableElementText(element), role === "StaticText" ? 220 : 260);
    }

    if (isStructuralRole(role)) {
      return truncateText(getDirectText(element), 100);
    }

    return "";
  }

  function getAxLikeAttributes(element, target, role) {
    const attributes = [];

    if (target) {
      if (!rectIntersectsViewport(element.getBoundingClientRect())) attributes.push("offscreen");
      if (!target.enabled) attributes.push("disabled");
      if (target.value) attributes.push(`value=${quoteText(target.value, 120)}`);
      if (target.placeholder) attributes.push(`placeholder=${quoteText(target.placeholder, 120)}`);
      if (target.checked !== undefined) attributes.push(`checked=${target.checked ? "true" : "false"}`);
      if (target.href) attributes.push(`href=${quoteText(target.href, 160)}`);
    }

    const tag = element.tagName.toLowerCase();
    if (role === "heading" && /^h[1-6]$/.test(tag)) {
      attributes.push(`level=${tag.slice(1)}`);
    }
    for (const ariaAttribute of ["aria-expanded", "aria-selected", "aria-current", "aria-pressed", "aria-invalid"]) {
      const value = element.getAttribute(ariaAttribute);
      if (value != null) attributes.push(`${ariaAttribute.slice(5)}=${quoteText(value, 40)}`);
    }
    if (element.hasAttribute("required")) attributes.push("required");
    return attributes;
  }

  function formatAxLikeLine(node, depth) {
    const prefix = "  ".repeat(depth);
    const bid = node.bid ? `[${node.bid}] ` : "";
    const name = node.name ? ` ${quoteText(node.name, 220)}` : "";
    const attributes = node.attributes.length ? ` ${node.attributes.join(" ")}` : "";
    return `${prefix}${bid}${node.role}${name}${attributes}`;
  }

  function formatTargetLine(target, depth) {
    const prefix = "  ".repeat(depth);
    const label = target.label || target.placeholder || target.value || target.name || "";
    const value = target.value ? ` value=${quoteText(target.value, 80)}` : "";
    const placeholder = target.placeholder ? ` placeholder=${quoteText(target.placeholder, 80)}` : "";
    return `${prefix}[${target.id}] ${target.role || target.tag} ${quoteText(label, 140)}${value}${placeholder}`;
  }

  function getComponentContainerName(element) {
    const explicitName = element.getAttribute("aria-label") || getAriaLabelledBy(element) || element.getAttribute("title");
    if (explicitName) return truncateText(explicitName, 160);

    const legend = element.querySelector(":scope > legend");
    if (legend) {
      const legendText = normalizeWhitespace(legend.innerText || legend.textContent || "");
      if (legendText) return truncateText(legendText, 160);
    }

    const heading = element.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > [role='heading']");
    if (heading) {
      const headingText = normalizeWhitespace(heading.innerText || heading.textContent || "");
      if (headingText) return truncateText(headingText, 160);
    }

    const directText = getDirectText(element);
    if (directText && directText.length <= 120) return directText;
    return "";
  }

  function getComponentContainerAttributes(element, descendantTargetCount) {
    const attributes = [`targets=${descendantTargetCount}`];
    const tag = element.tagName.toLowerCase();
    if (!["div", "span"].includes(tag)) {
      attributes.push(`tag=${tag}`);
    }

    const identity = getComponentIdentityAttribute(element);
    if (identity) {
      attributes.push(identity);
    }

    return attributes;
  }

  function getComponentIdentityAttribute(element) {
    for (const attribute of ["data-testid", "data-test", "data-qa"]) {
      const value = element.getAttribute(attribute);
      if (value && isUsefulIdentifier(value)) {
        return `${attribute}=${quoteText(value, 80)}`;
      }
    }

    if (element.id && isUsefulIdentifier(element.id)) {
      return `id=${quoteText(element.id, 80)}`;
    }

    const usefulClass = Array.from(element.classList || []).find(isUsefulIdentifier);
    if (usefulClass) {
      return `class=${quoteText(usefulClass, 80)}`;
    }

    return "";
  }

  function isUsefulIdentifier(value) {
    const text = String(value || "").trim();
    if (text.length < 3 || text.length > 80) return false;
    if (/^[a-f0-9]{8,}$/i.test(text)) return false;
    if (/^\d+$/.test(text)) return false;
    if (/^(css|sc|jss|chakra|mui|ant|v)-[a-z0-9]+$/i.test(text)) return false;
    if (GENERIC_IDENTIFIER_TOKENS.has(text.toLowerCase())) return false;
    return /[a-z]/i.test(text);
  }

  function isImportantSemanticNode(node) {
    return Boolean(node && ["heading", "form", "navigation", "main", "dialog", "table", "list", "region"].includes(node.role));
  }

  function isStructuralRole(role) {
    return ["form", "navigation", "main", "banner", "contentinfo", "article", "complementary", "dialog", "group", "table", "row", "list", "region"].includes(role);
  }

  function isTextCarrierElement(element) {
    const tag = element.tagName.toLowerCase();
    if (!["span", "div", "strong", "em", "small", "code", "pre"].includes(tag)) return false;
    if (element.children.length > 2) return false;
    return Boolean(getDirectText(element));
  }

  function getReadableElementText(element) {
    const directText = getDirectText(element);
    if (directText) return directText;
    return normalizeWhitespace(element.innerText || element.textContent || "");
  }

  function getDirectText(element) {
    const text = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.nodeValue || "")
      .join(" ");
    return normalizeWhitespace(text);
  }

  function shouldSkipObservationElement(element) {
    const tag = element.tagName.toLowerCase();
    if (TREE_EXCLUDED_TAGS.has(tag)) return true;
    if (element.id === "aat-agent-activity-overlay" || element.id === "aat-agent-activity-style") return true;
    if (element.closest("#aat-agent-activity-overlay")) return true;
    if (element.getAttribute("aria-hidden") === "true") return true;
    if (element.hidden) return true;
    return false;
  }

  function isElementVisibleForObservation(element) {
    if (element === document.body || element === document.documentElement) return true;

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      return Boolean(getDirectText(element));
    }
    return true;
  }

  function isNearViewport(element) {
    if (element === document.body || element === document.documentElement) return true;
    const rect = element.getBoundingClientRect();
    return rect.bottom >= -NEAR_VIEWPORT_MARGIN_TOP && rect.top <= window.innerHeight + NEAR_VIEWPORT_MARGIN_BOTTOM;
  }

  function getFocusedElementId(targetMap) {
    let element = document.activeElement;
    while (element && element instanceof Element) {
      const target = targetMap.get(element);
      if (target) return target.id;
      element = element.parentElement;
    }
    return "";
  }

  async function executeAction(action) {
    if (!action || typeof action !== "object") {
      throw new Error("Action must be an object.");
    }

    const type = String(action.type || "").toLowerCase();
    if (type === "wait") {
      const ms = clamp(action.ms, 0, 10000, 1000);
      await delay(ms);
      return { ok: true, message: `Waited ${ms}ms.` };
    }

    if (type === "scroll") {
      const amount = clamp(action.amount, 1, 5000, 700);
      const direction = String(action.direction || "down").toLowerCase();
      const dy = direction === "up" ? -amount : amount;
      window.scrollBy({ top: dy, behavior: "smooth" });
      await delay(350);
      return { ok: true, message: `Scrolled ${direction} ${amount}px.`, scrollY: Math.round(window.scrollY) };
    }

    if (type === "press_key") {
      const key = String(action.key || "Enter");
      dispatchKey(document.activeElement || document.body, key);
      return { ok: true, message: `Pressed ${key}.` };
    }

    const element = resolveElement(action);
    if (!element) {
      return { ok: false, error: "Target element was not found.", action };
    }

    if (!isElementUsable(element)) {
      return { ok: false, error: "Target element is not visible or is disabled.", label: getElementLabel(element) };
    }

    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await delay(250);
    highlightElement(element);

    if (type === "click") {
      element.focus({ preventScroll: true });
      dispatchPointerClick(element);
      return { ok: true, message: "Clicked target.", label: getElementLabel(element).slice(0, 160) };
    }

    if (type === "type") {
      const text = String(action.text ?? "");
      await setText(element, text, Boolean(action.clear));
      return {
        ok: true,
        message: `Typed ${text.length} character(s).`,
        label: getElementLabel(element).slice(0, 160)
      };
    }

    if (type === "select") {
      const value = String(action.value ?? "");
      if (!(element instanceof HTMLSelectElement)) {
        return { ok: false, error: "Target is not a select element." };
      }
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, message: `Selected ${value}.` };
    }

    return { ok: false, error: `Unsupported executable action: ${type}` };
  }

  function resolveElement(action) {
    if (action.elementId && elementCache.has(action.elementId)) {
      return elementCache.get(action.elementId);
    }

    if (action.selector) {
      try {
        const element = document.querySelector(action.selector);
        if (element) return element;
      } catch (_error) {
        return null;
      }
    }

    return null;
  }

  async function setText(element, text, shouldClear) {
    element.focus({ preventScroll: true });

    if (element.isContentEditable) {
      if (shouldClear) element.textContent = "";
      element.textContent = shouldClear ? text : `${element.textContent || ""}${text}`;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      await delay(100);
      return;
    }

    if (!("value" in element)) {
      throw new Error("Target element does not accept text input.");
    }

    const current = shouldClear ? "" : String(element.value || "");
    setNativeValue(element, `${current}${text}`);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(100);
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function dispatchPointerClick(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      view: window
    };

    for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const EventClass = eventName.startsWith("pointer") ? PointerEvent : MouseEvent;
      element.dispatchEvent(new EventClass(eventName, eventInit));
    }

    if (typeof element.click === "function") {
      element.click();
    }
  }

  function dispatchKey(target, key) {
    const eventInit = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  }

  function getElementLabel(element) {
    const parts = [
      element.getAttribute("aria-label"),
      getAriaLabelledBy(element),
      element.getAttribute("title"),
      getAssociatedLabel(element),
      getButtonLikeInputLabel(element),
      element.innerText,
      element.textContent,
      element.getAttribute("alt")
    ];
    return normalizeWhitespace(parts.find((part) => normalizeWhitespace(part || "")) || "");
  }

  function getAssociatedLabel(element) {
    if (!element.id) return "";
    const label = document.querySelector(`label[for="${cssStringEscape(element.id)}"]`);
    return label?.innerText || "";
  }

  function getAriaLabelledBy(element) {
    const ids = String(element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => id.trim())
      .filter(Boolean);
    if (!ids.length) return "";
    return ids
      .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "")
      .join(" ");
  }

  function getButtonLikeInputLabel(element) {
    if (!(element instanceof HTMLInputElement)) return "";
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (!["button", "submit", "reset"].includes(type)) return "";
    return element.value || "";
  }

  function getElementValue(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      if (element.type === "password") return "";
      return String(element.value || "");
    }
    return "";
  }

  function implicitRole(element) {
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["submit", "button", "reset"].includes(type)) return "button";
      return "textbox";
    }
    return "";
  }

  function isElementUsable(element) {
    if (!(element instanceof Element)) return false;
    if (isDisabled(element)) return false;

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    if (rect.bottom < -200 || rect.top > window.innerHeight + 2000) return false;
    return true;
  }

  function isDisabled(element) {
    return Boolean(
      element.disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      element.closest("[inert]")
    );
  }

  function rectIntersectsViewport(rect) {
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
  }

  function buildSelector(element) {
    if (element.id) return `#${cssEscape(element.id)}`;

    for (const attribute of ["data-testid", "data-test", "data-qa"]) {
      const value = element.getAttribute(attribute);
      if (value) {
        return `${element.tagName.toLowerCase()}[${attribute}="${cssStringEscape(value)}"]`;
      }
    }

    const path = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body && path.length < 4) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) break;
      const index = Array.from(parent.children).filter((child) => child.tagName === current.tagName).indexOf(current) + 1;
      path.unshift(`${tag}:nth-of-type(${index})`);
      current = parent;
    }
    return path.length ? path.join(" > ") : element.tagName.toLowerCase();
  }

  function highlightElement(element) {
    const rect = element.getBoundingClientRect();
    if (!highlightOverlay) {
      highlightOverlay = document.createElement("div");
      highlightOverlay.style.position = "fixed";
      highlightOverlay.style.pointerEvents = "none";
      highlightOverlay.style.zIndex = "2147483647";
      highlightOverlay.style.border = "2px solid #2563eb";
      highlightOverlay.style.background = "rgba(37, 99, 235, 0.12)";
      highlightOverlay.style.borderRadius = "4px";
      highlightOverlay.style.transition = "opacity 180ms ease";
      document.documentElement.appendChild(highlightOverlay);
    }

    highlightOverlay.style.left = `${Math.max(0, rect.left)}px`;
    highlightOverlay.style.top = `${Math.max(0, rect.top)}px`;
    highlightOverlay.style.width = `${Math.max(1, rect.width)}px`;
    highlightOverlay.style.height = `${Math.max(1, rect.height)}px`;
    highlightOverlay.style.opacity = "1";

    window.setTimeout(() => {
      if (highlightOverlay) highlightOverlay.style.opacity = "0";
    }, 900);
  }

  function notifyContentReady() {
    try {
      chrome.runtime.sendMessage({ type: "CONTENT_READY" }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      // The page automation still works if the readiness ping is unavailable.
    }
  }

  function setAgentActivity(active) {
    if (active) {
      showAgentActivityOverlay();
    } else {
      hideAgentActivityOverlay();
    }
  }

  function handleAgentEmergencyStopKey(event) {
    if (!isAgentActivityVisible()) return;
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key?.toLowerCase() !== "a" && event.code !== "KeyA") return;

    event.preventDefault();
    event.stopImmediatePropagation();
    hideAgentActivityOverlay();

    try {
      chrome.runtime.sendMessage({ type: "STOP_AGENT_FROM_PAGE" }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      // The local overlay has already been removed; the background may already be stopped.
    }
  }

  function isAgentActivityVisible() {
    return Boolean(activityOverlay?.isConnected || document.getElementById("aat-agent-activity-overlay"));
  }

  function showAgentActivityOverlay() {
    ensureAgentActivityStyle();

    if (!activityOverlay) {
      activityOverlay = document.createElement("div");
      activityOverlay.id = "aat-agent-activity-overlay";
      activityOverlay.setAttribute("aria-hidden", "true");
      activityOverlay.innerHTML = [
        '<div class="aat-agent-edge aat-agent-top"></div>',
        '<div class="aat-agent-edge aat-agent-right"></div>',
        '<div class="aat-agent-edge aat-agent-bottom"></div>',
        '<div class="aat-agent-edge aat-agent-left"></div>'
      ].join("");
    }

    if (!activityOverlay.isConnected) {
      document.documentElement.appendChild(activityOverlay);
    }
  }

  function hideAgentActivityOverlay() {
    if (activityOverlay?.isConnected) {
      activityOverlay.remove();
    }
    for (const overlay of document.querySelectorAll("#aat-agent-activity-overlay")) {
      overlay.remove();
    }
    activityOverlay = null;
  }

  function ensureAgentActivityStyle() {
    if (activityStyle?.isConnected || document.getElementById("aat-agent-activity-style")) {
      return;
    }

    activityStyle = document.createElement("style");
    activityStyle.id = "aat-agent-activity-style";
    activityStyle.textContent = `
      #aat-agent-activity-overlay {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 2147483646;
        contain: layout style paint;
      }

      #aat-agent-activity-overlay .aat-agent-edge {
        position: absolute;
        overflow: hidden;
        background: rgba(37, 99, 235, 0.10);
        box-shadow: 0 0 16px rgba(37, 99, 235, 0.35);
      }

      #aat-agent-activity-overlay .aat-agent-edge::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          repeating-linear-gradient(
            90deg,
            rgba(37, 99, 235, 0.95) 0 18px,
            rgba(96, 165, 250, 0.95) 18px 28px,
            rgba(255, 255, 255, 0.08) 28px 42px
          );
      }

      #aat-agent-activity-overlay .aat-agent-top,
      #aat-agent-activity-overlay .aat-agent-bottom {
        left: 0;
        right: 0;
        height: 7px;
      }

      #aat-agent-activity-overlay .aat-agent-top {
        top: 0;
      }

      #aat-agent-activity-overlay .aat-agent-bottom {
        bottom: 0;
      }

      #aat-agent-activity-overlay .aat-agent-left,
      #aat-agent-activity-overlay .aat-agent-right {
        top: 0;
        bottom: 0;
        width: 7px;
      }

      #aat-agent-activity-overlay .aat-agent-left {
        left: 0;
      }

      #aat-agent-activity-overlay .aat-agent-right {
        right: 0;
      }

      #aat-agent-activity-overlay .aat-agent-top::before {
        animation: aat-agent-marquee-x 900ms linear infinite;
      }

      #aat-agent-activity-overlay .aat-agent-bottom::before {
        animation: aat-agent-marquee-x 900ms linear infinite reverse;
      }

      #aat-agent-activity-overlay .aat-agent-left::before,
      #aat-agent-activity-overlay .aat-agent-right::before {
        background:
          repeating-linear-gradient(
            180deg,
            rgba(37, 99, 235, 0.95) 0 18px,
            rgba(96, 165, 250, 0.95) 18px 28px,
            rgba(255, 255, 255, 0.08) 28px 42px
          );
      }

      #aat-agent-activity-overlay .aat-agent-left::before {
        animation: aat-agent-marquee-y 900ms linear infinite reverse;
      }

      #aat-agent-activity-overlay .aat-agent-right::before {
        animation: aat-agent-marquee-y 900ms linear infinite;
      }

      @keyframes aat-agent-marquee-x {
        from { transform: translateX(-42px); }
        to { transform: translateX(0); }
      }

      @keyframes aat-agent-marquee-y {
        from { transform: translateY(-42px); }
        to { transform: translateY(0); }
      }
    `;

    (document.head || document.documentElement).appendChild(activityStyle);
  }

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function truncateText(value, maxLength) {
    const text = normalizeWhitespace(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
  }

  function quoteText(value, maxLength) {
    const text = truncateText(value, maxLength).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${text}"`;
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/["\\#.:,[\]>+~*^$|=]/g, "\\$&");
  }

  function cssStringEscape(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function clamp(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function getErrorMessage(error) {
    if (!error) return "Unknown error.";
    if (typeof error === "string") return error;
    return error.message || String(error);
  }
})();
