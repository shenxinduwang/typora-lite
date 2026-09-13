// main.js —— 组装编辑器 + 文件读写(编码/行尾记忆) + 快捷键 + 脏标记
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown"; // 表格 / 删除线 / 任务列表 / 自动链接
import { languages } from "@codemirror/language-data"; // 代码块按语言标签着色（懒加载）
import { syntaxHighlighting, defaultHighlightStyle, syntaxTree } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";

import { liveMarkdown, baseTheme, setImagePathResolver, clearImageCache } from "./liveMarkdown.js";
import { indentList, outdentList } from "./listEditing.js";
import { collectOutline } from "./outline.js";
import { loadSettings, saveSettings, loadRecent, saveRecent, loadDraft, saveDraft, clearDraft } from "./workspace.js";
import "./style.css";

const IS_TAURI =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

const DOC = `# Typora-Lite

用 **打字即渲染** 的方式写 Markdown：光标离开这一行，标记就自动隐藏。

## 支持
- 标题：# 到 ######（点进本行可看到井号）
- 粗体 **bold**、斜体 *italic*、删除线 ~~gone~~、行内 \`code\`
- 任务列表（GFM）：
  - [x] 已完成项
  - [ ] 未完成项
- 表格（GFM）：

| 语法 | 状态 |
| ---- | ---- |
| 表格 | 已解析 |
| 公式 | 待接入 |

- 引用：
> 这是一段引用
- 代码块：
\`\`\`js
const a = 1;
\`\`\`

---

把光标移到上面的 *斜体* 或 # 标题里，标记会显示出来方便编辑。
`;

let currentPath = null; // 仅 Tauri 下有真实路径
let currentBrowserName = null; // 浏览器模式记住打开的文件名，保存下载时沿用
// 脏判定快照：CM 文档模型永远是 LF，所以把“上次保存内容”也归一成 LF 缓存住，
// 每次按键只做一次字符串比较，不再对全文跑正则、不再重复物化第二份字符串。
let lastSavedNorm = "";
let originalEolCRLF = false; // 原文件是否 CRLF，保存时还原行尾，避免悄悄改写
// 原文件编码（utf8 / utf8bom / utf16le / utf16be / gbk），Rust 端保存时按它写回
let originalEncoding = "utf8";

const filenameEl = document.getElementById("filename");

function normEol(s) {
  return s.replace(/\r\n?/g, "\n");
}

function docText() {
  return view.state.doc.toString();
}
function isDirty() {
  return docText() !== lastSavedNorm;
}

// 统一的文档载入入口：整体重建编辑器状态。
// 必须用 setState 而不是 dispatch 换文本——后者会记进撤销历史，
// Ctrl+Z 能一路“撤销回上一个文件”，窗口路径与实际内容就错位了。
function applyLoadedText(text, path, encoding) {
  originalEncoding = encoding || "utf8";
  originalEolCRLF = text.includes("\r\n");
  currentPath = path;
  if (path) currentBrowserName = null;
  lastSavedNorm = normEol(text);
  view.setState(EditorState.create({ doc: text, extensions: baseExtensions }));
  clearDraft(); // 载入的内容即当前真相，旧草稿作废（恢复草稿的流程会重新写回）
  clearImageCache(); // 换文档：图片缓存按文档隔离，避免跨目录同名 rel 串图
  refreshLabel();
}

// 所有可预期的失败（文件不存在、非 UTF-8、只读盘、权限等）都要弹出来，
// 不能只 console.error——用户视角就是“点了没反应”。
async function showErr(title, detail) {
  console.error(title, detail);
  try {
    if (IS_TAURI) {
      const { message } = await import("@tauri-apps/plugin-dialog");
      await message(String(detail), { title, kind: "error" });
    } else {
      window.alert(`${title}\n${detail}`);
    }
  } catch {
    /* 弹窗失败就只留日志 */
  }
}

let lastTitle = "";
function refreshLabel() {
  const dirty = isDirty();
  const name = currentPath
    ? currentPath.split(/[\\/]/).pop()
    : currentBrowserName || "未命名.md";
  const label = `${name}${dirty ? " •" : ""}`;
  if (filenameEl.textContent !== label) filenameEl.textContent = label;
  const title = `${label} — Typora-Lite`;
  if (title === lastTitle) return; // 标题没变就不碰 DOM/IPC（否则打字每键一次 setTitle）
  lastTitle = title;
  document.title = title;
  if (IS_TAURI) {
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().setTitle(title).catch(() => {})
      )
      .catch(() => {});
  }
}

