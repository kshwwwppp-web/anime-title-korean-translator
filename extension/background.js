console.log("[Background] 서비스 워커 가동 (다국어 제목 복원 엔진 v6.0)");

const CACHE_KEY = "titleCache_v6_0";
let titleCache = {};
chrome.storage.local.get(CACHE_KEY, (data) => {
  if (data[CACHE_KEY] && typeof data[CACHE_KEY] === "object") {
    titleCache = data[CACHE_KEY];
  }
});

const queue = [];
let isProcessing = false;
let queueTimer = null;

// v5.2: 페이지에서 짧은 시간 안에 들어오는 제목을 모아 AniList를 한 번에 조회한다.
const QUEUE_COLLECT_MS = 80;
const ANILIST_BATCH_SIZE = 5;
const ANILIST_VARIANTS_PER_TITLE = 3;
const FALLBACK_CONCURRENCY = 3;

// AniList는 현재 제한이 낮아질 수 있으므로 기본 30 req/min 수준으로 안전하게 시작한다.
// 응답 헤더에서 더 높은 limit이 확인되면 자동으로 빨라진다.
let anilistMinIntervalMs = 2100;
let lastAniListRequestAt = 0;

const hasKorean = (text) => /[가-힣]/.test(text || "");
const hasJapaneseKana = (text) => /[ぁ-ゖァ-ヺー]/.test(text || "");
const hasCJK = (text) => /[一-龯々〆ヵヶ]/.test(text || "");
const isJapaneseText = (text) => hasJapaneseKana(text) || /[「」『』【】]/.test(text || "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONTENT_SCRIPT_ID = "anime-title-translator-dynamic";

function normalizeSiteDomain(raw) {
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
  try {
    return new URL(`https://${value}`).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

function siteMatchPatterns(domain) {
  return [`https://*.${domain}/*`];
}

function uniqueDomains(values) {
  return [...new Set((values || []).map(normalizeSiteDomain).filter(Boolean))];
}

async function getConfiguredDomains() {
  const data = await chrome.storage.sync.get(["sites", "autoSites", "manualSites", "targetDomain"]);
  const legacy = normalizeSiteDomain(data.targetDomain || "");
  const legacyAuto = Array.isArray(data.autoSites) ? data.autoSites : [];
  const legacyManual = Array.isArray(data.manualSites) ? data.manualSites : [];
  const configuredSites = Array.isArray(data.sites) && data.sites.length
    ? data.sites
    : [...legacyAuto, ...legacyManual, legacy].filter(Boolean);
  return uniqueDomains(configuredSites);
}

async function queryTabsForDomains(domains) {
  const patterns = uniqueDomains(domains).flatMap(siteMatchPatterns);
  if (!patterns.length) return [];
  try {
    return await chrome.tabs.query({ url: patterns });
  } catch (error) {
    console.debug("[즉시 반영] 탭 조회 실패:", error);
    return [];
  }
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      resolve({ response, error });
    });
  });
}

async function ensureContentScript(tabId) {
  const ping = await sendTabMessage(tabId, { action: "animeTranslatorPing" });
  if (!ping.error && ping.response?.alive) return true;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    return true;
  } catch (error) {
    console.debug(`[즉시 반영] tab ${tabId} content.js 주입 실패:`, error);
    return false;
  }
}

async function applySettingsToOpenTabs({ previousSites = [], sites = [], enabled } = {}) {
  const currentSites = uniqueDomains(sites.length ? sites : await getConfiguredDomains());
  const oldSites = uniqueDomains(previousSites);
  const isEnabled = typeof enabled === "boolean"
    ? enabled
    : (await chrome.storage.sync.get("enabled")).enabled !== false;

  // 현재 적용 대상: 켜져 있으면 content.js가 없는 탭에도 즉시 주입하고 재처리한다.
  const activeTabs = await queryTabsForDomains(currentSites);
  const activeIds = new Set(activeTabs.map((tab) => tab.id).filter(Number.isInteger));

  for (const tab of activeTabs) {
    if (!Number.isInteger(tab.id)) continue;
    if (isEnabled) {
      const ready = await ensureContentScript(tab.id);
      if (ready) {
        await sendTabMessage(tab.id, { action: "animeTranslatorApplySettings" });
      }
    } else {
      await sendTabMessage(tab.id, { action: "animeTranslatorDeactivate" });
    }
  }

  // 목록에서 제거된 사이트의 열린 탭은 기존 content script가 남아 있을 수 있으므로 즉시 정리한다.
  const removedSites = oldSites.filter((domain) => !currentSites.includes(domain));
  if (removedSites.length) {
    const removedTabs = await queryTabsForDomains(removedSites);
    for (const tab of removedTabs) {
      if (!Number.isInteger(tab.id) || activeIds.has(tab.id)) continue;
      await sendTabMessage(tab.id, { action: "animeTranslatorDeactivate" });
    }
  }

  return { success: true };
}

