// workspace.js —— 设置 / 最近文件 / 崩溃草稿：localStorage 持久化。
// Tauri(WebView2) 的 localStorage 存在用户数据目录，随应用安装存续，重启可读。
const SETTINGS_KEY = "tl-settings";
const RECENT_KEY = "tl-recent";
const DRAFT_KEY = "tl-draft";

const DEFAULT_SETTINGS = { theme: "auto", autosave: false };

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
}
export function saveRecent(list) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
}

export function loadDraft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY));
  } catch {
    return null;
  }
}
export function saveDraft(draft) {
  // localStorage 配额 ~5MB：大文档/含 data URL 图片时可能超限，
  // 失败静默放弃本轮草稿（load 侧已有 try/catch）
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* 配额超限，跳过本轮 */
  }
}
export function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}