// 每键都会 docChanged；把 UI 刷新合帧到 rAF，大文档下也不会每键多次 O(n)
let labelQueued = false;
function queueLabel() {
  if (labelQueued) return;
  labelQueued = true;
  requestAnimationFrame(() => {
    labelQueued = false;
    refreshLabel();
  });
}

async function doLoadFile(path) {
  if (!path) return;
  // 同一个文件且没有改动：不要重新载入，避免重置光标/滚动位置
  if (path === currentPath && !isDirty()) {
    view.focus();
    return;
  }
  if (!(await confirmDiscard())) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const res = await invoke("read_text_file", { path }); // -> { text, encoding }
    applyLoadedText(res.text, path, res.encoding);
    pushRecent(path);
    if (IS_TAURI) {
      lastKnownMtime = await invoke("file_mtime_ms", { path }).catch(() => null);
    }
  } catch (e) {
    await showErr("打开失败", e);
  }
  view.focus();
}

// loadFile 串行化：连开的请求（单实例转发连发、启动 pending 队列与 open-file
// 事件叠加、双击连点）原本会并发交错，最后一个 applyLoadedText 任意覆盖先到的。
// 排进 promise 链逐个执行，脏确认对话框也天然逐个弹、不会叠加
let loadChain = Promise.resolve();
function loadFile(path) {
  const run = loadChain.then(() => doLoadFile(path));
  loadChain = run.catch(() => {}); // 链条不吃异常：单次失败不断后续
  return run.catch(() => {});
}

async function openFile() {
  try {
    if (IS_TAURI) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
      });
      if (!path) return;
      await loadFile(path); // 脏标记确认在 loadFile 内做
      return;
    }
    if (!(await confirmDiscard())) return;
    const picked = await pickBrowserFile();
    if (!picked) return;
    applyLoadedText(picked.text, null, picked.encoding);
    currentBrowserName = picked.name;
    refreshLabel();
  } catch (e) {
    await showErr("打开失败", e);
  } finally {
    view.focus(); // 点完工具栏把焦点还给编辑器，否则键盘输入“失灵”
  }
}

async function saveFile() {
  if (saving) return;
  saving = true;
  try {
    const text = docText();
    const body = originalEolCRLF ? text.replace(/\n/g, "\r\n") : text;
    if (IS_TAURI) {
      const { invoke } = await import("@tauri-apps/api/core");
      let path = currentPath;
      if (!path) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        path = await save({
          defaultPath: "未命名.md",
          filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
        });
        if (!path) return;
      }
      // 写盘期间挡住 mtime 轮询，避免"自己写完 → mtime 已变但基准未更新"的
      // 竞态窗口误弹"文件已被外部修改"。注意：标志要覆盖到下面刷新
      // lastKnownMtime 为止——提前释放的话，3s 轮询若恰好在写盘完成与
      // mtime 基准更新之间的 IPC 往返里触发，仍会误报。统一在外层 finally 释放
      selfWriting = true;
      let status;
      status = await invoke("write_text_file", {
        path,
        contents: body,
        encoding: originalEncoding,
      });
      if (status && status.unmappable) {
        // GBK 编不下 emoji/生僻字：encoding_rs 会写成 &#数字; 乱码，引导改存 UTF-8
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        const switchUtf8 = await confirm(
          "文档含有 GBK 无法表示的字符（如 emoji、部分生僻字），按 GBK 保存会产生乱码。改用 UTF-8 编码保存吗？",
          { title: "编码不兼容", kind: "warning" }
        );
        if (!switchUtf8) return;
        originalEncoding = "utf8";
        status = await invoke("write_text_file", {
          path,
          contents: body,
          encoding: "utf8",
        });
      }
      if (!status || !status.saved) return;
      currentPath = path;
      pushRecent(path);
      lastKnownMtime = await invoke("file_mtime_ms", { path }).catch(() => null);
    } else {
      // 浏览器兜底只有 UTF-8 编码器：按原文件是否带 BOM 补回，其余统一存 UTF-8
      downloadBrowser(encodeBrowser(body), currentBrowserName || "未命名.md");
    }
    lastSavedNorm = normEol(body); // 写盘成功后才更新快照
    clearDraft(); // 已落盘，草稿作废
  } catch (e) {
    await showErr("保存失败", e);
    return;
  } finally {
    selfWriting = false;
    saving = false;
    view.focus();
  }
  refreshLabel();
}

