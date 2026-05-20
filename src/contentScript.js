(() => {
  if (window.__autoAgentTesterLoaded) return;
  window.__autoAgentTesterLoaded = true;

  const elementCache = new Map();
  let highlightOverlay;
  let activityOverlay;
  let activityStyle;

  const recordingState = {
    active: false,
    listeners: [],
    pendingInputs: new Map(),
    lastScrollAt: 0
  };
  const RECORDING_SCROLL_THROTTLE_MS = 1000;
  const RECORDING_SNAPSHOT_BRIEF_CHARS = 800;
  const RECORDING_SEMANTIC_KEYS = new Set([
    "Enter", "Tab", "Escape",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"
  ]);

  const MAX_ACTION_TARGETS = 220;
  const OBSERVATION_PARTIAL_MAX_CHARS = 20000;
  const OBSERVATION_PARTIAL_MAX_LINES = 360;
  const OBSERVATION_FULL_MAX_CHARS = 30000;
  const OBSERVATION_FULL_MAX_LINES = 520;
  const FULL_PAGE_OBSERVATION_MAX_HEIGHT = 7000;
  const FULL_PAGE_OBSERVATION_MAX_DOM_ELEMENTS = 1800;
  const EXPANDED_VIEWPORT_PAGES_ABOVE = 1.5;
  const EXPANDED_VIEWPORT_PAGES_BELOW = 3;
  const MIN_OBSERVATION_MARGIN_TOP = 1200;
  const MIN_OBSERVATION_MARGIN_BOTTOM = 2400;
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

    if (message?.type === "GET_PAGE_ARCHIVE_SNAPSHOT") {
      sendResponse(createPageArchiveSnapshot());
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

    if (message?.type === "START_RECORDING") {
      startRecording();
      sendResponse({ ok: true, active: recordingState.active });
      return false;
    }

    if (message?.type === "STOP_RECORDING") {
      stopRecording();
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "RECORDING_STATUS") {
      sendResponse({ active: recordingState.active });
      return false;
    }

    return false;
  });

  notifyContentReady();
  window.addEventListener("keydown", handleAgentEmergencyStopKey, true);

  function createSnapshot() {
    elementCache.clear();

    const scope = getSnapshotScope();
    const targetEntries = collectInteractiveElements(scope)
      .slice(0, MAX_ACTION_TARGETS)
      .map((element, index) => {
        const description = describeElement(element, `e${index + 1}`);
        return description ? { element, description } : null;
      })
      .filter(Boolean);
    const targetMap = new Map(targetEntries.map(({ element, description }) => [element, description]));
    const elements = targetEntries.map(({ description }) => description);
    const observationText = buildPageObservation(targetMap, elements, scope);

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
        maxY: scope.maxScrollY
      },
      observationScope: {
        mode: scope.mode,
        documentHeight: scope.documentHeight,
        documentElementCount: scope.documentElementCount,
        marginTop: scope.marginTop,
        marginBottom: scope.marginBottom,
        maxChars: scope.maxChars,
        maxLines: scope.maxLines
      },
      text: observationText,
      observationText,
      focusedElementId: getFocusedElementId(targetMap),
      elements
    };
  }

  function createPageArchiveSnapshot() {
    const capturedAt = new Date().toISOString();
    const resources = collectPageSnapshotResources();

    return {
      schema_version: "page-snapshot.v1",
      capture_type: "final_page_snapshot",
      captured_at: capturedAt,
      url: location.href,
      title: document.title,
      base_uri: document.baseURI,
      html: serializeCurrentDocument(),
      text: truncateText(document.body?.innerText || "", 50000),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      scroll: {
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY),
        max_y: getSnapshotScope().maxScrollY
      },
      document: {
        content_type: document.contentType || "text/html",
        character_set: document.characterSet || "",
        compat_mode: document.compatMode || "",
        ready_state: document.readyState || "",
        referrer: document.referrer || ""
      },
      resources
    };
  }

  function serializeCurrentDocument() {
    const doctype = document.doctype ? serializeDoctype(document.doctype) : "<!doctype html>";
    return `${doctype}\n${document.documentElement.outerHTML}`;
  }

  function serializeDoctype(doctype) {
    const publicId = doctype.publicId ? ` PUBLIC "${doctype.publicId}"` : "";
    const systemId = doctype.systemId
      ? (publicId ? ` "${doctype.systemId}"` : ` SYSTEM "${doctype.systemId}"`)
      : "";
    return `<!doctype ${doctype.name}${publicId}${systemId}>`;
  }

  function collectPageSnapshotResources() {
    const entries = [];
    const seen = new Set();

    const addResource = (rawUrl, meta = {}) => {
      const absoluteUrl = toAbsoluteUrl(rawUrl);
      if (!absoluteUrl) return;
      const key = `${meta.tag || ""}:${meta.attr || ""}:${absoluteUrl}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({
        id: `res_${String(entries.length + 1).padStart(4, "0")}`,
        url: absoluteUrl,
        original_value: String(rawUrl || ""),
        type: meta.type || inferResourceType(absoluteUrl, meta),
        tag: meta.tag || "",
        attr: meta.attr || "",
        rel: meta.rel || "",
        media: meta.media || "",
        as: meta.as || "",
        crossorigin: meta.crossorigin || "",
        integrity: meta.integrity || "",
        referrerpolicy: meta.referrerpolicy || "",
        downloadable: /^https?:\/\//i.test(absoluteUrl)
      });
    };

    document.querySelectorAll("link[href]").forEach((element) => {
      const rel = element.getAttribute("rel") || "";
      addResource(element.getAttribute("href"), {
        tag: "link",
        attr: "href",
        rel,
        media: element.getAttribute("media") || "",
        as: element.getAttribute("as") || "",
        crossorigin: element.getAttribute("crossorigin") || "",
        integrity: element.getAttribute("integrity") || "",
        referrerpolicy: element.getAttribute("referrerpolicy") || ""
      });
    });

    document.querySelectorAll("script[src]").forEach((element) => {
      addResource(element.getAttribute("src"), {
        tag: "script",
        attr: "src",
        type: "script",
        crossorigin: element.getAttribute("crossorigin") || "",
        integrity: element.getAttribute("integrity") || "",
        referrerpolicy: element.getAttribute("referrerpolicy") || ""
      });
    });

    document.querySelectorAll("img[src], image[href], image[xlink\\:href]").forEach((element) => {
      addResource(element.currentSrc || element.getAttribute("src") || element.getAttribute("href") || element.getAttribute("xlink:href"), {
        tag: element.tagName.toLowerCase(),
        attr: element.currentSrc ? "currentSrc" : "src",
        type: "image",
        crossorigin: element.getAttribute("crossorigin") || "",
        referrerpolicy: element.getAttribute("referrerpolicy") || ""
      });
      collectSrcsetUrls(element.getAttribute("srcset")).forEach((url) => addResource(url, {
        tag: element.tagName.toLowerCase(),
        attr: "srcset",
        type: "image"
      }));
    });

    document.querySelectorAll("source[src], source[srcset]").forEach((element) => {
      addResource(element.getAttribute("src"), {
        tag: "source",
        attr: "src",
        type: inferSourceElementType(element)
      });
      collectSrcsetUrls(element.getAttribute("srcset")).forEach((url) => addResource(url, {
        tag: "source",
        attr: "srcset",
        type: inferSourceElementType(element)
      }));
    });

    document.querySelectorAll("video[src], video[poster], audio[src], track[src], iframe[src], embed[src], object[data]").forEach((element) => {
      const tag = element.tagName.toLowerCase();
      if (element.getAttribute("src")) {
        addResource(element.getAttribute("src"), {
          tag,
          attr: "src",
          type: tag === "iframe" ? "frame" : tag
        });
      }
      if (element.getAttribute("poster")) {
        addResource(element.getAttribute("poster"), {
          tag,
          attr: "poster",
          type: "image"
        });
      }
      if (element.getAttribute("data")) {
        addResource(element.getAttribute("data"), {
          tag,
          attr: "data"
        });
      }
    });

    document.querySelectorAll("[style]").forEach((element) => {
      collectCssUrls(element.getAttribute("style")).forEach((url) => addResource(url, {
        tag: element.tagName.toLowerCase(),
        attr: "style",
        type: "style-resource"
      }));
    });

    document.querySelectorAll("style").forEach((element) => {
      collectCssUrls(element.textContent || "").forEach((url) => addResource(url, {
        tag: "style",
        attr: "textContent",
        type: "style-resource"
      }));
    });

    return entries;
  }

  function toAbsoluteUrl(value) {
    const text = String(value || "").trim();
    if (!text || /^(javascript|mailto|tel):/i.test(text)) return "";
    try {
      return new URL(text, document.baseURI).href;
    } catch (_error) {
      return text;
    }
  }

  function collectSrcsetUrls(srcset) {
    return String(srcset || "")
      .split(",")
      .map((candidate) => candidate.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  function collectCssUrls(cssText) {
    const urls = [];
    const pattern = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    let match;
    while ((match = pattern.exec(String(cssText || "")))) {
      if (match[2]) urls.push(match[2]);
    }
    return urls;
  }

  function inferSourceElementType(element) {
    const parent = element.parentElement?.tagName?.toLowerCase() || "";
    if (parent === "picture") return "image";
    if (parent === "video") return "video";
    if (parent === "audio") return "audio";
    return "source";
  }

  function inferResourceType(url, meta = {}) {
    const rel = String(meta.rel || "").toLowerCase();
    if (rel.includes("stylesheet")) return "stylesheet";
    if (rel.includes("icon")) return "icon";
    if (rel.includes("manifest")) return "manifest";
    if (rel.includes("preload") && meta.as) return String(meta.as);

    const pathname = (() => {
      try {
        return new URL(url).pathname.toLowerCase();
      } catch (_error) {
        return String(url || "").toLowerCase();
      }
    })();
    if (/\.(png|jpe?g|gif|webp|avif|svg|ico)$/.test(pathname)) return "image";
    if (/\.(css)$/.test(pathname)) return "stylesheet";
    if (/\.(m?js)$/.test(pathname)) return "script";
    if (/\.(woff2?|ttf|otf|eot)$/.test(pathname)) return "font";
    if (/\.(mp4|webm|mov|m4v)$/.test(pathname)) return "video";
    if (/\.(mp3|wav|ogg|m4a)$/.test(pathname)) return "audio";
    return "resource";
  }

  function getSnapshotScope() {
    const viewportHeight = Math.max(1, window.innerHeight || 1);
    const documentHeight = getDocumentHeight();
    const documentElementCount = document.body ? document.body.getElementsByTagName("*").length : 0;
    const maxScrollY = Math.max(0, documentHeight - viewportHeight);
    const fullPage = documentHeight <= FULL_PAGE_OBSERVATION_MAX_HEIGHT
      && documentElementCount <= FULL_PAGE_OBSERVATION_MAX_DOM_ELEMENTS;
    const marginTop = fullPage
      ? Math.max(documentHeight, window.scrollY)
      : Math.max(MIN_OBSERVATION_MARGIN_TOP, Math.round(viewportHeight * EXPANDED_VIEWPORT_PAGES_ABOVE));
    const marginBottom = fullPage
      ? documentHeight
      : Math.max(MIN_OBSERVATION_MARGIN_BOTTOM, Math.round(viewportHeight * EXPANDED_VIEWPORT_PAGES_BELOW));

    return {
      mode: fullPage ? "full" : "expanded",
      documentHeight,
      documentElementCount,
      maxScrollY,
      marginTop,
      marginBottom,
      maxChars: fullPage ? OBSERVATION_FULL_MAX_CHARS : OBSERVATION_PARTIAL_MAX_CHARS,
      maxLines: fullPage ? OBSERVATION_FULL_MAX_LINES : OBSERVATION_PARTIAL_MAX_LINES
    };
  }

  function getDocumentHeight() {
    const body = document.body;
    const element = document.documentElement;
    return Math.max(
      body?.scrollHeight || 0,
      body?.offsetHeight || 0,
      element?.clientHeight || 0,
      element?.scrollHeight || 0,
      element?.offsetHeight || 0,
      window.innerHeight || 0
    );
  }

  function collectInteractiveElements(scope) {
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

    const interactive = Array.from(document.querySelectorAll(selector));
    const interactiveSet = new Set(interactive);
    const scrollable = Array.from(document.querySelectorAll("body *")).filter(isScrollableElement);
    const all = Array.from(new Set([...interactive, ...scrollable]));
    const visible = all.filter((element) => isElementUsable(element) && isElementInSnapshotScope(element, scope));

    visible.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const aInView = rectIntersectsViewport(ar) ? 0 : 1;
      const bInView = rectIntersectsViewport(br) ? 0 : 1;
      if (aInView !== bInView) return aInView - bInView;
      const aInteractive = interactiveSet.has(a) ? 0 : 1;
      const bInteractive = interactiveSet.has(b) ? 0 : 1;
      if (aInteractive !== bInteractive) return aInteractive - bInteractive;
      if (Math.abs(ar.top - br.top) > 8) return ar.top - br.top;
      return ar.left - br.left;
    });

    return visible;
  }

  function describeElement(element, id) {
    const rect = element.getBoundingClientRect();
    const label = getElementLabel(element);
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || implicitRole(element) || (isScrollableElement(element) ? "scrollable" : "");
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

  function buildPageObservation(targetMap, targets, scope) {
    const targetElements = Array.from(targetMap.keys());
    const containsTargetCache = new WeakMap();
    const targetCountCache = new WeakMap();
    const state = {
      lines: [],
      chars: 0,
      truncated: false,
      omittedFarBranches: 0,
      omittedHiddenBranches: 0,
      renderedTargetIds: new Set(),
      maxChars: scope.maxChars,
      maxLines: scope.maxLines
    };

    appendObservationLine(state, `Page ${quoteText(document.title || "Untitled", 120)}`);
    appendObservationLine(state, `URL ${location.href}`);
    appendObservationLine(state, getCoverageLine(scope));

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
      const nearViewport = isElementInSnapshotScope(element, scope);
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

  function getCoverageLine(scope) {
    const scrollY = Math.round(window.scrollY);
    const maxY = scope.maxScrollY;
    const hasAbove = scrollY > 8;
    const hasBelow = scrollY < maxY - 8;
    const percent = maxY > 0 ? Math.round((scrollY / maxY) * 100) : 100;

    if (scope.mode === "full") {
      return `Observation scope: full-page DOM view because the page is short enough. Viewport ${window.innerWidth}x${window.innerHeight}; documentHeight=${scope.documentHeight}; DOM elements=${scope.documentElementCount}; scrollY=${scrollY}/${maxY} (${percent}%).`;
    }

    const coverage = [
      hasAbove ? `content more than ${scope.marginTop}px above omitted` : "at top",
      hasBelow ? `content more than ${scope.marginBottom}px below omitted` : "at bottom"
    ].join("; ");

    return `Observation scope: expanded viewport-centered DOM view, not the full page. Viewport ${window.innerWidth}x${window.innerHeight}; documentHeight=${scope.documentHeight}; DOM elements=${scope.documentElementCount}; scrollY=${scrollY}/${maxY} (${percent}%). ${coverage}. Use scroll to inspect omitted regions.`;
  }

  function appendObservationLine(state, line) {
    const nextChars = state.chars + line.length + 1;
    if (state.lines.length >= state.maxLines || nextChars > state.maxChars) {
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

  function isElementInSnapshotScope(element, scope) {
    if (element === document.body || element === document.documentElement) return true;
    if (scope.mode === "full") return true;
    const rect = element.getBoundingClientRect();
    return rect.bottom >= -scope.marginTop && rect.top <= window.innerHeight + scope.marginBottom;
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
      return scrollTarget(action);
    }

    if (type === "press_key") {
      const key = String(action.key || "Enter");
      const modifiers = getKeyModifiers(action);
      let target = document.activeElement || document.body;
      if (hasExplicitTarget(action)) {
        target = resolveElement(action);
        if (!target) {
          return { ok: false, error: "Target element was not found.", action };
        }
        if (!isElementUsable(target)) {
          return { ok: false, error: "Target element is not visible or is disabled.", label: getElementLabel(target) };
        }
        target.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
        await delay(250);
        focusElement(target);
      }
      dispatchKey(target, key, modifiers);
      applySyntheticKeyDefault(target, key, modifiers);
      return { ok: true, message: `Pressed ${formatKeyPress(key, modifiers)}.` };
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

    if (type === "focus") {
      focusElement(element);
      return { ok: true, message: "Focused target.", label: getElementLabel(element).slice(0, 160) };
    }

    if (type === "hover") {
      dispatchPointerHover(element);
      return { ok: true, message: "Hovered target.", label: getElementLabel(element).slice(0, 160) };
    }

    if (type === "click") {
      focusElement(element);
      dispatchPointerClick(element);
      return { ok: true, message: "Clicked target.", label: getElementLabel(element).slice(0, 160) };
    }

    if (type === "double_click") {
      focusElement(element);
      dispatchPointerClick(element);
      await delay(80);
      dispatchPointerClick(element);
      dispatchDoubleClick(element);
      return { ok: true, message: "Double-clicked target.", label: getElementLabel(element).slice(0, 160) };
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

    if (type === "clear") {
      await clearElementValue(element);
      return {
        ok: true,
        message: "Cleared target.",
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

    if (type === "set_checked") {
      const checked = Boolean(action.checked);
      const result = await setElementChecked(element, checked);
      return {
        ok: true,
        message: result.changed ? `Set checked=${checked}.` : `Already checked=${checked}.`,
        label: getElementLabel(element).slice(0, 160)
      };
    }

    if (type === "drag") {
      const deltaX = clamp(action.deltaX, -5000, 5000, 0);
      const deltaY = clamp(action.deltaY, -5000, 5000, 0);
      const steps = clamp(action.steps, 1, 30, 10);
      await dragElement(element, deltaX, deltaY, steps);
      return {
        ok: true,
        message: `Dragged target by ${deltaX},${deltaY}.`,
        label: getElementLabel(element).slice(0, 160)
      };
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

  async function scrollTarget(action) {
    const amount = clamp(action.amount, 1, 5000, 700);
    const direction = String(action.direction || "down").toLowerCase();
    const horizontal = direction === "left" || direction === "right";
    const delta = direction === "up" || direction === "left" ? -amount : amount;
    const scrollOptions = {
      top: horizontal ? 0 : delta,
      left: horizontal ? delta : 0,
      behavior: "smooth"
    };

    if (hasExplicitTarget(action)) {
      const element = resolveElement(action);
      if (!element) {
        return { ok: false, error: "Target element was not found.", action };
      }
      if (!isElementUsable(element)) {
        return { ok: false, error: "Target element is not visible or is disabled.", label: getElementLabel(element) };
      }
      element.scrollBy(scrollOptions);
      await delay(350);
      return {
        ok: true,
        message: `Scrolled target ${direction} ${amount}px.`,
        scrollTop: Math.round(element.scrollTop),
        scrollLeft: Math.round(element.scrollLeft)
      };
    }

    window.scrollBy(scrollOptions);
    await delay(350);
    return {
      ok: true,
      message: `Scrolled page ${direction} ${amount}px.`,
      scrollY: Math.round(window.scrollY),
      scrollX: Math.round(window.scrollX)
    };
  }

  function hasExplicitTarget(action) {
    return Boolean(action?.elementId || action?.selector);
  }

  function focusElement(element) {
    if (!isFocusable(element) && !element.hasAttribute("tabindex")) {
      element.setAttribute("tabindex", "-1");
    }
    if (typeof element.focus === "function") {
      element.focus({ preventScroll: true });
    }
  }

  function isFocusable(element) {
    if (!(element instanceof Element)) return false;
    const tag = element.tagName.toLowerCase();
    if (["button", "input", "select", "textarea", "summary"].includes(tag)) return true;
    if (tag === "a" && element.hasAttribute("href")) return true;
    if (element.isContentEditable) return true;
    const tabIndex = element.getAttribute("tabindex");
    return tabIndex != null && Number.parseInt(tabIndex, 10) >= 0;
  }

  async function setText(element, text, shouldClear) {
    focusElement(element);

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

  async function clearElementValue(element) {
    focusElement(element);

    if (element.isContentEditable) {
      element.textContent = "";
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      await delay(100);
      return;
    }

    if (element instanceof HTMLSelectElement) {
      element.value = "";
      element.selectedIndex = -1;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      await delay(100);
      return;
    }

    if (!("value" in element)) {
      throw new Error("Target element does not accept text input.");
    }

    setNativeValue(element, "");
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
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

  async function setElementChecked(element, checked) {
    focusElement(element);

    if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes((element.type || "").toLowerCase())) {
      const changed = element.checked !== checked;
      if (changed) {
        setNativeChecked(element, checked);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await delay(100);
      return { changed };
    }

    const role = (element.getAttribute("role") || "").toLowerCase();
    if (["checkbox", "radio", "switch"].includes(role) || element.hasAttribute("aria-checked")) {
      const current = element.getAttribute("aria-checked") === "true";
      const changed = current !== checked;
      if (changed) {
        dispatchPointerClick(element);
        await delay(100);
        if (element.getAttribute("aria-checked") === String(current)) {
          element.setAttribute("aria-checked", checked ? "true" : "false");
        }
      }
      return { changed };
    }

    throw new Error("Target is not a checkbox, radio button, or switch.");
  }

  function setNativeChecked(element, checked) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "checked");
    if (descriptor?.set) {
      descriptor.set.call(element, checked);
    } else {
      element.checked = checked;
    }
  }

  async function dragElement(element, deltaX, deltaY, steps) {
    focusElement(element);

    if (adjustRangeInputByDelta(element, deltaX, deltaY)) {
      await delay(100);
      return;
    }

    const rect = element.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;
    const endX = startX + deltaX;
    const endY = startY + deltaY;

    dispatchPointerMouseEvent(element, "pointerdown", startX, startY, { buttons: 1, button: 0 });
    dispatchPointerMouseEvent(element, "mousedown", startX, startY, { buttons: 1, button: 0 });

    for (let step = 1; step <= steps; step += 1) {
      const x = startX + (deltaX * step) / steps;
      const y = startY + (deltaY * step) / steps;
      const target = document.elementFromPoint(x, y) || element;
      dispatchPointerMouseEvent(target, "pointermove", x, y, { buttons: 1, button: 0 });
      dispatchPointerMouseEvent(target, "mousemove", x, y, { buttons: 1, button: 0 });
      await delay(16);
    }

    const dropTarget = document.elementFromPoint(endX, endY) || element;
    dispatchPointerMouseEvent(dropTarget, "pointerup", endX, endY, { buttons: 0, button: 0 });
    dispatchPointerMouseEvent(dropTarget, "mouseup", endX, endY, { buttons: 0, button: 0 });
    await delay(100);
  }

  function adjustRangeInputByDelta(element, deltaX, deltaY) {
    if (!(element instanceof HTMLInputElement) || (element.type || "").toLowerCase() !== "range") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const min = Number.parseFloat(element.min || "0");
    const max = Number.parseFloat(element.max || "100");
    const current = Number.parseFloat(element.value || String(min));
    const stepValue = element.step && element.step !== "any" ? Number.parseFloat(element.step) : 0;
    const horizontal = Math.abs(deltaX) >= Math.abs(deltaY);
    const ratio = horizontal
      ? deltaX / Math.max(1, rect.width)
      : -deltaY / Math.max(1, rect.height);
    const raw = current + (max - min) * ratio;
    let next = Math.min(max, Math.max(min, raw));

    if (Number.isFinite(stepValue) && stepValue > 0) {
      next = min + Math.round((next - min) / stepValue) * stepValue;
      next = Math.min(max, Math.max(min, next));
    }

    setNativeValue(element, String(trimNumericValue(next)));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function trimNumericValue(value) {
    return Number.parseFloat(Number(value).toFixed(6));
  }

  function dispatchPointerClick(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      dispatchPointerMouseEvent(element, eventName, x, y, {
        buttons: eventName.endsWith("down") ? 1 : 0,
        button: 0
      });
    }

    if (typeof element.click === "function") {
      element.click();
    }
  }

  function dispatchPointerHover(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    for (const eventName of ["pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove"]) {
      dispatchPointerMouseEvent(element, eventName, x, y);
    }
  }

  function dispatchDoubleClick(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    dispatchPointerMouseEvent(element, "dblclick", x, y, { detail: 2 });
  }

  function dispatchPointerMouseEvent(target, eventName, x, y, extra = {}) {
    const eventInit = {
      bubbles: !["pointerenter", "mouseenter"].includes(eventName),
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y,
      view: window,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      ...extra
    };

    if (eventName.startsWith("pointer") && typeof PointerEvent === "function") {
      target.dispatchEvent(new PointerEvent(eventName, eventInit));
      return;
    }

    target.dispatchEvent(new MouseEvent(eventName, eventInit));
  }

  function dispatchKey(target, key, modifiers = {}) {
    const eventInit = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
      composed: true,
      shiftKey: Boolean(modifiers.shift),
      ctrlKey: Boolean(modifiers.ctrl),
      altKey: Boolean(modifiers.alt),
      metaKey: Boolean(modifiers.meta)
    };
    target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  }

  function applySyntheticKeyDefault(target, key, modifiers) {
    if (modifiers.ctrl || modifiers.alt || modifiers.meta) return;

    const normalizedKey = String(key || "").toLowerCase();
    if (normalizedKey === "tab") {
      focusAdjacentElement(Boolean(modifiers.shift));
      return;
    }

    if (normalizedKey === "enter") {
      if (target instanceof HTMLTextAreaElement) return;
      if (isActivatableElement(target)) {
        dispatchPointerClick(target);
        return;
      }
      const form = target instanceof HTMLElement ? target.form : null;
      if (form && typeof form.requestSubmit === "function") {
        form.requestSubmit();
      }
      return;
    }

    if (normalizedKey === " " || normalizedKey === "space" || normalizedKey === "spacebar") {
      if (isActivatableElement(target)) {
        dispatchPointerClick(target);
      }
    }
  }

  function focusAdjacentElement(backward) {
    const candidates = Array.from(document.querySelectorAll([
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "summary",
      "[contenteditable='true']",
      "[tabindex]:not([tabindex='-1'])"
    ].join(","))).filter(isElementUsable);
    if (!candidates.length) return;

    const activeIndex = candidates.indexOf(document.activeElement);
    const currentIndex = activeIndex === -1 ? (backward ? 0 : -1) : activeIndex;
    const nextIndex = backward
      ? (currentIndex - 1 + candidates.length) % candidates.length
      : (currentIndex + 1) % candidates.length;
    focusElement(candidates[nextIndex]);
  }

  function isActivatableElement(element) {
    if (!(element instanceof Element)) return false;
    const tag = element.tagName.toLowerCase();
    const role = (element.getAttribute("role") || "").toLowerCase();
    if (["button", "summary"].includes(tag)) return true;
    if (tag === "a" && element.hasAttribute("href")) return true;
    if (element instanceof HTMLInputElement && ["button", "submit", "reset", "checkbox", "radio"].includes((element.type || "").toLowerCase())) return true;
    return ["button", "link", "menuitem", "option", "checkbox", "radio", "switch", "tab"].includes(role);
  }

  function getKeyModifiers(action) {
    return {
      shift: Boolean(action.shift),
      ctrl: Boolean(action.ctrl),
      alt: Boolean(action.alt),
      meta: Boolean(action.meta)
    };
  }

  function formatKeyPress(key, modifiers) {
    return [
      modifiers.ctrl ? "Ctrl" : "",
      modifiers.alt ? "Alt" : "",
      modifiers.shift ? "Shift" : "",
      modifiers.meta ? "Meta" : "",
      key
    ].filter(Boolean).join("+");
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
    return true;
  }

  function isScrollableElement(element) {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY;
    const overflowX = style.overflowX;
    const canScrollY = ["auto", "scroll", "overlay"].includes(overflowY) && element.scrollHeight > element.clientHeight + 4;
    const canScrollX = ["auto", "scroll", "overlay"].includes(overflowX) && element.scrollWidth > element.clientWidth + 4;
    return canScrollY || canScrollX;
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

  function startRecording() {
    if (recordingState.active) return;
    recordingState.active = true;
    recordingState.pendingInputs.clear();
    recordingState.lastScrollAt = 0;

    const addListener = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      recordingState.listeners.push({ target, type, handler, options });
    };

    addListener(document, "click", handleRecordedClick, true);
    addListener(document, "change", handleRecordedChange, true);
    addListener(document, "input", handleRecordedInput, true);
    addListener(document, "focusout", handleRecordedFocusOut, true);
    addListener(document, "submit", handleRecordedSubmit, true);
    addListener(document, "keydown", handleRecordedKeydown, true);
    addListener(window, "scroll", handleRecordedScroll, { capture: true, passive: true });
  }

  function stopRecording() {
    if (!recordingState.active) return;
    flushPendingInputs();
    for (const { target, type, handler, options } of recordingState.listeners) {
      target.removeEventListener(type, handler, options);
    }
    recordingState.listeners = [];
    recordingState.pendingInputs.clear();
    recordingState.active = false;
  }

  function handleRecordedClick(event) {
    if (!recordingState.active) return;
    flushPendingInputs();
    const target = describeRecordingTarget(event.target);
    if (!target) return;
    emitRecordingEvent({ type: "click", target });
  }

  function handleRecordedChange(event) {
    if (!recordingState.active) return;
    const element = event.target;
    if (!(element instanceof Element)) return;
    if (isTextLikeInput(element)) {
      return;
    }
    const target = describeRecordingTarget(element);
    if (!target) return;
    emitRecordingEvent({
      type: "change",
      target,
      value: getElementValue(element).slice(0, 240),
      checked: "checked" in element ? Boolean(element.checked) : undefined
    });
  }

  function handleRecordedInput(event) {
    if (!recordingState.active) return;
    const element = event.target;
    if (!isTextLikeInput(element)) return;
    if (element instanceof HTMLInputElement && element.type === "password") return;
    if (!recordingState.pendingInputs.has(element)) {
      recordingState.pendingInputs.set(element, { lastEmittedValue: undefined });
    }
  }

  function handleRecordedFocusOut(event) {
    if (!recordingState.active) return;
    flushInputFor(event.target);
  }

  function flushInputFor(element) {
    if (!(element instanceof Element)) return;
    const entry = recordingState.pendingInputs.get(element);
    if (!entry) return;
    const currentValue = getElementValue(element);
    if (currentValue === entry.lastEmittedValue) return;
    entry.lastEmittedValue = currentValue;
    const target = describeRecordingTarget(element);
    if (!target) return;
    emitRecordingEvent({
      type: "input",
      target,
      value: currentValue.slice(0, 240)
    });
  }

  function flushPendingInputs() {
    const elements = Array.from(recordingState.pendingInputs.keys());
    for (const element of elements) flushInputFor(element);
  }

  function handleRecordedSubmit(event) {
    if (!recordingState.active) return;
    flushPendingInputs();
    const target = describeRecordingTarget(event.target);
    if (!target) return;
    emitRecordingEvent({ type: "submit", target });
  }

  function handleRecordedKeydown(event) {
    if (!recordingState.active) return;
    if (!RECORDING_SEMANTIC_KEYS.has(event.key)) return;
    flushPendingInputs();
    const target = describeRecordingTarget(event.target);
    emitRecordingEvent({
      type: "keydown",
      key: event.key,
      modifiers: {
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
        alt: event.altKey
      },
      target
    });
  }

  function isTextLikeInput(element) {
    if (element instanceof HTMLTextAreaElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    const type = (element.getAttribute("type") || "text").toLowerCase();
    return ["text", "search", "email", "url", "tel", "password", "number"].includes(type);
  }

  function handleRecordedScroll() {
    if (!recordingState.active) return;
    const now = Date.now();
    if (now - recordingState.lastScrollAt < RECORDING_SCROLL_THROTTLE_MS) return;
    recordingState.lastScrollAt = now;
    emitRecordingEvent({
      type: "scroll",
      scroll: {
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY)
      }
    });
  }

  function describeRecordingTarget(element) {
    if (!(element instanceof Element)) return null;
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || implicitRole(element) || "";
    const label = (getElementLabel(element) || "").slice(0, 200);
    const value = getElementValue(element).slice(0, 200);
    const placeholder = (element.getAttribute("placeholder") || "").slice(0, 120);
    const name = (element.getAttribute("name") || "").slice(0, 120);
    let selector = "";
    try {
      selector = buildSelector(element);
    } catch (_error) {
      selector = "";
    }
    return {
      tag,
      role,
      label,
      value,
      placeholder,
      name,
      selector,
      href: tag === "a" ? (element.href || "").slice(0, 240) : ""
    };
  }

  function emitRecordingEvent(payload) {
    const event = {
      ...payload,
      url: location.href,
      title: document.title,
      ts: new Date().toISOString(),
      snapshotBrief: captureBriefSnapshot()
    };
    try {
      chrome.runtime.sendMessage({ type: "RECORDING_EVENT", event }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      // Ignore — the background may be unavailable mid-navigation.
    }
  }

  function captureBriefSnapshot() {
    try {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      return {
        url: location.href,
        title: document.title,
        textBrief: text.slice(0, RECORDING_SNAPSHOT_BRIEF_CHARS)
      };
    } catch (_error) {
      return { url: location.href, title: document.title, textBrief: "" };
    }
  }
})();
