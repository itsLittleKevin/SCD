import { scenes } from "./scenes.js";
import { mdiTranslate } from "@mdi/js";

const frame = document.getElementById("appFrame");
const resetBtn = document.getElementById("resetBtn");
const langBtn = document.getElementById("langBtn");
const HOLD_MS = 5000;
const INTERVAL_MS = 1600;

let currentIndex = 0;
let isPlaying = false;
let stopRequested = false;
let currentSceneStep = 1;
let currentSceneTotal = scenes.length;
let autoStartArmed = true;
let guideLanguage = "zh";
let activeHighlight = null;

const guideCopyMap = {
  zh: {
    step: "步骤",
    prev: "上一条",
    next: "下一条",
    skip: "跳过导览",
    skipped: "已跳过导览",
  },
  en: {
    step: "Step",
    prev: "Previous",
    next: "Next",
    skip: "Skip",
    skipped: "Guide skipped",
  },
};

const normalizeGuideLanguage = (lang) => (lang === "en" ? "en" : "zh");
const setGuideLanguage = (lang) => {
  guideLanguage = normalizeGuideLanguage(lang);
};
const getGuideLanguage = () => guideLanguage;
const getGuideCopy = () => guideCopyMap[getGuideLanguage()];

const resolveGuideTip = (tipText) => {
  if (typeof tipText === "string") {
    return tipText;
  }
  if (tipText && typeof tipText === "object") {
    return getGuideLanguage() === "en" ? (tipText.en ?? "") : (tipText.zh ?? "");
  }
  return "";
};