async function newFile() {
  if (!(await confirmDiscard())) return;
  currentPath = null;
  currentBrowserName = null;
  lastSavedNorm = "";
  originalEolCRLF = false;
  originalEncoding = "utf8";
  view.setState(EditorState.create({ doc: "", extensions: baseExtensions }));
  clearDraft();
  clearImageCache();
  refreshLabel();
  view.focus();
}

async function confirmDiscard() {
  if (!isDirty()) return true;
  const msg = "当前文档有未保存的改动，确定丢弃？";
  if (IS_TAURI) {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return await confirm(msg, { title: "未保存", kind: "warning" });
  }
  return window.confirm(msg);
}

// 关窗拦截（Tauri）：干净直接放行；脏则给“保存并退出 / 放弃修改 / 取消”。
// 保存失败（只读盘等）会留在编辑器里，不让用户以为存上了。
async function handleCloseRequested(event) {
  if (!isDirty()) return;
  const { confirm } = await import("@tauri-apps/plugin-dialog");
  if (
    await confirm("当前文档有未保存的改动，保存并退出？", {
      title: "未保存",
      kind: "warning",
    })
  ) {
    await saveFile();
    if (!isDirty()) return;
    event.preventDefault();
    return;
  }
  if (await confirm("确定放弃修改并直接退出？", { title: "放弃修改", kind: "warning" }))
    return;
  event.preventDefault();
}

// 解码本地字节：按 BOM 识别 UTF-8/UTF-16，UTF-8 严格校验失败回退 GBK（与 Rust decode_bytes 对应）
function decodeBrowserBytes(bytes) {
  let encoding = "utf8";
  let payload = bytes;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = "utf8bom";
    payload = bytes.subarray(3);
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf16le";
    payload = bytes.subarray(2);
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf16be";
    payload = bytes.subarray(2);
  }
  let text;
  if (encoding === "utf16le" || encoding === "utf16be") {
    text = new TextDecoder(encoding).decode(payload);
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    } catch {
      encoding = "gbk";
      text = new TextDecoder("gbk").decode(payload);
    }
  }
  return { text, encoding };
}

function pickBrowserFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.txt";
    input.oncancel = () => resolve(null);
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return resolve(null);
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        resolve({ name: f.name, ...decodeBrowserBytes(bytes) });
      } catch (e) {
        console.error("读取本地文件失败:", e);
        resolve(null);
      }
    };
    input.click();
  });
}

function encodeBrowser(text) {
  const utf8 = new TextEncoder().encode(text);
  return originalEncoding === "utf8bom"
    ? new Uint8Array([0xef, 0xbb, 0xbf, ...utf8])
    : utf8;
}

