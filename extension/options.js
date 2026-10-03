const enabledEl = document.getElementById("enabled");
const enabledText = document.getElementById("enabledText");
const sitesList = document.getElementById("sitesList");
const siteInput = document.getElementById("siteInput");
const addSiteBtn = document.getElementById("addSiteBtn");
const selectAllSitesBtn = document.getElementById("selectAllSitesBtn");
const deleteSelectedSitesBtn = document.getElementById("deleteSelectedSitesBtn");
const deleteAllSitesBtn = document.getElementById("deleteAllSitesBtn");
const rulesContainer = document.getElementById("rulesContainer");
const addRuleBtn = document.getElementById("addRuleBtn");
const clearRulesBtn = document.getElementById("clearRulesBtn");
const saveBtn = document.getElementById("saveBtn");
const statusMsg = document.getElementById("statusMsg");
const clearCacheBtn = document.getElementById("clearCacheBtn");
const tabButtons = [...document.querySelectorAll(".tab-btn")];
const tabPanels = [...document.querySelectorAll(".tab-panel")];

let dirty = false;
let savedSites = [];

function setStatus(text, isError = false) {
  statusMsg.textContent = text;
  statusMsg.classList.toggle("error", isError);
  if (text) {
    clearTimeout(setStatus.timer);
    setStatus.timer = setTimeout(() => {
      statusMsg.textContent = "";
      statusMsg.classList.remove("error");
    }, 2600);
  }
}

function setDirty(value = true) {
  dirty = value;
  saveBtn.disabled = !dirty;
}

function updateEnabledLabel() {
  enabledText.textContent = enabledEl.checked ? "켜짐" : "꺼짐";
}

function activateTab(tabName) {
  clearCacheBtn?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "clearTranslationCache" }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      setStatus("번역 캐시 삭제에 실패했습니다.", true);
      return;
    }
    setStatus("브라우저에 저장된 번역 캐시를 삭제했습니다.");
  });
});

tabButtons.forEach((button) => {
    const active = button.dataset.tab === tabName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  tabPanels.forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === tabName));
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

  if (!value) return "";

  try {
    const host = new URL(`https://${value}`).hostname.toLowerCase();
    if (!host || host.includes(" ")) return "";
    return host;
  } catch (_) {
    return "";
  }
}

function sitePatterns(domain) {
  return [`https://*.${domain}/*`];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function createSiteRow(domain) {
  const row = document.createElement("div");
  row.className = "site-row";
  row.innerHTML = `
    <input type="checkbox" class="site-select" aria-label="사이트 선택">
    <input type="text" class="site-domain" value="${escapeHtml(domain)}" spellcheck="false">
    <button type="button" class="icon-btn danger remove-site" title="삭제">✕</button>
  `;

  const input = row.querySelector(".site-domain");
  input.addEventListener("input", () => setDirty());
  input.addEventListener("blur", () => {
    const normalized = normalizeDomain(input.value);
    if (normalized) input.value = normalized;
  });
  row.querySelector(".remove-site").addEventListener("click", () => {
    row.remove();
    renderSitesEmpty();
    setDirty();
  });

  sitesList.appendChild(row);
}

function renderSitesEmpty() {
  const hasRows = sitesList.querySelector(".site-row");
  const existing = sitesList.querySelector(".empty");
  if (!hasRows && !existing) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "등록된 사이트가 없습니다.";
    sitesList.appendChild(empty);
  } else if (hasRows && existing) {
    existing.remove();
  }
}

function addSite() {
  const domain = normalizeDomain(siteInput.value);
  if (!domain) {
    setStatus("도메인 형식으로 입력해주세요. 예: anime.example.com", true);
    siteInput.focus();
    return;
  }

  const current = collectSites(false);
  if (current.includes(domain)) {
    setStatus("이미 등록된 사이트입니다.", true);
    return;
  }

  sitesList.querySelector(".empty")?.remove();
  createSiteRow(domain);
  siteInput.value = "";
  setDirty();
}