async function refreshRegisteredContentScript() {
  try {
    const data = await chrome.storage.sync.get(["sites", "autoSites", "manualSites", "targetDomain"]);
    const legacy = normalizeSiteDomain(data.targetDomain || "");
    const legacyAuto = Array.isArray(data.autoSites) ? data.autoSites : [];
    const legacyManual = Array.isArray(data.manualSites) ? data.manualSites : [];
    const configuredSites = Array.isArray(data.sites) && data.sites.length
      ? data.sites
      : [...legacyAuto, ...legacyManual, legacy].filter(Boolean);
    const domains = [...new Set(configuredSites.map(normalizeSiteDomain).filter(Boolean))];
    const enabled = (await chrome.storage.sync.get("enabled")).enabled === true;

    const matches = [];
    if (!enabled) {
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
      } catch (_) {}
      console.log("[설정] 기능이 꺼져 있어 콘텐츠 스크립트를 등록하지 않습니다.");
      return;
    }
    for (const domain of domains) {
      for (const pattern of siteMatchPatterns(domain)) {
        try {
          const allowed = await chrome.permissions.contains({ origins: [pattern] });
          if (allowed) matches.push(pattern);
        } catch (_) {}
      }
    }

    try {
      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    } catch (_) {}

    if (matches.length) {
      await chrome.scripting.registerContentScripts([{
        id: CONTENT_SCRIPT_ID,
        matches: [...new Set(matches)],
        js: ["content.js"],
        runAt: "document_idle",
        persistAcrossSessions: true
      }]);
      console.log("[설정] 콘텐츠 스크립트 적용 사이트:", [...new Set(matches)]);
    } else {
      console.log("[설정] 등록된 적용 사이트가 없어 콘텐츠 스크립트를 비활성화합니다.");
    }
  } catch (error) {
    console.error("[설정] 콘텐츠 스크립트 등록 실패:", error);
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  // New public installs start disabled and without any site access.
  // Updates keep the user's existing settings and legacy site migration data.
  if (details.reason === "install") {
    const current = await chrome.storage.sync.get(["enabled", "sites", "rules"]);
    const defaults = {};
    if (typeof current.enabled !== "boolean") defaults.enabled = false;
    if (!Array.isArray(current.sites)) defaults.sites = [];
    if (!Array.isArray(current.rules)) defaults.rules = [];
    if (Object.keys(defaults).length) await chrome.storage.sync.set(defaults);
  }
  await refreshRegisteredContentScript();
});
chrome.runtime.onStartup.addListener(() => refreshRegisteredContentScript());
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;

  if (changes.enabled || changes.sites || changes.autoSites || changes.manualSites || changes.targetDomain) {
    refreshRegisteredContentScript();
  }

  // 설정이 다른 경로에서 바뀐 경우에도 열린 탭에 가능한 범위에서 즉시 반영한다.
  if (changes.enabled || changes.rules || changes.sites) {
    const previousSites = Array.isArray(changes.sites?.oldValue) ? changes.sites.oldValue : [];
    const sites = Array.isArray(changes.sites?.newValue) ? changes.sites.newValue : [];
    const enabled = typeof changes.enabled?.newValue === "boolean" ? changes.enabled.newValue : undefined;
    applySettingsToOpenTabs({ previousSites, sites, enabled }).catch((error) => {
      console.debug("[즉시 반영] storage 변경 적용 실패:", error);
    });
  }
});

// 서비스 워커가 다시 살아난 경우에도 등록 상태를 현재 설정과 맞춘다.
refreshRegisteredContentScript();

// 일본어 음원/OST 릴리즈명에서 실제 작품명만 추출한다.
// 예: TVアニメ「作品名」EDテーマ「曲名」／歌手 -> 作品名
//     映画「作品名」オリジナルサウンドトラック「Album」 -> 作品名
function extractJapaneseMediaTitle(text) {
  const raw = String(text || "").normalize("NFKC").trim();
  if (!raw || !isJapaneseText(raw)) return raw;

  // 작품을 가리키는 접두어 바로 뒤의 첫 따옴표를 최우선으로 사용한다.
  const tagged = raw.match(/(?:TV\s*アニメ|テレビアニメ|アニメーション|アニメ|劇場版|映画|OVA|OAD|Web\s*アニメ|WEB\s*アニメ)\s*[「『]([^」』]{2,})[」』]/i);
  if (tagged?.[1]) return cleanupJapaneseMediaTitle(tagged[1]);

  // 일반적인 일본 릴리즈는 첫 번째 「...」가 작품명인 경우가 많다.
  const quoted = raw.match(/[「『]([^」』]{2,})[」』]/);
  if (quoted?.[1]) return cleanupJapaneseMediaTitle(quoted[1]);

  return cleanupJapaneseMediaTitle(raw);
}