function downloadBrowser(bytes, name) {
  const blob = new Blob([bytes], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const startKeymap = keymap.of([
  { key: "Mod-s", run: () => (saveFile(), true) },
  { key: "Mod-o", run: () => (openFile(), true) },
  { key: "Mod-n", run: () => (newFile(), true) },
  { key: "Mod-Shift-o", run: () => (setOutlineOpen(!outlineOpen), true) },
]);

// ---- 大纲侧栏：长文目录，点击跳转、跟随光标高亮当前章节 ----
const outlinePanel = document.getElementById("outline");
const outlineList = document.getElementById("outline-list");
let outlineOpen = false;
let outlineEntries = [];
let outlineTimer = null;

function setOutlineOpen(open) {
  outlineOpen = open;
  outlinePanel.classList.toggle("hidden", !open);
  document.getElementById("btn-outline").classList.toggle("active", open);
  if (open) {
    rebuildOutline();
    updateOutlineActive();
  }
}

function rebuildOutline() {
  if (!outlineOpen) return;
  outlineEntries = collectOutline(view.state);
  outlineList.textContent = "";
  if (!outlineEntries.length) {
    const empty = document.createElement("div");
    empty.className = "ol-empty";
    empty.textContent = "暂无标题，用 # 开始写作";
    outlineList.appendChild(empty);
    return;
  }
  for (const e of outlineEntries) {
    const item = document.createElement("div");
    item.className = `ol-item ol-l${e.level}`;
    item.textContent = e.text;
    item.title = e.text;
    item.addEventListener("click", () => {
      view.dispatch({
        selection: { anchor: e.from },
        effects: EditorView.scrollIntoView(e.from, { y: "start", yMargin: 32 }),
      });
      view.focus();
    });
    outlineList.appendChild(item);
  }
  updateOutlineActive(); // 条目可能变化，重建后重算高亮
}

// 只找"光标之前最近的标题"，改 class 不重建 DOM，选区变化零开销
function updateOutlineActive() {
  if (!outlineOpen) return;
  const head = view.state.selection.main.head;
  let activeIdx = -1;
  for (let i = 0; i < outlineEntries.length; i++) {
    if (outlineEntries[i].from <= head) activeIdx = i;
    else break;
  }
  [...outlineList.children].forEach((el, i) => {
    el.classList.toggle("active", i === activeIdx);
  });
  const activeEl = outlineList.children[activeIdx];
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

// 打字防抖重建大纲；ensureSyntaxTree 全文解析在 500ms 空闲后做，不卡每键
function scheduleOutlineRebuild() {
  if (!outlineOpen) return;
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(rebuildOutline, 500);
}

// ---- 设置 / 主题切换（自动跟随系统 → 亮 → 暗 循环）----
// data-theme 由 JS 统一写入：auto 模式下监听系统偏好变化实时翻转
const settings = loadSettings();
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
const THEME_LABELS = { auto: "主题：自动", light: "主题：亮", dark: "主题：暗" };

function applyTheme() {
  const mode =
    settings.theme === "auto" ? (themeMedia.matches ? "dark" : "light") : settings.theme;
  document.documentElement.dataset.theme = mode;
  document.getElementById("btn-theme").textContent = THEME_LABELS[settings.theme];
}

function cycleTheme() {
  settings.theme =
    settings.theme === "auto" ? "light" : settings.theme === "light" ? "dark" : "auto";
  saveSettings(settings);
  applyTheme();
}
themeMedia.addEventListener("change", () => {
  if (settings.theme === "auto") applyTheme();
});

// ---- 最近文件（仅 Tauri 有真实路径）----
let recentFiles = loadRecent();
// null = 尚未知（读取失败过）：轮询首次拿到值时先采纳，不触发"外部修改"判定
let lastKnownMtime = null;
let selfWriting = false; // 自己正在写盘：mtime 轮询跳过，防竞态误报
let saving = false; // 保存进行中：挡住 Ctrl+S 连按/30s 自动保存重入（Rust 端同名 tmp 文件会互踩）

function pushRecent(path) {
  if (!path) return;
  const name = path.split(/[\\/]/).pop();
  recentFiles = [{ path, name }, ...recentFiles.filter((r) => r.path !== path)].slice(0, 10);
  saveRecent(recentFiles);
}
function removeRecent(path) {
  recentFiles = recentFiles.filter((r) => r.path !== path);
  saveRecent(recentFiles);
}

function renderRecentMenu() {
  const menu = document.getElementById("recent-menu");
  menu.textContent = "";
  if (!recentFiles.length) {
    const empty = document.createElement("div");
    empty.className = "rm-item rm-empty";
    empty.textContent = "暂无最近文件";
    menu.appendChild(empty);
    return;
  }
  for (const r of recentFiles) {
    const item = document.createElement("div");
    item.className = "rm-item";
    item.textContent = r.name;
    item.title = r.path;
    item.addEventListener("click", () => {
      toggleRecentMenu(false);
      loadFile(r.path);
    });
    menu.appendChild(item);
  }
  const clear = document.createElement("div");
  clear.className = "rm-item rm-clear";
  clear.textContent = "清空最近文件";
  clear.addEventListener("click", () => {
    recentFiles = [];
    saveRecent(recentFiles);
    toggleRecentMenu(false);
  });
  menu.appendChild(clear);
}

function toggleRecentMenu(show) {
  const menu = document.getElementById("recent-menu");
  const btn = document.getElementById("btn-recent");
  const willShow = show ?? menu.classList.contains("hidden");
  if (willShow) {
    renderRecentMenu();
    const rect = btn.getBoundingClientRect();
    menu.style.left = `${Math.max(8, rect.left)}px`;
    menu.style.top = `${rect.bottom + 6}px`;
  }
  menu.classList.toggle("hidden", !willShow);
}

// ---- 崩溃草稿：脏文档每 3s 落 localStorage，保存/载入/新建即清 ----
// 编码/行尾要一起记：恢复后保存才能按原格式写回，否则 GBK/CRLF 文件被悄悄转成 UTF-8/LF
function saveDraftNow() {
  const text = docText();
  if (!isDirty() || (!text && !currentPath)) return;
  saveDraft({
    text,
    path: currentPath,
    encoding: originalEncoding,
    eolCRLF: originalEolCRLF,
    savedAt: Date.now(),
  });
}

// 编辑器扩展集提出来共用：载入/新建文件时要整体重建 EditorState（见 applyLoadedText）
const baseExtensions = [
  drawSelection(),
  history(),
  closeBrackets(),
  // 查找/替换：面板置顶，Ctrl+F 打开、Enter/Shift+Enter 上下导航、Esc 关闭
  search({ top: true }),
  highlightSelectionMatches(),
  EditorView.lineWrapping,
  markdown({ extensions: GFM, codeLanguages: languages }),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  liveMarkdown,
  baseTheme,
  EditorView.domEventHandlers({ mousedown: handleMouseDown, paste: handlePaste }),
  EditorView.updateListener.of((u) => {
    if (u.docChanged) {
      queueLabel();
      scheduleOutlineRebuild();
    }
    if (u.selectionSet) updateOutlineActive();
  }),
  keymap.of([
    ...closeBracketsKeymap,
    ...searchKeymap,
    // 列表 Tab/Shift+Tab 缩进（Enter 续写由 lang-markdown 内建 Prec.high 提供）
    { key: "Tab", run: indentList },
    { key: "S-Tab", run: outdentList },
    ...defaultKeymap,
    ...historyKeymap,
    indentWithTab,
  ]),
  startKeymap,
];

const view = new EditorView({
  parent: document.getElementById("editor"),
  state: EditorState.create({
    doc: DOC,
    extensions: baseExtensions,
  }),
});

// 点击任务列表复选框（[ ] ↔ [x]）：从被点的 widget DOM 反查精确文档位置再切换源码。
// 关键：replace 型 widget 无文本宽度，posAtCoords 会跨行错位；posAtDOM 才可靠。
function handleTaskClick(event, v) {
  if (event.button !== 0) return false;
  const box =
    event.target && event.target.closest && event.target.closest(".cm-taskbox");
  if (!box) return false;
  const pos = v.posAtDOM(box, 0); // widget 起点 == TaskMarker.from
  if (pos == null) return false;
  const line = v.state.doc.lineAt(pos);
  let hit = null;
  syntaxTree(v.state).iterate({
    from: line.from,
    to: line.to,
    enter(n) {
      if (n.name === "TaskMarker" && pos >= n.from && pos <= n.to) {
        hit = { from: n.from, to: n.to };
      }
    },
  });
  if (!hit) return false;
  const cur = v.state.sliceDoc(hit.from, hit.to); // "[ ]" / "[x]" / "[X]"
  if (!/^\[[ xX]\]$/.test(cur)) return false;
  const next = /[xX]/.test(cur) ? "[ ]" : "[x]";
  v.dispatch({
    changes: { from: hit.from, to: hit.to, insert: next },
  });
  event.preventDefault();
  return true;
}

// Ctrl/Cmd+点击链接：用系统默认程序打开（URL 白名单在 Rust 端校验）
function handleLinkClick(event, v) {
  if (!(event.ctrlKey || event.metaKey)) return false;
  const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return false;
  let url = null;
  syntaxTree(v.state).iterate({
    from: Math.max(0, pos - 1),
    to: Math.min(v.state.doc.length, pos + 1),
    enter(n) {
      if (pos < n.from || pos > n.to) return;
      if (n.name === "Link") {
        const m = /\]\(([^)\s]+)/.exec(v.state.sliceDoc(n.from, n.to));
        if (m) url = m[1];
      } else if (n.name === "URL" && !url) {
        url = v.state.sliceDoc(n.from, n.to);
      }
    },
  });
  if (!url || !/^(https?:\/\/|mailto:)/i.test(url)) return false;
  event.preventDefault();
  if (!IS_TAURI) {
    // 浏览器兜底：没有 Rust open_external，直接开新标签（noopener 防 opener 攻击）
    window.open(url, "_blank", "noopener");
    return true;
  }
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("open_external", { url }))
    .catch((e) => showErr("打开链接失败", e));
  return true;
}

// mousedown 总入口：Ctrl/Cmd+点链接优先，其次任务复选框
function handleMouseDown(event, v) {
  if ((event.ctrlKey || event.metaKey) && handleLinkClick(event, v)) return true;
  return handleTaskClick(event, v);
}

document.getElementById("btn-new").onclick = newFile;
document.getElementById("btn-open").onclick = openFile;
document.getElementById("btn-save").onclick = saveFile;
document.getElementById("btn-outline").onclick = () => setOutlineOpen(!outlineOpen);
document.getElementById("btn-theme").onclick = cycleTheme;

setImagePathResolver(() => currentPath); // 图片预览解析相对 assets 路径用
applyTheme();
lastSavedNorm = normEol(DOC);
refreshLabel();

// 启动顺序很关键：先订阅 open-file（越早越好），再取启动参数文件。
// 但「订阅完成之前」单实例插件转发的 emit 依然会丢，所以 Rust 端还会把
// 路径塞进 pending 队列，这里订阅完成后主动取一次，彻底兜住竞态窗口。
if (IS_TAURI) {
  (async () => {
    // 启动竞态缓冲（声明在 try 外，初始化失败时 catch 兜底排空）：
    // 启动流程（崩溃恢复确认框等 await 期间事件循环照常处理）里收到的
    // open-file 事件先攒进 startupPending，流程结束后统一载入——否则事件
    // 触发的 loadFile 会被恢复分支的 applyLoadedText 静默覆盖（或反之），
    // 属数据覆盖级竞态而非窄窗口
    const startupPending = [];
    let startupDone = false;
    try {
      const [{ invoke }, { listen }, { confirm }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/event"),
        import("@tauri-apps/plugin-dialog"),
      ]);
      await listen("open-file", (e) => {
        if (startupDone) loadFile(e.payload);
        else startupPending.push(e.payload);
      });

      // 崩溃草稿优先处理。恢复后必须以"磁盘内容"为已保存基准——applyLoadedText
      // 会把草稿文本当成已保存内容并清掉草稿，若不重设基准，恢复出的未保存内容
      // 会被判为"干净"：关窗不拦、草稿也不再重写，等于二次丢数据
      let restoredDraft = false;
      const draft = loadDraft();
      if (draft && draft.text) {
        const when = new Date(draft.savedAt).toLocaleString();
        restoredDraft = await confirm(`检测到未保存的草稿（${when}），是否恢复？`, {
          title: "崩溃恢复",
          kind: "warning",
        });
      }
      const launchPath = await invoke("take_launch_file"); // 始终取，恢复草稿≠放弃双击
      if (restoredDraft) {
        applyLoadedText(draft.text, draft.path || null, draft.encoding || "utf8");
        originalEolCRLF = !!draft.eolCRLF; // applyLoadedText 会从文本推断行尾，草稿是 LF 归一的，需显式还原
        if (draft.path) {
          pushRecent(draft.path);
          try {
            const disk = await invoke("read_text_file", { path: draft.path });
            lastSavedNorm = normEol(disk.text); // 草稿内容 ≠ 磁盘内容 → 正确显示"脏"
          } catch {
            lastSavedNorm = ""; // 文件已被删除 → 必脏
          }
          lastKnownMtime = await invoke("file_mtime_ms", { path: draft.path }).catch(
            () => null
          );
        } else {
          lastSavedNorm = ""; // 无路径草稿 → 必脏
        }
        refreshLabel();
        if (launchPath && launchPath !== draft.path) {
          await loadFile(launchPath); // 双击的是另一个文件：正常载入（脏确认会拦）
        }
      } else {
        clearDraft();
        if (launchPath) {
          await loadFile(launchPath); // 首帧是干净的示例内容，不会弹确认
        } else if (recentFiles.length) {
          // 无启动参数：静默恢复上次文档；文件已被删除则从最近列表剔除
          const last = recentFiles[0];
          if (await invoke("path_exists", { path: last.path })) {
            await loadFile(last.path);
          } else {
            removeRecent(last.path);
          }
        }
      }
      startupDone = true;
      const pending = await invoke("take_pending_files");
      for (const p of [...(pending || []), ...startupPending]) await loadFile(p);
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      getCurrentWindow().onCloseRequested(handleCloseRequested);
    } catch (e) {
      console.error("Tauri 初始化失败:", e);
      startupDone = true; // 兜底：初始化失败后事件直通 loadFile，别让缓冲无限堆积
      for (const p of startupPending) loadFile(p);
      showErr("初始化失败", e);
    }
  })();
} else {
  // 浏览器兜底：关标签页前拦一下未保存改动
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  // 浏览器也有崩溃草稿（无路径概念）
  const draft = loadDraft();
  if (draft && draft.text) {
    if (window.confirm("检测到未保存的草稿，是否恢复？")) {
      applyLoadedText(draft.text, null, draft.encoding || "utf8");
      originalEolCRLF = !!draft.eolCRLF;
      // 与 Tauri 分支的 P0-1 修复同理：applyLoadedText 把草稿文本当成了"已保存
      // 基准"并清了草稿，不重设基准的话恢复出的内容会被判"干净"——关页不拦、
      // 草稿不重写，等于二次丢数据。浏览器无磁盘可对照，恢复内容必脏
      lastSavedNorm = "";
      refreshLabel();
    } else {
      clearDraft();
    }
  }
}