function collectSites(validate = true) {
  const rows = [...sitesList.querySelectorAll(".site-row")];
  const result = [];
  for (const row of rows) {
    const input = row.querySelector(".site-domain");
    const domain = normalizeDomain(input.value);
    if (!domain) {
      if (validate) throw new Error("사이트 주소에 올바르지 않은 값이 있습니다.");
      continue;
    }
    input.value = domain;
    if (!result.includes(domain)) result.push(domain);
  }
  return result;
}

function createRuleRow(from = "", to = "") {
  const row = document.createElement("div");
  row.className = "rule-row";
  row.innerHTML = `
    <input type="text" class="from-text" placeholder="원래 문장/단어" value="${escapeHtml(from)}">
    <input type="text" class="to-text" placeholder="변경할 한글" value="${escapeHtml(to)}">
    <button type="button" class="icon-btn danger remove-rule" title="삭제">✕</button>
  `;
  row.querySelectorAll("input").forEach((el) => el.addEventListener("input", () => setDirty()));
  row.querySelector(".remove-rule").addEventListener("click", () => {
    row.remove();
    renderRulesEmpty();
    setDirty();
  });
  rulesContainer.appendChild(row);
}

function renderRulesEmpty() {
  const hasRows = rulesContainer.querySelector(".rule-row");
  const existing = rulesContainer.querySelector(".empty");
  if (!hasRows && !existing) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "등록된 치환 단어가 없습니다.";
    rulesContainer.appendChild(empty);
  } else if (hasRows && existing) {
    existing.remove();
  }
}

function collectRules() {
  const rules = [];
  for (const row of rulesContainer.querySelectorAll(".rule-row")) {
    const from = row.querySelector(".from-text").value.trim();
    const to = row.querySelector(".to-text").value.trim();
    if (!from && !to) continue;
    if (!from || !to) throw new Error("치환 단어는 원문과 변경할 한글을 모두 입력해주세요.");
    rules.push({ from, to });
  }
  return rules;
}

function getLegacySites(data) {
  const direct = Array.isArray(data.sites) ? data.sites : [];
  if (direct.length) return direct;

  const legacyTarget = normalizeDomain(data.targetDomain || "");
  const autoSites = Array.isArray(data.autoSites) ? data.autoSites : [];
  const manualSites = Array.isArray(data.manualSites) ? data.manualSites : [];
  const merged = [...autoSites, ...manualSites, legacyTarget]
    .map(normalizeDomain)
    .filter(Boolean);

  return [...new Set(merged)];
}

async function requestSitePermissions(domains) {
  const origins = [...new Set(domains.flatMap(sitePatterns))];
  if (!origins.length) return true;
  return new Promise((resolve) => {
    chrome.permissions.request({ origins }, (granted) => {
      if (chrome.runtime.lastError) {
        console.warn(chrome.runtime.lastError.message);
        resolve(false);
        return;
      }
      resolve(Boolean(granted));
    });
  });
}

async function removeUnusedPermissions(previousDomains, nextDomains) {
  const next = new Set(nextDomains);
  const removed = previousDomains.filter((domain) => !next.has(domain));
  if (!removed.length) return;
  const origins = [...new Set(removed.flatMap(sitePatterns))];
  try {
    await chrome.permissions.remove({ origins });
  } catch (_) {}
}

function refreshContentScripts() {
  chrome.runtime.sendMessage({ action: "refreshContentScripts" }, () => {
    void chrome.runtime.lastError;
  });
}

function applySettingsToOpenTabs(previousSites, sites, enabled = enabledEl.checked) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      action: "applySettingsToOpenTabs",
      previousSites: Array.isArray(previousSites) ? previousSites : [],
      sites: Array.isArray(sites) ? sites : [],
      enabled
    }, (response) => {
      const error = chrome.runtime.lastError;
      resolve({ response, error });
    });
  });
}

chrome.storage.sync.get(
  ["enabled", "sites", "rules", "autoSites", "manualSites", "targetDomain"],
  (data) => {
    enabledEl.checked = data.enabled === true;
    updateEnabledLabel();

    const sites = getLegacySites(data);
    [...new Set(sites.map(normalizeDomain).filter(Boolean))].forEach(createSiteRow);
    renderSitesEmpty();

    const rules = Array.isArray(data.rules) ? data.rules : [];
    rules.forEach((rule) => createRuleRow(rule.from || "", rule.to || ""));
    renderRulesEmpty();

    savedSites = [...new Set(sites.map(normalizeDomain).filter(Boolean))];
    setDirty(false);
  }
);