const log = (message) => {
  console.info(`[demo] ${message}`);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntilContinue = async (ms) => {
  let elapsed = 0;
  while (elapsed < ms && !stopRequested) {
    const chunk = Math.min(120, ms - elapsed);
    await wait(chunk);
    elapsed += chunk;
  }
};

const getAppDoc = () => {
  const doc = frame?.contentDocument ?? null;
  if (!doc) {
    throw new Error("iframe 文档不可访问，请确保同源部署。");
  }
  return doc;
};

const waitForAppReady = async () => {
  for (let i = 0; i < 60; i += 1) {
    const doc = getAppDoc();
    const root = doc.querySelector("#root");
    if (root && root.textContent && root.textContent.length > 30) {
      return;
    }
    await wait(200);
  }
  throw new Error("应用加载超时");
};

const refreshLanguageButton = () => {
  if (!langBtn) return;
  const label = getGuideLanguage() === "zh" ? "语言：简中" : "Language: English";
  langBtn.setAttribute("aria-label", label);
  langBtn.innerHTML = `<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\"><path d=\"${mdiTranslate}\"></path></svg><span>${label}</span>`;
};

const selectLanguage = async (value) => {
  const doc = getAppDoc();
  const selects = Array.from(doc.querySelectorAll("select"));
  const target = selects.find((select) => {
    const values = Array.from(select.options).map((option) => option.value);
    return values.includes("zh") && values.includes("en");
  });

  if (!target) {
    throw new Error("未找到语言切换下拉框");
  }

  const next = normalizeGuideLanguage(value);
  target.value = next;
  target.dispatchEvent(new Event("change", { bubbles: true }));
};

const clearHighlight = async (keepActive = false) => {
  const doc = getAppDoc();
  doc.querySelectorAll("[data-demo-highlight='1']").forEach((node) => {
    node.removeAttribute("data-demo-highlight");
    node.style.outline = "";
    node.style.outlineOffset = "";
    node.style.boxShadow = "";
    node.style.borderRadius = "";
    node.style.position = "";
    node.style.zIndex = "";
  });
  const bubble = doc.getElementById("demo-coach-bubble");
  if (bubble) {
    bubble.remove();
  }
  if (!keepActive) {
    activeHighlight = null;
  }
};

const renderActiveHighlight = async () => {
  if (!activeHighlight) {
    return;
  }

  const { selector, tipText } = activeHighlight;
  const resolvedTipText = resolveGuideTip(tipText);

  await clearHighlight(true);
  const doc = getAppDoc();
  const el = doc.querySelector(selector);
  if (!el) return;

  const win = doc.defaultView;
  if (!win) {
    return;
  }

  const rect = el.getBoundingClientRect();
  el.setAttribute("data-demo-highlight", "1");
  el.style.outline = "2px solid #8fdfff";
  el.style.outlineOffset = "2px";
  el.style.boxShadow = "0 0 0 9999px rgba(8, 12, 20, 0.62)";
  el.style.borderRadius = "10px";
  el.style.position = "relative";
  el.style.zIndex = "2147483600";

  if (!resolvedTipText) {
    return;
  }

  const bubble = doc.createElement("div");
  bubble.id = "demo-coach-bubble";
  bubble.style.position = "fixed";
  bubble.style.maxWidth = "360px";
  bubble.style.minWidth = "250px";
  bubble.style.padding = "10px 12px 12px";
  bubble.style.borderRadius = "14px";
  bubble.style.background = "rgba(9, 19, 33, 0.98)";
  bubble.style.color = "#eaf1ff";
  bubble.style.border = "1px solid rgba(119, 214, 255, 0.5)";
  bubble.style.boxShadow = "0 16px 36px rgba(0, 0, 0, 0.42)";
  bubble.style.font = "13px/1.5 'Segoe UI', sans-serif";
  bubble.style.zIndex = "2147483647";
  bubble.style.visibility = "hidden";

  const head = doc.createElement("div");
  head.style.display = "flex";
  head.style.alignItems = "center";
  head.style.justifyContent = "space-between";
  head.style.gap = "10px";
  head.style.marginBottom = "8px";

  const copy = getGuideCopy();

  const stepBadge = doc.createElement("span");
  stepBadge.textContent = `${copy.step} ${currentSceneStep}/${currentSceneTotal}`;
  stepBadge.style.display = "inline-flex";
  stepBadge.style.alignItems = "center";
  stepBadge.style.height = "22px";
  stepBadge.style.padding = "0 10px";
  stepBadge.style.borderRadius = "999px";
  stepBadge.style.background = "rgba(119, 214, 255, 0.18)";
  stepBadge.style.border = "1px solid rgba(119, 214, 255, 0.45)";
  stepBadge.style.fontSize = "12px";

  const skipBtn = doc.createElement("button");
  skipBtn.type = "button";
  skipBtn.textContent = copy.skip;
  skipBtn.style.border = "1px solid rgba(136, 161, 196, 0.46)";
  skipBtn.style.background = "rgba(255, 255, 255, 0.03)";
  skipBtn.style.color = "#d7e6ff";
  skipBtn.style.borderRadius = "999px";
  skipBtn.style.padding = "2px 9px";
  skipBtn.style.fontSize = "12px";
  skipBtn.style.cursor = "pointer";
  skipBtn.addEventListener("click", () => {
    stopRequested = true;
    isPlaying = false;
    setStatus(copy.skipped);
    log("用户跳过导览");
    void clearHighlight();
  });

  const controls = doc.createElement("div");
  controls.style.display = "inline-flex";
  controls.style.alignItems = "center";
  controls.style.gap = "6px";

  const prevGuideBtn = doc.createElement("button");
  prevGuideBtn.type = "button";
  prevGuideBtn.textContent = copy.prev;
  prevGuideBtn.style.border = "1px solid rgba(136, 161, 196, 0.46)";
  prevGuideBtn.style.background = "rgba(255, 255, 255, 0.03)";
  prevGuideBtn.style.color = "#d7e6ff";
  prevGuideBtn.style.borderRadius = "999px";
  prevGuideBtn.style.padding = "2px 9px";
  prevGuideBtn.style.fontSize = "12px";
  prevGuideBtn.style.cursor = "pointer";
  prevGuideBtn.addEventListener("click", () => {
    stopRequested = true;
    void jumpToScene(currentIndex - 1);
  });

  const nextGuideBtn = doc.createElement("button");
  nextGuideBtn.type = "button";
  nextGuideBtn.textContent = copy.next;
  nextGuideBtn.style.border = "1px solid rgba(136, 161, 196, 0.46)";
  nextGuideBtn.style.background = "rgba(255, 255, 255, 0.03)";
  nextGuideBtn.style.color = "#d7e6ff";
  nextGuideBtn.style.borderRadius = "999px";
  nextGuideBtn.style.padding = "2px 9px";
  nextGuideBtn.style.fontSize = "12px";
  nextGuideBtn.style.cursor = "pointer";
  nextGuideBtn.addEventListener("click", () => {
    stopRequested = true;
    void jumpToScene(currentIndex + 1);
  });

  controls.appendChild(prevGuideBtn);
  controls.appendChild(nextGuideBtn);
  controls.appendChild(skipBtn);

  head.appendChild(stepBadge);
  head.appendChild(controls);

  const body = doc.createElement("div");
  body.textContent = resolvedTipText;
  body.style.whiteSpace = "normal";
  body.style.overflowWrap = "anywhere";

  const arrow = doc.createElement("span");
  arrow.style.position = "absolute";
  arrow.style.width = "12px";
  arrow.style.height = "12px";
  arrow.style.background = "rgba(9, 19, 33, 0.98)";
  arrow.style.border = "1px solid rgba(119, 214, 255, 0.4)";
  arrow.style.transform = "rotate(45deg)";

  bubble.appendChild(head);
  bubble.appendChild(body);
  bubble.appendChild(arrow);
  doc.body.appendChild(bubble);

  const bubbleRect = bubble.getBoundingClientRect();
  const gap = 14;
  const canPlaceRight = rect.right + gap + bubbleRect.width <= win.innerWidth - 12;
  const canPlaceLeft = rect.left - gap - bubbleRect.width >= 12;
  const placeRight = canPlaceRight || (!canPlaceLeft && rect.left < win.innerWidth / 2);

  const left = placeRight
    ? Math.min(win.innerWidth - bubbleRect.width - 12, rect.right + gap)
    : Math.max(12, rect.left - bubbleRect.width - gap);
  const top = Math.min(
    Math.max(12, rect.top + rect.height / 2 - bubbleRect.height / 2),
    win.innerHeight - bubbleRect.height - 12,
  );

  const arrowTop = Math.max(12, Math.min(bubbleRect.height - 24, rect.top + rect.height / 2 - top - 6));
  arrow.style.top = `${arrowTop}px`;
  if (placeRight) {
    arrow.style.left = "-7px";
    arrow.style.borderTop = "1px solid rgba(119, 214, 255, 0.4)";
    arrow.style.borderLeft = "1px solid rgba(119, 214, 255, 0.4)";
    arrow.style.borderRight = "none";
    arrow.style.borderBottom = "none";
  } else {
    arrow.style.right = "-7px";
    arrow.style.borderBottom = "1px solid rgba(119, 214, 255, 0.4)";
    arrow.style.borderRight = "1px solid rgba(119, 214, 255, 0.4)";
    arrow.style.borderTop = "none";
    arrow.style.borderLeft = "none";
  }

  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
  bubble.style.visibility = "visible";
};

const highlight = async (selector, tipText = "") => {
  activeHighlight = { selector, tipText };
  await renderActiveHighlight();
};

const clickFirst = async (selector) => {
  const doc = getAppDoc();
  const el = doc.querySelector(selector);
  if (!el) {
    throw new Error(`未找到元素: ${selector}`);
  }
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};

const clickByText = async (selector, zhText, enText) => {
  const doc = getAppDoc();
  const nodes = Array.from(doc.querySelectorAll(selector));
  const target = nodes.find((node) => {
    const text = (node.textContent || "").trim();
    return text.includes(zhText) || text.includes(enText);
  });
  if (!target) {
    throw new Error(`未找到按钮文本: ${zhText}/${enText}`);
  }
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};

const typeInInputByPlaceholder = async (placeholderPart, value) => {
  const doc = getAppDoc();
  const inputs = Array.from(doc.querySelectorAll("input"));
  const target = inputs.find((input) => ((input.getAttribute("placeholder") || "").toLowerCase().includes(placeholderPart.toLowerCase())));
  if (!target) {
    throw new Error(`未找到 placeholder 包含 ${placeholderPart} 的输入框`);
  }
  target.value = value;
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
};

const clearInputByPlaceholder = async (placeholderPart) => typeInInputByPlaceholder(placeholderPart, "");

const scroll = async (selector, top) => {
  const doc = getAppDoc();
  const el = doc.querySelector(selector);
  if (!el) {
    throw new Error(`未找到滚动容器: ${selector}`);
  }
  el.scrollTo({ top, behavior: "smooth" });
};

const selectByLabel = async (labelText, value) => {
  const doc = getAppDoc();
  const labels = Array.from(doc.querySelectorAll("label"));
  const targetLabel = labels.find((label) => (label.textContent || "").includes(labelText));
  if (!targetLabel) {
    throw new Error(`未找到 label: ${labelText}`);
  }
  const select = targetLabel.querySelector("select");
  if (!select) {
    throw new Error(`label 下未找到 select: ${labelText}`);
  }
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
};

const context = {
  wait,
  waitForAppReady,
  highlight,
  clearHighlight,
  clickFirst,
  clickByText,
  typeInInputByPlaceholder,
  clearInputByPlaceholder,
  scroll,
  selectByLabel,
  selectLanguage,
  getGuideLanguage,
};

const setStatus = (text) => {
  console.info(`[demo-status] ${text}`);
};

const normalizeIndex = (index) => {
  if (scenes.length === 0) {
    return 0;
  }
  return (index + scenes.length) % scenes.length;
};

const jumpToScene = async (index) => {
  stopRequested = true;
  currentIndex = normalizeIndex(index);
  await runCurrentScene();
};

const runCurrentScene = async () => {
  const scene = scenes[currentIndex];
  if (!scene) return;
  currentSceneStep = currentIndex + 1;
  currentSceneTotal = scenes.length;

  setStatus(`执行中：${scene.title}`);
  log(`开始 ${scene.title}`);

  try {
    await scene.run(context);
    await waitUntilContinue(HOLD_MS);
    if (stopRequested) {
      return;
    }
    setStatus(`完成：${scene.title}`);
    log(`完成 ${scene.title}`);
  } catch (error) {
    setStatus(`失败：${scene.title}`);
    log(`失败 ${scene.title}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const playLoop = async () => {
  if (isPlaying) return;
  isPlaying = true;
  stopRequested = false;
  setStatus("自动播放中");
  log("自动播放开始");

  while (!stopRequested) {
    await runCurrentScene();
    if (stopRequested) break;

    await waitUntilContinue(INTERVAL_MS);
    if (stopRequested) break;

    currentIndex = (currentIndex + 1) % scenes.length;
  }

  isPlaying = false;
  setStatus("已暂停");
  log("自动播放暂停");
};

const resetGuide = async () => {
  stopRequested = true;
  isPlaying = false;
  autoStartArmed = true;
  currentIndex = 0;
  await clearHighlight();
  frame.src = "/?demoSandbox=1";
  log("导览已重置");
};

resetBtn?.addEventListener("click", () => {
  void resetGuide();
});

langBtn?.addEventListener("click", () => {
  setGuideLanguage(getGuideLanguage() === "zh" ? "en" : "zh");
  refreshLanguageButton();
  void renderActiveHighlight();
});

frame.addEventListener("load", () => {
  log("应用 iframe 加载完成");
  if (autoStartArmed) {
    autoStartArmed = false;
    void playLoop();
  }
});

refreshLanguageButton();
setStatus("准备就绪，自动导览将在舞台加载后开始");