// ---- 周期任务：草稿 3s / 定时保存 30s / 外部修改监听 3s（仅 Tauri 有真实路径才有意义）----
setInterval(() => saveDraftNow(), 3000);
setInterval(async () => {
  if (IS_TAURI && settings.autosave && currentPath && isDirty() && !view.composing) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // 文件已被外部删除：不自动保存（否则等于静默重建空壳文件）
      if (!(await invoke("path_exists", { path: currentPath }))) return;
    } catch {
      return;
    }
    saveFile();
  }
}, 30000);
// 外部修改监听：mtime 变了 → 干净则静默重载，脏则问用户；无论选什么都以磁盘
// mtime 为准，避免同一改动反复弹窗。null 哨兵：某次读取失败（文件被占用等）
// 只会让下一轮重新采纳基准，不会永久关掉监听
setInterval(async () => {
  if (!IS_TAURI || !currentPath || selfWriting || document.hidden) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const m = await invoke("file_mtime_ms", { path: currentPath });
    if (m == null) return;
    if (lastKnownMtime == null) {
      lastKnownMtime = m;
      return;
    }
    if (m === lastKnownMtime) return;
    lastKnownMtime = m;
    if (!isDirty()) {
      await reloadExternalPreservingView();
      return;
    }
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    if (
      await confirm("文件已被外部程序修改，丢弃本地修改并加载新内容？", {
        title: "外部修改",
        kind: "warning",
      })
    ) {
      await reloadExternalPreservingView();
    }
  } catch {
    /* 文件可能被删除/占用，忽略本次 */
  }
}, 3000);