// 토글은 저장 버튼 상태와 무관하게 즉시 반영한다.
// 현재 열려 있는 적용 사이트에도 content.js를 주입/정리하여 새로고침이 필요 없게 한다.
enabledEl.addEventListener("change", () => {
  const nextEnabled = enabledEl.checked;
  if (nextEnabled && savedSites.length === 0) {
    enabledEl.checked = false;
    updateEnabledLabel();
    setStatus("먼저 적용 사이트를 추가하고 저장해주세요.", true);
    activateTab("sites");
    return;
  }

  updateEnabledLabel();
  chrome.storage.sync.set({ enabled: nextEnabled }, async () => {
    if (chrome.runtime.lastError) {
      setStatus("기능 상태 변경에 실패했습니다.", true);
      return;
    }
    await applySettingsToOpenTabs(savedSites, savedSites, nextEnabled);
    setStatus(nextEnabled ? "기능이 현재 열린 페이지에 즉시 활성화되었습니다." : "기능이 현재 열린 페이지에서 즉시 비활성화되었습니다.");
  });
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tab));
});

addSiteBtn.addEventListener("click", addSite);
siteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSite();
});

selectAllSitesBtn.addEventListener("click", () => {
  const rows = [...sitesList.querySelectorAll(".site-row")];
  const shouldCheck = rows.some((row) => !row.querySelector(".site-select").checked);
  rows.forEach((row) => { row.querySelector(".site-select").checked = shouldCheck; });
});

deleteSelectedSitesBtn.addEventListener("click", () => {
  const selected = [...sitesList.querySelectorAll(".site-row")]
    .filter((row) => row.querySelector(".site-select").checked);
  if (!selected.length) {
    setStatus("삭제할 사이트를 선택해주세요.", true);
    return;
  }
  selected.forEach((row) => row.remove());
  renderSitesEmpty();
  setDirty();
});

deleteAllSitesBtn.addEventListener("click", () => {
  sitesList.querySelectorAll(".site-row").forEach((row) => row.remove());
  renderSitesEmpty();
  setDirty();
});

addRuleBtn.addEventListener("click", () => {
  rulesContainer.querySelector(".empty")?.remove();
  createRuleRow();
  setDirty();
});

clearRulesBtn.addEventListener("click", () => {
  rulesContainer.querySelectorAll(".rule-row").forEach((row) => row.remove());
  renderRulesEmpty();
  setDirty();
});

saveBtn.addEventListener("click", async () => {
  if (!dirty) return;

  let sites;
  let rules;
  try {
    sites = collectSites();
    rules = collectRules();
  } catch (error) {
    setStatus(error.message, true);
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "권한 확인 중...";

  const granted = await requestSitePermissions(sites);
  if (!granted) {
    saveBtn.textContent = "변경사항 저장";
    saveBtn.disabled = false;
    setStatus("사이트 접근 권한이 허용되지 않아 저장하지 않았습니다.", true);
    return;
  }

  const previousSites = [...savedSites];

  chrome.storage.sync.set({ sites, rules }, async () => {
    if (chrome.runtime.lastError) {
      saveBtn.textContent = "변경사항 저장";
      saveBtn.disabled = false;
      setStatus("설정 저장에 실패했습니다.", true);
      return;
    }

    // 새 사이트 권한이 살아 있고, 제거된 사이트 권한도 아직 남아 있는 시점에
    // 열린 탭을 먼저 갱신한다. 그래서 추가/삭제 모두 새로고침이 필요 없다.
    await applySettingsToOpenTabs(previousSites, sites, enabledEl.checked);

    // v5.4까지 사용한 분리 설정을 제거한다.
    chrome.storage.sync.remove(["autoSites", "manualSites", "targetDomain"]);

    await removeUnusedPermissions(previousSites, sites);
    savedSites = [...sites];
    refreshContentScripts();
    setDirty(false);
    saveBtn.textContent = "변경사항 저장";
    setStatus("저장되었습니다. 현재 열려 있는 페이지에도 즉시 반영되었습니다.");
  });
});
