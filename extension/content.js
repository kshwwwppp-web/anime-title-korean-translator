if (globalThis.__animeTitleTranslatorLoaded) {
  console.debug("[Anime Translator] content.js 중복 주입 차단");
} else {
  globalThis.__animeTitleTranslatorLoaded = true;

console.log("[Anime Translator] Content Script 가동됨 v6.0");

const pendingRequests = new Map();
const localCache = new Map();
let runtimeEnabled = false;
let settingsRevision = 0;
let processTimer = null;

const COMMON_UI_TEXT = new Set([
  "home", "login", "logout", "sign in", "sign up", "register", "search", "settings", "profile",
  "next", "previous", "more", "download", "comments", "comment", "rss", "about", "contact",
  "홈", "로그인", "로그아웃", "검색", "설정", "다음", "이전", "더보기", "댓글", "문의",
  "トップ", "ログイン", "検索", "設定", "次へ", "前へ", "もっと見る"
]);

function cleanAnimeTitle(rawTitle) {
  let title = String(rawTitle || "").trim();

  title = title.replace(/^\s*(?:\[[^\]]+\]\s*)+/g, "");
  title = title.replace(/\[[^\]]*\]/g, " ");
  title = title.replace(/\.(mkv|mp4|avi|webm)$/i, "");
  title = title.replace(/\b(1080p|720p|2160p|4k|hevc|x26[45]|av1|aac|flac|web[- ]?dl|bluray|blu[- ]?ray|multi[- ]?sub)\b.*$/i, "");
  title = title.replace(/\s*\((?:19|20)\d{2}\)\s*$/i, "");
  title = title.replace(/\s+(?:S\d{1,2}E\d{1,3}|E\d{1,3}|EP?\.?\s*\d{1,3}|#\d{1,3})\b.*$/i, "");
  title = title.replace(/\s+-\s+(?:\d{1,4})(?:v\d+)?(?:\s|$).*$/i, "");

  return title
    .replace(/\s+/g, " ")
    .replace(/^[-–—:|\s]+|[-–—:|\s]+$/g, "")
    .trim();
}

function normalizeDomain(raw) {
  let value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  value = value
    .replace(/^\*:\/\//, "")
    .replace(/^https?:\/\//, "")
    .replace(/^\*\./, "")
    .replace(/^\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/^\.+|\.+$/g, "");
  return value;
}

function siteAllowed(hostname, sites) {
  const host = normalizeDomain(hostname);
  return (sites || []).some((raw) => {
    const domain = normalizeDomain(raw);
    return domain && (host === domain || host.endsWith(`.${domain}`));
  });
}

function getConfiguredSites(config) {
  if (Array.isArray(config.sites)) return config.sites.map(normalizeDomain).filter(Boolean);

  // v5.x upgrade migration only. Fresh v6 installs have no default site.
  const legacy = normalizeDomain(config.targetDomain || "");
  const autoSites = Array.isArray(config.autoSites) ? config.autoSites : [];
  const manualSites = Array.isArray(config.manualSites) ? config.manualSites : [];
  return [...new Set([...autoSites, ...manualSites, legacy].map(normalizeDomain).filter(Boolean))];
}

function getCandidateText(element) {
  return String(
    element.dataset?.animeTitle ||
    element.dataset?.mediaTitle ||
    element.getAttribute?.("data-title") ||
    element.textContent ||
    element.getAttribute?.("title") ||
    ""
  ).trim();
}

function looksLikeTitle(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (text.length < 3 || text.length > 260) return false;
  if (/^(?:https?:\/\/|magnet:)/i.test(text)) return false;
  if (/^\d+(?:\.\d+)?\s*(?:kb|mb|gb|tb|kib|mib|gib)$/i.test(text)) return false;
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) return false;
  if (/^[\d\s.,:/_-]+$/.test(text)) return false;
  if (COMMON_UI_TEXT.has(text.toLowerCase())) return false;
  // Require at least one Latin/Korean/Japanese/CJK letter-like character.
  return /[A-Za-z가-힣ぁ-ゖァ-ヺ一-龯]/.test(text);
}

function collectTitleElements() {
  // The first selectors cover common list/table layouts; later selectors provide
  // a conservative generic fallback for anime/media pages chosen by the user.
  const selectors = [
    'td[colspan="2"] a:not(.comments)',
    'td:nth-child(2) a:not(.comments)',
    '[data-anime-title]',
    '[data-media-title]',
    'a.anime-title',
    '.anime-title a',
    'a.media-title',
    '.media-title a',
    '.entry-title a',
    '[class*="anime"][class*="title"] a',
    '[class*="media"][class*="title"] a',
    '[class*="title"] > a[title]'
  ];

  const unique = new Set();
  for (const selector of selectors) {
    try {
      document.querySelectorAll(selector).forEach((el) => {
        if (!el.closest?.('.trans-badge') && looksLikeTitle(getCandidateText(el))) unique.add(el);
      });
    } catch (_) {}
  }
  return [...unique];
}

function attachBadge(element, text, color) {
  if (element.querySelector?.(".trans-badge")) return;
  const badge = document.createElement("span");
  badge.className = "trans-badge";
  badge.textContent = `[${text}] `;
  badge.style.cssText = `color:${color};font-weight:bold;margin-right:5px;background:rgba(0,123,255,.08);padding:1px 5px;border-radius:4px;font-size:12px;`;
  element.prepend(badge);
}

function resetTranslationState() {
  document.querySelectorAll(".trans-badge").forEach((badge) => badge.remove());
  document.querySelectorAll("[data-translated-done]").forEach((element) => {
    delete element.dataset.translatedDone;
    delete element.dataset.translateRetry;
  });
  pendingRequests.clear();
}

function scheduleProcess(delay = 100) {
  clearTimeout(processTimer);
  processTimer = setTimeout(() => {
    processTimer = null;
    processTitles();
  }, delay);
}

function processTitles() {
  const revisionAtStart = settingsRevision;

  chrome.storage.sync.get(
    ["enabled", "rules", "sites", "autoSites", "manualSites", "targetDomain"],
    (config) => {
      if (revisionAtStart !== settingsRevision) return;

      runtimeEnabled = config.enabled === true;
      if (!runtimeEnabled) return;

      const sites = getConfiguredSites(config);
      if (!siteAllowed(location.hostname, sites)) return;

      const userRules = Array.isArray(config.rules) ? config.rules : [];
      const elements = collectTitleElements();

      elements.forEach((element) => {
        if (element.dataset.translatedDone === "true") return;

        const rawTitle = getCandidateText(element);
        if (!rawTitle) return;

        // Manual replacements always have priority and never trigger a network request.
        for (const rule of userRules) {
          if (rule.from && rawTitle.toLowerCase().includes(String(rule.from).toLowerCase())) {
            element.dataset.translatedDone = "true";
            attachBadge(element, rule.to, "#52c41a");
            return;
          }
        }

        const query = cleanAnimeTitle(rawTitle);
        if (!query || query.length < 3 || !looksLikeTitle(query)) return;

        element.dataset.translatedDone = "true";

        if (localCache.has(query)) {
          attachBadge(element, localCache.get(query), "#0275d8");
          return;
        }

        if (pendingRequests.has(query)) {
          pendingRequests.get(query).push(element);
          return;
        }

        pendingRequests.set(query, [element]);
        const requestRevision = settingsRevision;

        chrome.runtime.sendMessage({ action: "translateAnime", query }, (res) => {
          const waitingElements = pendingRequests.get(query) || [];

          if (!runtimeEnabled || requestRevision !== settingsRevision) {
            pendingRequests.delete(query);
            return;
          }

          if (chrome.runtime.lastError) {
            retryFailedElements(waitingElements, requestRevision);
            pendingRequests.delete(query);
            return;
          }

          if (res?.success && res?.koreanTitle) {
            localCache.set(query, res.koreanTitle);
            waitingElements.forEach((el) => attachBadge(el, res.koreanTitle, "#0275d8"));
          } else {
            retryFailedElements(waitingElements, requestRevision);
          }

          pendingRequests.delete(query);
        });
      });
    }
  );
}

function retryFailedElements(elements, requestRevision) {
  elements.forEach((element) => {
    const retry = Number(element.dataset.translateRetry || "0");
    if (retry < 1) {
      element.dataset.translateRetry = String(retry + 1);
      setTimeout(() => {
        if (!runtimeEnabled || requestRevision !== settingsRevision) return;
        delete element.dataset.translatedDone;
        scheduleProcess(0);
      }, 3500);
    }
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "animeTranslatorPing") {
    sendResponse({ alive: true, enabled: runtimeEnabled });
    return;
  }

  if (request.action === "animeTranslatorDeactivate") {
    settingsRevision += 1;
    runtimeEnabled = false;
    resetTranslationState();
    sendResponse({ success: true, active: false });
    return;
  }

  if (request.action === "animeTranslatorApplySettings") {
    settingsRevision += 1;
    const revision = settingsRevision;
    resetTranslationState();

    chrome.storage.sync.get(
      ["enabled", "rules", "sites", "autoSites", "manualSites", "targetDomain"],
      (config) => {
        if (revision !== settingsRevision) {
          sendResponse({ success: false, stale: true });
          return;
        }

        runtimeEnabled = config.enabled === true;
        const allowed = siteAllowed(location.hostname, getConfiguredSites(config));
        if (runtimeEnabled && allowed) scheduleProcess(0);
        sendResponse({ success: true, active: runtimeEnabled && allowed });
      }
    );
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (!(changes.enabled || changes.rules || changes.sites || changes.autoSites || changes.manualSites || changes.targetDomain)) return;

  settingsRevision += 1;
  if (changes.enabled) runtimeEnabled = changes.enabled.newValue === true;
  resetTranslationState();
  if (runtimeEnabled) scheduleProcess(0);
});

processTitles();
const fallbackTimer = setInterval(() => {
  if (runtimeEnabled) processTitles();
}, 3000);

const observer = new MutationObserver(() => {
  if (runtimeEnabled) scheduleProcess(180);
});
observer.observe(document.body, { childList: true, subtree: true });

// Keep references explicit for easier debugging in DevTools.
void fallbackTimer;
}