// 同文件的外部改动重载：整体 setState 会把光标/滚动/撤销历史全部清零——
// 用户正读着文件被 git/同步盘一改就跳回顶部，很跳戏。这里换成普通 dispatch
// （撤销栈里多一条"外部重载"记录是合理语义），并尽量还原光标与滚动位置。
async function reloadExternalPreservingView() {
  const { invoke } = await import("@tauri-apps/api/core");
  const res = await invoke("read_text_file", { path: currentPath });
  const text = normEol(res.text);
  const sel = view.state.selection.main;
  const scroll = view.scrollDOM.scrollTop;
  if (text !== view.state.doc.toString()) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: Math.min(sel.anchor, text.length) },
    });
  }
  lastSavedNorm = text;
  clearDraft();
  clearImageCache(); // 外部改动可能替换了图片文件：下次渲染重新解析，不再用旧缓存
  view.scrollDOM.scrollTop = Math.min(scroll, view.scrollDOM.scrollHeight);
  refreshLabel();
}

// ---- 图片粘贴 / 拖入：存到文档同目录 assets/（无路径时退 data URL）----
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

function toBase64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}
function imageExt(name) {
  const m = /\.(png|jpe?g|gif|webp|bmp)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "png";
}
function insertAtCursor(text) {
  view.dispatch(view.state.replaceSelection(text));
  view.focus();
}