function cleanupJapaneseMediaTitle(text) {
  return String(text || "")
    .replace(/^\s*(?:TV\s*アニメ|テレビアニメ|アニメーション|アニメ|劇場版|映画|OVA|OAD)\s*/i, "")
    .replace(/\s*(?:OP|ED|OP\d+|ED\d+|挿入歌|主題歌|テーマ|オープニング|エンディング|オリジナルサウンドトラック).*$/i, "")
    .replace(/\s*[／/]\s*[^／/]+$/u, "")
    .replace(/^[「『]|[」』]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getPrimaryLookupQuery(query) {
  return isJapaneseText(query) ? extractJapaneseMediaTitle(query) : query;
}

// 웹에서 한국어 명칭이 확인된 작품 + 자주 실패하는 표기.
// 외부 API가 잠시 막혀도 잘못된 제목을 붙이지 않도록 안전망으로 사용한다.
const BUILTIN_TITLES = new Map([
  ["keroro gunsou", "개구리 중사 케로로"],
  ["keroro gunso", "개구리 중사 케로로"],
  ["uchi no otouto domo ga sumimasen", "우리 남동생들이 죄송합니다"],
  ["tokyo revengers santen sensou hen", "도쿄 리벤저스 삼천전쟁편"],
  ["shiguang dailiren", "시광대리인"],
  ["link click", "시광대리인"],
  ["koori no jouheki", "얼음 성벽"],
  ["tsuihou sareta tensei juukishi wa game chishiki de musou suru", "추방된 전생 중기사는 게임 지식으로 무쌍한다"],
  ["tsuihou sareta tensei juu kishi wa geemu chishiki de musou suru", "추방된 전생 중기사는 게임 지식으로 무쌍한다"],
  ["dogulwang", "도굴왕"],
  ["tomb raider king", "도굴왕"],
  ["thunder 3", "썬더 3"],
  ["shin tennis no ouji sama u 17 world cup kesshou member ketteisen", "신 테니스의 왕자 U-17 WORLD CUP 결승 멤버 결정전"],
  ["shin tennis no oujisama u 17 world cup kesshou member ketteisen", "신 테니스의 왕자 U-17 WORLD CUP 결승 멤버 결정전"],
  ["tensei shitara ken deshita ii", "전생했더니 검이었습니다 Ⅱ"],
  ["tensei shitara ken deshita 2nd season", "전생했더니 검이었습니다 Ⅱ"],
  ["reincarnated as a sword season 2", "전생했더니 검이었습니다 Ⅱ"],
  ["clevatess ii", "클레바테스Ⅱ-마수의 왕과 거짓된 용자전승-"],
  ["clevatess season 2", "클레바테스Ⅱ-마수의 왕과 거짓된 용자전승-"],
  ["tougen anki nikko kegon no taki hen", "도원암귀 2기 닛코·케곤 폭포 편"],
  ["tougen anki nikko kegon falls arc", "도원암귀 2기 닛코·케곤 폭포 편"],
  ["mononoke movie chapter iii the curse of the serpent", "극장판 모노노케 제3장: 뱀의 저주"],
  ["mononoke the movie chapter iii the curse of the serpent", "극장판 모노노케 제3장: 뱀의 저주"],
  ["gekijouban mononoke dai san shou hebigami", "극장판 모노노케 제3장: 뱀의 저주"],
  ["gekijoban mononoke dai san sho hebigami", "극장판 모노노케 제3장: 뱀의 저주"]
]);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "refreshContentScripts") {
    refreshRegisteredContentScript()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: String(error) }));
    return true;
  }

  if (request.action === "applySettingsToOpenTabs") {
    (async () => {
      await refreshRegisteredContentScript();
      return applySettingsToOpenTabs({
        previousSites: Array.isArray(request.previousSites) ? request.previousSites : [],
        sites: Array.isArray(request.sites) ? request.sites : [],
        enabled: typeof request.enabled === "boolean" ? request.enabled : undefined
      });
    })()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ success: false, error: String(error) }));
    return true;
  }

  if (request.action === "clearTranslationCache") {
    titleCache = {};
    chrome.storage.local.remove(CACHE_KEY, () => {
      sendResponse({ success: !chrome.runtime.lastError });
    });
    return true;
  }

  if (request.action !== "translateAnime") return;

  const rawQuery = request.query ? request.query.trim() : "";
  const query = sanitizeLookupQuery(rawQuery);
  if (!query) {
    sendResponse({ success: false });
    return true;
  }

  const cacheKey = normalizeKey(query);
  if (titleCache[cacheKey] && hasKorean(titleCache[cacheKey])) {
    sendResponse({ success: true, koreanTitle: titleCache[cacheKey], source: "cache" });
    return true;
  }

  const existing = queue.find((item) => item.cacheKey === cacheKey);
  if (existing) {
    existing.sendResponses.push(sendResponse);
  } else {
    queue.push({ query, rawQuery, cacheKey, sendResponses: [sendResponse] });
    scheduleQueue();
  }

  return true;
});

function saveCache(cacheKey, title) {
  titleCache[cacheKey] = title;
  chrome.storage.local.set({ [CACHE_KEY]: titleCache });
}