async function insertImageBytes(bytes, name) {
  const b64 = toBase64(bytes);
  let ref;
  if (IS_TAURI && currentPath) {
    const { invoke } = await import("@tauri-apps/api/core");
    const fileName = `${Date.now()}-${name || `image.${imageExt(name)}`}`;
    ref = await invoke("write_asset_file", {
      docPath: currentPath,
      fileName,
      dataBase64: b64,
    });
  } else {
    // data URL 会随正文进草稿/自动保存，太大直接写爆 localStorage 配额
    if (b64.length > 2_000_000) {
      await showErr(
        "图片较大",
        "该图片转存后超过 2MB。请先把文档保存到本地，再插入图片（会存到文档同目录的 assets/）。"
      );
      return;
    }
    ref = `data:image/${imageExt(name)};base64,${b64}`;
  }
  const alt = (name || "图片").replace(/\.[a-z0-9]+$/i, "");
  insertAtCursor(`![${alt}](${ref})`);
}

async function copyExternalImage(path) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const name = path.split(/[\\/]/).pop();
    if (IS_TAURI && currentPath) {
      const b64 = await invoke("read_file_base64", { path });
      const fileName = `${Date.now()}-${name}`;
      const ref = await invoke("write_asset_file", {
        docPath: currentPath,
        fileName,
        dataBase64: b64,
      });
      insertAtCursor(`![](${ref})`);
    } else {
      const b64 = await invoke("read_file_base64", { path });
      insertAtCursor(`![](data:image/${imageExt(name)};base64,${b64})`);
    }
  } catch (e) {
    await showErr("插入图片失败", e);
  }
}

// 粘贴板里是图片（截图等）时接管 paste，转成 assets 引用/data URL
function handlePaste(event) {
  const files = event.clipboardData && event.clipboardData.files;
  if (!files || !files.length) return false;
  const img = [...files].find((f) => IMAGE_EXT_RE.test(f.name) || /^image\//.test(f.type));
  if (!img) return false;
  event.preventDefault();
  img
    .arrayBuffer()
    .then((buf) => insertImageBytes(new Uint8Array(buf), img.name))
    .catch((e) => showErr("插入图片失败", e));
  return true;
}

// ---- 工具栏按钮 ----
const btnRecent = document.getElementById("btn-recent");
const btnAutosave = document.getElementById("btn-autosave");
if (!IS_TAURI) {
  // 最近/自动保存依赖真实文件路径，浏览器模式没有意义，直接隐藏
  btnRecent.style.display = "none";
  btnAutosave.style.display = "none";
} else {
  btnRecent.addEventListener("click", () => toggleRecentMenu());
  btnAutosave.addEventListener("click", () => {
    settings.autosave = !settings.autosave;
    saveSettings(settings);
    applyAutosaveBtn();
  });
  applyAutosaveBtn();
}
function applyAutosaveBtn() {
  btnAutosave.textContent = settings.autosave ? "自动保存 ✓" : "自动保存";
  btnAutosave.classList.toggle("active", settings.autosave);
}
document.addEventListener("click", (e) => {
  const menu = document.getElementById("recent-menu");
  if (
    !menu.classList.contains("hidden") &&
    !menu.contains(e.target) &&
    e.target !== btnRecent &&
    !btnRecent.contains(e.target)
  ) {
    toggleRecentMenu(false);
  }
});

// ---- 拖放 .md 文件到窗口打开 ----
// Tauri 开了 dragDropEnabled 后 WebView2 会吞掉 HTML5 drop 事件，必须走原生
// onDragDropEvent；浏览器兜底走 HTML5 drop。两路都复用脏确认与编码解码。
const DROP_EXT_RE = /\.(md|markdown|txt)$/i;

if (IS_TAURI) {
  (async () => {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths || [];
        const image = paths.find((p) => IMAGE_EXT_RE.test(p));
        if (image) {
          await copyExternalImage(image); // 图片拖入：复制进 assets 并插入引用
          return;
        }
        const path = paths.find((p) => DROP_EXT_RE.test(p));
        if (path) await loadFile(path); // 脏确认在 loadFile 内
      });
    } catch (e) {
      console.error("拖放初始化失败:", e);
    }
  })();
} else {
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (IMAGE_EXT_RE.test(f.name) || /^image\//.test(f.type)) {
      // 浏览器拖图片：与粘贴同路（data URL + 2MB 上限守卫 + alt 文件名），
      // 无文件系统可放 assets
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        await insertImageBytes(bytes, f.name);
      } catch (err) {
        await showErr("插入图片失败", err);
      }
      return;
    }
    if (!DROP_EXT_RE.test(f.name)) return;
    if (!(await confirmDiscard())) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const { text, encoding } = decodeBrowserBytes(bytes);
      applyLoadedText(text, null, encoding);
      currentBrowserName = f.name;
      refreshLabel();
    } catch (err) {
      await showErr("打开失败", err);
    }
  });
}