function scheduleQueue() {
  if (isProcessing || queueTimer) return;
  queueTimer = setTimeout(() => {
    queueTimer = null;
    processQueue();
  }, QUEUE_COLLECT_MS);
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (queue.length > 0) {
      // 첫 요청 직후 들어오는 나머지 제목을 잠깐 모아서 batch 효율을 높인다.
      if (queue.length < ANILIST_BATCH_SIZE) {
        await sleep(QUEUE_COLLECT_MS);
      }

      const jobs = queue.splice(0, ANILIST_BATCH_SIZE);
      await processBatch(jobs);
    }
  } finally {
    isProcessing = false;
    if (queue.length > 0) scheduleQueue();
  }
}

async function processBatch(jobs) {
  const networkJobs = [];
  const preResolved = new Map();

  // BuiltIn은 네트워크 없이 즉시 해결한다.
  for (const job of jobs) {
    const builtin = lookupBuiltin(job.query);
    if (builtin) {
      preResolved.set(job.cacheKey, { title: builtin, source: "BuiltIn-KO" });
    } else {
      networkJobs.push(job);
    }
  }

  // 여러 작품을 GraphQL 1회로 조회한다.
  const anilistMap = networkJobs.length
    ? await searchAniListBatch(networkJobs)
    : new Map();

  await mapWithConcurrency(jobs, FALLBACK_CONCURRENCY, async (job) => {
    try {
      const result = preResolved.get(job.cacheKey) ||
        await resolveKoreanTitle(job.query, anilistMap.has(job.cacheKey) ? anilistMap.get(job.cacheKey) : null);

      if (result?.title && hasKorean(result.title)) {
        const title = cleanupTitle(result.title);
        saveCache(job.cacheKey, title);
        console.log(
          `%c[번역 성공:${result.source}] "${job.rawQuery}" -> "${title}"${result.native ? ` / 원문: ${result.native}` : ""}`,
          "color:#1890ff;font-weight:bold;"
        );
        job.sendResponses.forEach((cb) => cb({
          success: true,
          koreanTitle: title,
          source: result.source
        }));
      } else {
        console.warn(`[번역 불가] "${job.rawQuery}"`);
        job.sendResponses.forEach((cb) => cb({ success: false }));
      }
    } catch (err) {
      console.error(`[오류] "${job.rawQuery}":`, err);
      job.sendResponses.forEach((cb) => cb({ success: false }));
    }
  });
}

async function mapWithConcurrency(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

async function resolveKoreanTitle(query, preloadedAniList = undefined) {
  // 일본어 음원/OST 릴리즈명은 전체 문자열이 아니라 실제 작품명을 기준으로 찾는다.
  const lookupQuery = getPrimaryLookupQuery(query);

  // 0) 이미 확인된 작품명은 네트워크보다 우선. 오탐 방지용 안전망.
  const builtin = lookupBuiltin(lookupQuery);
  if (builtin) {
    return { title: builtin, source: "BuiltIn-KO" };
  }

  // 1) AniList를 여러 표기 변형으로 한 번에 검색한다.
  const variants = buildSearchVariants(lookupQuery);
  const anilist = preloadedAniList !== undefined
    ? preloadedAniList
    : await searchAniListBest(lookupQuery, variants);

  if (anilist) {
    const koreanSynonym = anilist.synonyms?.find(hasKorean);
    if (koreanSynonym) {
      return { title: koreanSynonym, source: "AniList-KO", native: anilist.native };
    }
    if (hasKorean(anilist.native)) {
      return { title: anilist.native, source: "AniList-native-KO", native: anilist.native };
    }

    // 2) 매칭된 작품을 기준으로만 Wikipedia를 검색한다.
    //    raw query만 검색해서 Thunder 3 -> War Thunder 같은 오탐이 나는 것을 막는다.
    const wikiQueries = [...new Set([
      anilist.english,
      anilist.romaji,
      lookupQuery
    ].filter(Boolean))];

    let wikiKo = null;
    for (const wikiQuery of wikiQueries) {
      wikiKo = await searchWikipediaKoStrict(wikiQuery, anilist.native);
      if (wikiKo) break;
    }

    // 3) 원문 직접 번역도 후보로 만든다.
    const translatedNative = anilist.native
      ? await translateWithGoogle(anilist.native, "auto")
      : null;

    // 부제/시즌이 있는 입력인데 Wikipedia가 프랜차이즈 본편명만 반환했다면
    // 원문 전체 번역을 우선하여 정보를 잃지 않게 한다.
    if (translatedNative && shouldPreferNativeTranslation(lookupQuery, anilist, wikiKo, translatedNative)) {
      return {
        title: translatedNative,
        source: "AniList-native-translate",
        native: anilist.native
      };
    }

    if (wikiKo && hasKorean(wikiKo)) {
      return { title: wikiKo, source: "Wikipedia-KO", native: anilist.native };
    }

    if (translatedNative && hasKorean(translatedNative)) {
      return {
        title: translatedNative,
        source: "AniList-native-translate",
        native: anilist.native
      };
    }
  }

  // 4) 일본어 원문은 IME 복원이 필요 없다. 작품명만 직접 한글 번역한다.
  //    음원 릴리즈 전체를 번역하지 않아 배지 길이와 오탐을 줄인다.
  if (isJapaneseText(lookupQuery)) {
    const directJapanese = await translateWithGoogle(lookupQuery, "ja");
    if (directJapanese && hasKorean(directJapanese)) {
      return { title: normalizeKoreanSeasonLabel(directJapanese), source: "Japanese-direct", native: lookupQuery };
    }
  }

  // 5) 로마자일 때만 일본어 IME 복원을 시도한다.
  const restored = !isJapaneseText(lookupQuery)
    ? await restoreJapaneseAndTranslate(lookupQuery)
    : null;
  if (restored?.title) return restored;

  // 6) 마지막 폴백: 매우 엄격한 Wikipedia 검색.
  //    숫자/핵심 토큰이 안 맞으면 절대 채택하지 않는다.
  const wikiFallback = await searchWikipediaKoStrict(lookupQuery, null);
  if (wikiFallback) {
    return { title: wikiFallback, source: "Wikipedia-strict" };
  }

  // 7) 로마자 자체 번역은 최후에만 사용한다.
  const direct = await translateWithGoogle(lookupQuery, "auto");
  if (direct && hasKorean(direct) && !looksLikeUntranslatedRomanization(lookupQuery, direct)) {
    return { title: direct, source: "Google-direct" };
  }

  return null;
}

function sanitizeLookupQuery(text) {
  return String(text || "")
    .replace(/^\s*(?:\[[^\]]+\]\s*)+/g, "")
    .replace(/\[[^\]]*\]/g, " ")
    // content.js가 구버전이어도 연도 메타데이터는 background에서 한 번 더 제거
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKoreanSeasonLabel(text) {
  return String(text || "")
    .replace(/\b1st\s+Season\b/gi, "1기")
    .replace(/\b2nd\s+Season\b/gi, "2기")
    .replace(/\b3rd\s+Season\b/gi, "3기")
    .replace(/\b(\d+)th\s+Season\b/gi, "$1기")
    .replace(/\bSeason\s*(\d+)\b/gi, "$1기")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanupTitle(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .replace(/^\s*["'“”‘’]+|["'“”‘’]+\s*$/g, "")
    .trim();
}

function normalizeKey(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9가-힣一-龯ぁ-ゖァ-ヺ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeLatin(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function lookupBuiltin(query) {
  const key = normalizeLatin(query);
  if (!key) return null;
  if (BUILTIN_TITLES.has(key)) return BUILTIN_TITLES.get(key);

  // (2026), Season 등의 메타 표기를 제거한 값도 확인
  const base = normalizeLatin(
    query
      .replace(/\s*\((?:19|20)\d{2}\)\s*$/i, "")
      .replace(/\s+(?:season\s*\d+|s\d+)\s*$/i, "")
  );
  return BUILTIN_TITLES.get(base) || null;
}

function buildSearchVariants(query) {
  const list = [query];
  const noYear = query.replace(/\s*\((?:19|20)\d{2}\)\s*$/i, "").trim();
  list.push(noYear);

  // 'Hen' 표기 차이 대응: Santen Sensou Hen / Santen Sensou-hen
  list.push(noYear.replace(/\s+Hen\b/gi, "-hen"));
  list.push(noYear.replace(/-hen\b/gi, " Hen"));

  // 로마 숫자 시즌 표기 대응
  const romanSeason = noYear.match(/^(.*?)(?:\s+|\s*:\s*)(II|III|IV)$/i);
  if (romanSeason) {
    const num = { II: 2, III: 3, IV: 4 }[romanSeason[2].toUpperCase()];
    const base = romanSeason[1].trim();
    list.push(`${base} ${num}nd Season`.replace("3nd", "3rd").replace("4nd", "4th"));
    list.push(`${base} Season ${num}`);
    list.push(base);
  }

  // 장음 표기 차이: Juukishi/Jukishi, Gunsou/Gunso 같은 검색 보강
  const collapsed = noYear
    .replace(/ou/gi, "o")
    .replace(/uu/gi, "u")
    .replace(/aa/gi, "a")
    .replace(/ee/gi, "e")
    .replace(/oo/gi, "o");
  list.push(collapsed);

  // 콜론 뒤 부제는 정확 검색 실패 시에만 후보 식별용으로 사용
  if (noYear.includes(":")) {
    list.push(noYear.split(":")[0].trim());
  }

  // 영문 릴리즈 제목에서 "작품명 - Chapter/Part - 부제" 형태를 별도 보강.
  // 예: Mononoke Movie - Chapter III - The Curse of the Serpent
  const dashParts = noYear.split(/\s[-–—]\s/).map((v) => v.trim()).filter(Boolean);
  if (dashParts.length >= 2) {
    list.push(dashParts.join(": "));
    list.push(dashParts.join(" "));

    const head = dashParts[0];
    const detail = dashParts.slice(1).join(" ");
    list.push(head);
    list.push(`${head}: ${detail}`);

    // AniList 영문 제목에는 "the Movie"가 들어가는 경우가 있어 검색 별칭도 생성한다.
    if (/\bmovie\b/i.test(head) && !/\bthe movie\b/i.test(head)) {
      const withThe = head.replace(/\bmovie\b/i, "the Movie");
      list.push(withThe);
      list.push(`${withThe}: ${detail}`);
    }
  }

  return [...new Set(list.map((v) => cleanupTitle(v)).filter((v) => v.length >= 3))].slice(0, 10);
}

function tokenScore(query, candidate) {
  const a = normalizeLatin(query);
  const b = normalizeLatin(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1000;
  if (a.startsWith(b) || b.startsWith(a)) return 880;
  if (a.includes(b) || b.includes(a)) return 780;

  const stop = new Set(["the", "a", "an", "of", "and", "no", "wa", "to", "ga", "ni", "de"]);
  const aa = a.split(" ").filter((t) => t && !stop.has(t));
  const bb = b.split(" ").filter((t) => t && !stop.has(t));
  if (!aa.length || !bb.length) return 0;

  const setA = new Set(aa);
  const setB = new Set(bb);
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;

  const dice = (2 * intersection) / (setA.size + setB.size);
  const coverage = intersection / setA.size;
  return Math.round(dice * 650 + coverage * 250);
}

function numericTokens(text) {
  return normalizeLatin(text).split(" ").filter((t) => /^\d+$/.test(t));
}

function numbersCompatible(expected, candidate) {
  const a = numericTokens(expected);
  if (!a.length) return true;
  const b = new Set(numericTokens(candidate));
  return a.every((n) => b.has(n));
}

async function fetchWithRetry(url, options = {}, retries = 3) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;

      if (res.status !== 429 && res.status < 500) return res;

      const retryAfter = Number(res.headers.get("Retry-After"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 700 * Math.pow(2, attempt);
      console.debug(`[재시도] HTTP ${res.status}, ${waitMs}ms 후 재호출`);
      await sleep(waitMs);
    } catch (e) {
      lastError = e;
      if (attempt < retries) await sleep(700 * Math.pow(2, attempt));
    }
  }

  if (lastError) throw lastError;
  return null;
}

async function waitForAniListSlot() {
  const elapsed = Date.now() - lastAniListRequestAt;
  const waitMs = anilistMinIntervalMs - elapsed;
  if (waitMs > 0) await sleep(waitMs);
  lastAniListRequestAt = Date.now();
}

function updateAniListRateFromHeaders(res) {
  const limit = Number(res?.headers?.get("X-RateLimit-Limit"));
  const remaining = Number(res?.headers?.get("X-RateLimit-Remaining"));

  if (Number.isFinite(limit) && limit > 0) {
    // 약간의 여유를 두고 limit에 맞춰 자동 조정한다.
    const calculated = Math.ceil(60000 / limit) + 80;
    anilistMinIntervalMs = Math.max(650, calculated);
  }

  // 잔여량이 거의 없으면 다음 호출을 조금 더 늦춘다.
  if (Number.isFinite(remaining) && remaining <= 2) {
    anilistMinIntervalMs = Math.max(anilistMinIntervalMs, 2500);
  }
}

async function postAniList(graphqlQuery, retries = 3) {
  await waitForAniListSlot();
  const res = await fetchWithRetry("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(graphqlQuery)
  }, retries);
  if (res) updateAniListRateFromHeaders(res);
  return res;
}

function chooseBestAniList(originalQuery, variants, mediaList) {
  if (!mediaList?.length) return null;

  const unique = new Map();
  for (const media of mediaList) {
    if (media?.id != null) unique.set(media.id, media);
  }

  const lookupOriginal = getPrimaryLookupQuery(originalQuery);
  const japaneseInput = isJapaneseText(lookupOriginal);
  const compactOriginal = japaneseInput ? compactCJK(lookupOriginal) : "";

  let best = null;
  let bestScore = -1;

  for (const media of unique.values()) {
    const latinCandidates = [
      media?.title?.romaji,
      media?.title?.english,
      ...(media?.synonyms || []).filter((s) => /[A-Za-z]/.test(s))
    ].filter(Boolean);

    let score = Math.max(
      0,
      ...latinCandidates.flatMap((candidate) =>
        variants.map((variant) => tokenScore(variant, candidate))
      )
    );

    // v5.3: 일본어 입력은 AniList native 제목과 직접 비교한다.
    // 기존에는 로마자/영문만 비교해서 일본어 검색 결과가 와도 점수 0으로 버려졌다.
    if (japaneseInput) {
      const nativeCandidates = [
        media?.title?.native,
        ...(media?.synonyms || []).filter((x) => isJapaneseText(x))
      ].filter(Boolean);

      for (const candidate of nativeCandidates) {
        const c = compactCJK(candidate);
        if (!c || !compactOriginal) continue;
        if (c === compactOriginal) score = Math.max(score, 1200);
        else if (c.includes(compactOriginal) || compactOriginal.includes(c)) score = Math.max(score, 1020);
        else {
          // 일본어 제목의 공통 문자 비율로 느슨한 보조 점수. 너무 낮으면 채택하지 않는다.
          const aSet = new Set([...compactOriginal]);
          const bSet = new Set([...c]);
          let common = 0;
          for (const ch of aSet) if (bSet.has(ch)) common++;
          const coverage = common / Math.max(1, aSet.size);
          if (coverage >= 0.72) score = Math.max(score, Math.round(500 + coverage * 350));
        }
      }
    }

    const numberOk = japaneseInput || numericTokens(originalQuery).length === 0 ||
      latinCandidates.some((candidate) => numbersCompatible(originalQuery, candidate));

    const adjusted = numberOk ? score : score - 300;
    if (adjusted > bestScore) {
      bestScore = adjusted;
      best = media;
    }
  }

  if (!best || bestScore < (japaneseInput ? 650 : 360)) return null;
  return {
    id: best.id,
    romaji: best.title?.romaji || "",
    english: best.title?.english || "",
    native: best.title?.native || "",
    synonyms: best.synonyms || [],
    score: bestScore
  };
}

// v5.3: 최대 5개 작품 × 각 3개 검색 변형을 GraphQL 한 요청에 묶는다.
async function searchAniListBatch(jobs) {
  const queryDefs = [];
  const declarations = [];
  const variables = {};
  const metadata = [];

  jobs.forEach((job, jobIndex) => {
    const lookupQuery = getPrimaryLookupQuery(job.query);
    const variants = buildSearchVariants(lookupQuery).slice(0, ANILIST_VARIANTS_PER_TITLE);
    metadata[jobIndex] = { job, lookupQuery, variants };

    variants.forEach((variant, variantIndex) => {
      const varName = `j${jobIndex}v${variantIndex}`;
      const alias = `q${jobIndex}_${variantIndex}`;
      declarations.push(`$${varName}: String`);
      variables[varName] = variant;
      queryDefs.push(`
        ${alias}: Page(page: 1, perPage: 6) {
          media(search: $${varName}) {
            id
            title { romaji english native }
            synonyms
          }
        }
      `);
    });
  });

  const resultMap = new Map();
  if (!queryDefs.length) return resultMap;

  const graphqlQuery = {
    query: `query (${declarations.join(", ")}) { ${queryDefs.join("\n")} }`,
    variables
  };

  try {
    const res = await postAniList(graphqlQuery, 3);
    if (!res || !res.ok) {
      console.debug("[AniList Batch 실패]", res?.status);
      return resultMap;
    }

    const json = await res.json();
    metadata.forEach(({ job, lookupQuery, variants }, jobIndex) => {
      const mediaList = [];
      variants.forEach((_, variantIndex) => {
        mediaList.push(...(json?.data?.[`q${jobIndex}_${variantIndex}`]?.media || []));
      });
      const best = chooseBestAniList(lookupQuery, variants, mediaList);
      if (best) resultMap.set(job.cacheKey, best);
    });
  } catch (e) {
    console.debug("[AniList Batch 오류]", e);
  }

  return resultMap;
}

// 여러 검색 문자열을 GraphQL 한 요청에 묶어 AniList 호출 횟수를 줄인다.
async function searchAniListBest(originalQuery, variants) {
  const vars = variants.slice(0, 6);
  if (!vars.length) return null;

  const declarations = vars.map((_, i) => `$s${i}: String`).join(", ");
  const bodies = vars.map((_, i) => `
    q${i}: Page(page: 1, perPage: 8) {
      media(search: $s${i}) {
        id
        title { romaji english native }
        synonyms
      }
    }
  `).join("\n");

  const graphqlQuery = {
    query: `query (${declarations}) { ${bodies} }`,
    variables: Object.fromEntries(vars.map((v, i) => [`s${i}`, v]))
  };

  try {
    const res = await postAniList(graphqlQuery, 3);

    if (!res || !res.ok) {
      console.debug("[AniList 실패]", originalQuery, res?.status);
      return null;
    }

    const json = await res.json();
    const mediaList = [];
    for (let i = 0; i < vars.length; i++) {
      const items = json?.data?.[`q${i}`]?.media || [];
      mediaList.push(...items);
    }
    return chooseBestAniList(originalQuery, vars, mediaList);
  } catch (e) {
    console.debug("[AniList 오류]", originalQuery, e);
    return null;
  }
}

async function restoreJapaneseAndTranslate(romajiText) {
  const variants = buildRomajiVariants(romajiText);

  for (const variant of variants) {
    try {
      const imeUrl = `https://inputtools.google.com/request?text=${encodeURIComponent(variant)}&itc=ja-t-i0-und&num=5`;
      const res = await fetchWithRetry(imeUrl, {}, 1);
      if (!res || !res.ok) continue;
      const json = await res.json();
      if (json?.[0] !== "SUCCESS" || !Array.isArray(json?.[1])) continue;

      const japanese = json[1]
        .map((segment) => segment?.[1]?.[0] || segment?.[0] || "")
        .join("")
        .trim();

      if (!japanese || japanese.toLowerCase() === variant.toLowerCase()) continue;
      if (!hasJapaneseKana(japanese) && !hasCJK(japanese)) continue;

      const korean = await translateWithGoogle(japanese, "ja");
      if (korean && hasKorean(korean)) {
        return { title: korean, source: "Google-IME", native: japanese };
      }
    } catch (e) {
      console.debug("[IME 오류]", variant, e);
    }
  }

  return null;
}

function buildRomajiVariants(text) {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();

  const stripMacron = lower
    .replace(/[āáàâä]/g, "a")
    .replace(/[īíìîï]/g, "i")
    .replace(/[ūúùûü]/g, "u")
    .replace(/[ēéèêë]/g, "e")
    .replace(/[ōóòôö]/g, "o");

  const expandMacron = lower
    .replace(/[āáàâä]/g, "aa")
    .replace(/[īíìîï]/g, "ii")
    .replace(/[ūúùûü]/g, "uu")
    .replace(/[ēéèêë]/g, "ei")
    .replace(/[ōóòôö]/g, "ou");

  return [...new Set([raw, lower, stripMacron, expandMacron])]
    .map((v) => v.replace(/[._]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function compactCJK(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

function strictLatinWikiMatch(searchWord, pageTitle) {
  const a = normalizeLatin(searchWord);
  const b = normalizeLatin(pageTitle);
  if (!a || !b) return false;
  if (!numbersCompatible(searchWord, pageTitle)) return false;
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  return tokenScore(searchWord, pageTitle) >= 620;
}

// Wikipedia 오탐 방지 버전.
async function searchWikipediaKoStrict(searchWord, expectedNative = null) {
  for (const lang of ["en", "ja"]) {
    try {
      const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchWord)}&srlimit=5&format=json&origin=*`;
      const searchRes = await fetchWithRetry(searchUrl, {}, 1);
      if (!searchRes || !searchRes.ok) continue;
      const searchData = await searchRes.json();
      const results = searchData?.query?.search || [];

      for (const result of results) {
        const pageTitle = result?.title;
        if (!pageTitle) continue;

        let valid = false;
        if (/[A-Za-z]/.test(pageTitle)) {
          valid = strictLatinWikiMatch(searchWord, pageTitle);
        } else if (lang === "ja" && expectedNative) {
          const p = compactCJK(pageTitle);
          const n = compactCJK(expectedNative);
          valid = Boolean(p && n && (p === n || p.includes(n) || n.includes(p)));
        }
        if (!valid) continue;

        const linkUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=langlinks&lllang=ko&format=json&origin=*`;
        const linkRes = await fetchWithRetry(linkUrl, {}, 1);
        if (!linkRes || !linkRes.ok) continue;
        const linkData = await linkRes.json();
        const pages = linkData?.query?.pages;
        if (!pages) continue;

        const pageId = Object.keys(pages)[0];
        const koTitle = pages[pageId]?.langlinks?.[0]?.["*"];
        if (koTitle && hasKorean(koTitle)) {
          return koTitle.replace(/\s*\([^)]*\)\s*/g, " ").trim();
        }
      }
    } catch (e) {
      console.debug(`[Wikipedia ${lang} 오류]`, searchWord, e);
    }
  }
  return null;
}

function shouldPreferNativeTranslation(query, anilist, wikiKo, translatedNative) {
  if (!wikiKo || !translatedNative) return false;

  const hasDetailMarker = /[:：]|\b(?:ii|iii|iv|season|part|hen|arc|world cup|u-?17)\b|\d/i.test(query);
  if (!hasDetailMarker) return false;

  // 원 제목이 상세한데 위키 결과가 지나치게 짧으면 본편명으로 잘린 것으로 본다.
  const sourceLen = normalizeLatin(anilist.romaji || query).replace(/\s/g, "").length;
  const wikiLen = String(wikiKo).replace(/\s/g, "").length;
  const translatedLen = String(translatedNative).replace(/\s/g, "").length;

  if (translatedLen >= wikiLen * 1.45 && sourceLen >= 12) return true;

  // 2기/3기/숫자가 입력에 있는데 위키 결과에 숫자가 사라진 경우
  const nums = numericTokens(query);
  if (nums.length && nums.some((n) => !String(wikiKo).includes(n))) return true;

  return false;
}

async function translateWithGoogle(text, sl = "auto") {
  if (!text) return null;
  if (hasKorean(text) && !hasJapaneseKana(text) && !hasCJK(text)) {
    return cleanupTitle(text);
  }

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=ko&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetchWithRetry(url, {}, 2);
    if (!res || !res.ok) return null;
    const json = await res.json();

    if (Array.isArray(json?.[0])) {
      return cleanupTitle(
        json[0]
          .map((item) => item?.[0] || "")
          .join("")
      );
    }
  } catch (e) {
    console.debug("[Google 번역 오류]", text, e);
  }
  return null;
}

function looksLikeUntranslatedRomanization(source, translated) {
  const a = normalizeLatin(source).replace(/\s/g, "");
  const b = normalizeLatin(translated).replace(/\s/g, "");
  return Boolean(a && b && (a === b || (a.length > 5 && b.includes(a))));
}
