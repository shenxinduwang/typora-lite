// liveMarkdown.js —— Typora 式「打字即渲染」核心
// 用 CodeMirror 6 的 Decoration：把 Markdown 语法标记(# ** ` > ~~)在光标不靠近时原地隐藏，
// 并对标题/粗斜体/行内代码/代码块/引用/链接/删除线/分割线套用样式；任务列表渲染成复选框、
// 列表符与表格表头/分隔符做原地渲染。颜色全部走 CSS 变量，暗色主题由 style.css 的 media 切换。
// 光标进入某段时，该段的标记会自动重新显示，便于编辑——与 Typora 行为一致。

import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { RangeSet, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { findEmphasisSpans, classifyLinkHref } from "./tidy.js";

// ---- 实验室开关（借鉴 Telari 0.5.4「实验室」页）----
// main.js 启动时 setLabFlags(settings.lab) 注入；改动会 bump 版本号，
// ViewPlugin 在下次 update 时对比版本重建装饰（不依赖 transaction 标志）。
const lab = { txtPlain: true, emphasisDot: false };
let labVersion = 0;
export function setLabFlags(flags) {
  Object.assign(lab, flags);
  labVersion++;
}

// ---- 行内标记样式 ----
const markStrong = Decoration.mark({ class: "cm-strong" });
const markEm = Decoration.mark({ class: "cm-em" });
const markCode = Decoration.mark({ class: "cm-inline-code" });
const markLink = Decoration.mark({ class: "cm-link" });
const markStrike = Decoration.mark({ class: "cm-strike" });
const markList = Decoration.mark({ class: "cm-listmark" });
const markTdMark = Decoration.mark({ class: "cm-td-mark" });
const markEmDot = Decoration.mark({ class: "cm-em-dot" }); // 着重号（实验室）

// ---- 任务列表复选框（把 [ ] / [x] 原地渲染成可点击方框）----
class TaskBoxWidget extends WidgetType {
  constructor(checked) {
    super();
    this.checked = checked;
  }
  eq(other) {
    return other instanceof TaskBoxWidget && other.checked === this.checked;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-taskbox" + (this.checked ? " cm-checked" : "");
    el.setAttribute("role", "checkbox");
    el.setAttribute("aria-checked", String(this.checked));
    return el;
  }
  ignoreEvent() {
    return false; // 让点击冒泡给编辑器的 mousedown 处理器做切换
  }
}

// 分割线：光标不在本行时把 `---` 原地替换成一条真正的横线，光标进入显示原文
class HrWidget extends WidgetType {
  eq(other) {
    return other instanceof HrWidget;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-hrline";
    el.setAttribute("role", "separator");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

// ---- 列表符（光标不在本列表项内时，把 -/*/​+ 折叠成 •/◦/▪ 层级圆点）----
const BULLET_GLYPHS = ["•", "◦", "▪"];
class BulletWidget extends WidgetType {
  constructor(depth) {
    super();
    this.depth = depth; // 0 基嵌套深度，由 ListItem 祖先数量决定
  }
  eq(other) {
    return other instanceof BulletWidget && other.depth === this.depth;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-bullet";
    el.textContent = BULLET_GLYPHS[Math.min(this.depth, BULLET_GLYPHS.length - 1)];
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return true; // 点击圆点落回行首（与 Typora 一致），不做切换
  }
}

// ---- 表格 block widget（P2-1 方案 A）----
// 光标不在 Table 内时把整段表格源码替换成真 <table>（列对齐/斑马纹/hover/宽表
// 横向滚动）。点击单元格：posAtDOM 反查 widget 对应的文档位置 → 现场重解析语法树
// 找到 Table 节点 → 按被点的 (row,col) 取该单元格当前源码 range → 光标塞进表内
// （widget 撤掉、显示源码，与全项目「焦点即编辑」心智一致）。
// lezer-markdown 结构：Table { TableHeader{TableCell,...}, TableDelimiter(整行分隔),
// TableRow{TableCell,...} ... }；表头/数据行里的单个 | 也是 TableDelimiter 节点。

// 单元格行内内容 → 轻量段树（text/code/em/strong/del/span），toDOM 时还原。
// 关键：@lezer/markdown 的内联树里**纯文本不是子节点，是子节点之间的间隙**——
// InlineCode 的子节点只有两个 CodeMark（内容是间隙，见其源码 L1421），
// Emphasis/StrongEmphasis 的内容文本同样在 EmphasisMark 子节点之间（L1743-1751
// 只把 Element 塞进 content）。所以必须做间隙填充，直接遍历子节点会丢正文。
function inlineSegments(state, node) {
  const segs = [];
  let pos = node.from;
  const emitGap = (from, to) => {
    if (to > from) segs.push({ t: "text", s: state.doc.sliceString(from, to) });
  };
  for (let c = node.firstChild; c; c = c.nextSibling) {
    emitGap(pos, c.from); // 子节点之间的间隙文本（含 Emphasis/InlineCode 的内容）
    pos = c.to;
    switch (c.name) {
      case "CodeMark":
      case "EmphasisMark":
      case "LinkMark":
      case "Image":
        break; // 标记字符（反引号/星号/方括号）与图片本体不渲染
      case "URL":
        // 独立自动链接显示文本；链接内部的 URL 不显示（只显示链接文字）
        if (node.name !== "Link") emitGap(c.from, c.to);
        break;
      case "InlineCode": {
        // 子节点 = [CodeMark(开), CodeMark(闭)]，内容取两 mark 之间的间隙
        const open = c.firstChild;
        const close = c.lastChild;
        if (open && close && open !== close && open.name === "CodeMark" && close.name === "CodeMark")
          segs.push({ t: "code", s: state.doc.sliceString(open.to, close.from) });
        else segs.push({ t: "code", s: state.doc.sliceString(c.from, c.to) });
        break;
      }
      case "Emphasis":
        segs.push({ t: "em", c: inlineSegments(state, c) });
        break;
      case "StrongEmphasis":
        segs.push({ t: "strong", c: inlineSegments(state, c) });
        break;
      case "Strikethrough":
        segs.push({ t: "del", c: inlineSegments(state, c) });
        break;
      case "Escape":
        segs.push({ t: "text", s: state.doc.sliceString(c.from + 1, c.to) });
        break;
      default:
        if (c.node && c.node.firstChild) segs.push({ t: "span", c: inlineSegments(state, c) });
        else emitGap(c.from, c.to);
    }
  }
  emitGap(pos, node.to); // 尾部间隙文本
  return segs;
}

function parseTable(state, tableNode) {
  const aligns = [];
  let header = null;
  const rows = [];
  const mkCell = (cellNode) => ({
    text: state.doc.sliceString(cellNode.from, cellNode.to).trim(), // eq 比较 + 点击兜底
    segs: inlineSegments(state, cellNode), // 行内渲染段（code/em/strong/del/text）
    from: cellNode.from,
    to: cellNode.to,
  });
  for (let child = tableNode.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableDelimiter") {
      const raw = state.doc.sliceString(child.from, child.to);
      if (/[^|\s:-]/.test(raw)) continue; // 行内单个 | 竖线，不是分隔行
      // | :--- | :--: | ---: | → left / center / right
      const cols = raw.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|");
      for (const col of cols) {
        const t = col.trim();
        aligns.push(
          /^:.*:$/.test(t) ? "center" : /:$/.test(t) ? "right" : /^:/.test(t) ? "left" : ""
        );
      }
      continue;
    }
    if (child.name === "TableHeader") {
      const cells = [];
      for (let c = child.firstChild; c; c = c.nextSibling) {
        if (c.name === "TableCell") cells.push(mkCell(c));
      }
      header = cells;
      continue;
    }
    if (child.name === "TableRow") {
      const cells = [];
      for (let c = child.firstChild; c; c = c.nextSibling) {
        if (c.name === "TableCell") cells.push(mkCell(c));
      }
      rows.push(cells);
    }
  }
  if (!header || !header.length) return null;
  return { aligns, header, rows };
}

class TableWidget extends WidgetType {
  constructor(data, view) {
    super();
    this.data = data; // { aligns, header, rows }，cell 含构建期源码 range
    this.view = view;
  }
  // eq 只比内容与对齐：cell range 会随前文编辑平移，不参与比较；
  // 点击时的 range 一律现场重解析，杜绝旧闭包定位漂移
  eq(other) {
    if (!(other instanceof TableWidget)) return false;
    const key = (d) =>
      JSON.stringify(d.aligns) +
      "\u0002" +
      d.header.map((c) => c.text).join("\u0001") +
      "\u0002" +
      d.rows.map((r) => r.map((c) => c.text).join("\u0001")).join("\u0002");
    return key(other.data) === key(this.data);
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-table";
    const table = document.createElement("table");
    // 以最宽行为准渲染，缺列补空单元格（可点，落到本行已知位置）
    const colCount = Math.max(
      this.data.header.length,
      ...this.data.rows.map((r) => r.length)
    );
    // 段树 → DOM：code 用 <code>（样式走 .cm-table code），em/strong/del 用语义标签
    const renderSegs = (parent, segs) => {
      for (const s of segs) {
        if (s.t === "text") {
          parent.appendChild(document.createTextNode(s.s));
          continue;
        }
        const el = document.createElement(s.t);
        if (s.t === "code") {
          el.className = "cm-cellcode";
          el.textContent = s.s;
        } else if (s.c) {
          renderSegs(el, s.c);
        }
        parent.appendChild(el);
      }
    };
    const mkCell = (tag, cell, row, col) => {
      const el = document.createElement(tag);
      if (cell) renderSegs(el, cell.segs);
      el.dataset.row = String(row);
      el.dataset.col = String(col);
      if (this.data.aligns[col]) el.style.textAlign = this.data.aligns[col];
      return el;
    };
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    for (let i = 0; i < colCount; i++)
      trh.appendChild(mkCell("th", this.data.header[i], 0, i));
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    this.data.rows.forEach((r, ri) => {
      const tr = document.createElement("tr");
      for (let i = 0; i < colCount; i++) tr.appendChild(mkCell("td", r[i], ri + 1, i));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    wrap.addEventListener("click", (ev) => this.cellClick(ev, wrap));
    return wrap;
  }
  cellClick(ev, wrap) {
    ev.preventDefault();
    const cell = ev.target.closest && ev.target.closest("th,td");
    if (!cell) return;
    const view = this.view || editorViewRef; // StateField 路径经模块级引用取 view
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    // widget 起点 → 定位 Table 节点 → 现场重解析拿该单元格当前 range
    const pos = view.posAtDOM(wrap, 0);
    let tableNode = null;
    syntaxTree(view.state).iterate({
      from: Math.max(0, pos - 1),
      to: Math.min(view.state.doc.length, pos + 1),
      enter(n) {
        if (n.name === "Table" && pos >= n.from && pos <= n.to) tableNode = n.node;
      },
    });
    if (!tableNode) return;
    const fresh = parseTable(view.state, tableNode);
    if (!fresh) return;
    const line = row === 0 ? fresh.header : fresh.rows[row - 1] || fresh.header;
    // 补齐的空单元格没有独立 range → 落到本行最后一个已知单元格
    const target = line[col] || line[line.length - 1] || { from: tableNode.from };
    view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: "nearest" }),
    });
    view.focus();
  }
  ignoreEvent() {
    return true; // 事件归 widget：点击进格，不走 CM 默认坐标映射
  }
}

// 需要「隐藏」的标记节点：隐藏即 replace 成空
// （CodeInfo 不在此列：它单独处理成「语言标签 + 复制按钮」头部条，避免同 range 双 replace 冲突）
const HIDE_MARKS = new Set([
  "HeaderMark", // # ##
  "QuoteMark", // >
  "CodeMark", // ``` 和行内 `
  "EmphasisMark", // * _
  "StrongEmphasisMark", // ** __
  "StrikethroughMark", // ~~ (GFM)
]);

// 剪贴板：优先 async Clipboard API（Tauri 2 WebView2 页面是 https://tauri.localhost
// secure context，大概率可用），失败兜底 execCommand——P1-2 不引插件依赖
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallthrough 到兜底 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// ---- 代码块头部条（语言标签 + 复制按钮）----
// 落点：```
// js 首行的 CodeInfo。光标不在 fence 内时 CodeMark 被隐藏、首行被 line 装饰
// 画成头部条，这个 widget 就是头部条的全部内容。语言为空时只显示复制按钮。
class CodeHeadWidget extends WidgetType {
  constructor(lang, code) {
    super();
    this.lang = lang;
    this.code = code;
  }
  eq(other) {
    return (
      other instanceof CodeHeadWidget &&
      other.lang === this.lang &&
      other.code === this.code
    );
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-codehead";
    if (this.lang) {
      const lang = document.createElement("span");
      lang.className = "cm-codelang";
      lang.textContent = this.lang;
      el.appendChild(lang);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-copybtn";
    btn.textContent = "复制";
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const ok = await copyText(this.code);
      btn.textContent = ok ? "已复制" : "复制失败";
      setTimeout(() => {
        btn.textContent = "复制";
      }, 1200);
    });
    el.appendChild(btn);
    return el;
  }
  ignoreEvent() {
    return true; // 点击归按钮自己，不让 CM 把它当编辑操作
  }
}

// StateField 构建装饰时拿不到 EditorView 实例（view 在 state 之后创建），
// widget 点击时经这里取主视图；main.js 创建 view 后注入
let editorViewRef = null;
export function setEditorViewRef(view) {
  editorViewRef = view;
}

// fence 内代码文本（去掉首尾 fence 行；未闭合的 fence 末行是代码要保留）
function codeTextOf(state, from, to) {
  const lines = [];
  eachLine(state, from, to, (line) => lines.push(line.text));
  const body = lines.slice(1);
  if (body.length && /^\s*(```|~~~)/.test(body[body.length - 1])) body.pop();
  return body.join("\n");
}

// 图片预览：<img> 的 src 解析结果缓存（key -> dataURL 或 null=失败）
const imageSrcCache = new Map();
// 由 main.js 注入：rel 引用 -> 当前文档路径（用于 Rust 端解析相对 assets 路径）
let imagePathResolver = null;
export function setImagePathResolver(fn) {
  imagePathResolver = fn;
}
// 换文档 / 外部重载时清缓存：不同目录的文档可能引用同名相对路径
// （assets/photo.png），不隔离会串图；同文档图片被外部修改后也能重新解析
export function clearImageCache() {
  imageSrcCache.clear();
}
// 缓存 key 必须带文档路径：只按 rel 做 key 会在多文档间串图
function imageCacheKey(docPath, src) {
  return `${docPath || ""}\u0000${src}`;
}

function imageMime(src) {
  const m = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.exec(src);
  const table = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
  };
  return m ? table[m[1].toLowerCase()] : "image/png";
}

async function resolveImageSrc(src, key, el) {
  try {
    const docPath = imagePathResolver ? imagePathResolver() : null;
    if (!docPath) throw new Error("no document path");
    const { invoke } = await import("@tauri-apps/api/core");
    const b64 = await invoke("read_asset_base64", { docPath, rel: src });
    const url = `data:${imageMime(src)};base64,${b64}`;
    imageSrcCache.set(key, url);
    el.src = url;
    delete el.dataset.loading;
  } catch {
    imageSrcCache.set(key, null); // 失败不再重试，显示 alt 文本
    el.dataset.broken = "1";
  }
}

// 光标不在 Image 节点内时，整段 ![alt](src) 渲染成 <img> 预览
class ImageWidget extends WidgetType {
  constructor(src, title) {
    super();
    this.src = src;
    this.title = title || "";
  }
  eq(other) {
    return (
      other instanceof ImageWidget &&
      other.src === this.src &&
      other.title === this.title
    );
  }
  toDOM() {
    const el = document.createElement("img");
    el.className = "cm-img";
    el.alt = this.title;
    el.title = this.title;
    if (this.src.startsWith("data:")) {
      el.src = this.src;
    } else if (/^https?:\/\//i.test(this.src)) {
      // 远程图片：带协议的 URL 不是本地路径，丢给 read_asset_base64 做路径
      // 解析必失败 → broken 虚线框。直接交给 WebView 加载（CSP img-src 已
      // 放行 http:/https:），重复渲染由浏览器 HTTP 缓存兜住，不进本地缓存
      el.src = this.src;
    } else {
      const key = imageCacheKey(
        imagePathResolver ? imagePathResolver() : null,
        this.src
      );
      // has() 判存而非真值判断：失败路径缓存的是 null（假值），
      // 用 if (cached) 会导致每次装饰重建都重发注定失败的 IPC
      if (imageSrcCache.has(key)) {
        const cached = imageSrcCache.get(key);
        if (cached) {
          el.src = cached;
        } else {
          el.dataset.broken = "1"; // 已判定失败：直接标 broken，显示 alt
        }
      } else {
        el.dataset.loading = "1";
        resolveImageSrc(this.src, key, el);
      }
    }
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

// 从 `![alt](src)` 节点文本里抠出 src 与 alt
function parseImageNode(state, from, to) {
  const text = state.doc.sliceString(from, to);
  // src 取第一个空白前的 token，兼容可选的 "title"：
  // ![alt](src "title")。旧正则 [^)]* 会把 src "title" 整段当 src，
  // read_asset_base64 必失败且被缓存成 broken
  const m = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)\s*$/.exec(text);
  if (!m) return null;
  const src = m[2].trim();
  if (!src) return null;
  return { src, title: m[1] };
}

// 标题级别 -> class（ATXHeading1..6 / SetextHeading1..6）
function headingLevel(name) {
  const m = /^(ATX|Setext)Heading([1-6])$/.exec(name);
  return m ? Number(m[2]) : 0;
}

function eachLine(state, from, to, fn) {
  for (let p = from; p <= to; ) {
    const line = state.doc.lineAt(p);
    fn(line);
    p = line.to + 1;
  }
}

// 光标是否算「在表内」（是否暂缓整表 widget），StateField 与 ViewPlugin 镜像
// 两个真源必须用同一判定，否则 widget 与子节点避让会失步。
// 情形一：光标落在 Table 节点内（原有焦点即编辑语义）。
// 情形二：光标停在表格紧下方第一行空行，且是「刚被文档编辑送进来」的
// （sticky 命中）。GFM 语法树不把该行算进 Table，但在最后一行行尾按 Enter
// 补行时光标恰好落在这里——若不豁免，整表立刻渲染成阅读 widget，敲出 "|"
// 后表格行又吞回光标切回源码态，每加一行阅读/编辑来回弹一次（表格编辑
// 体验 bug）。纯选区移动（点击/方向键/重启恢复光标位）不给豁免，否则光标
// 恰好停在表格下方空行时整表永远渲染不出来。
function caretInTable(state, heads, from, to, sticky) {
  if (heads.some((h) => h >= from && h <= to)) return true;
  if (sticky.size === 0) return false;
  const belowNumber = state.doc.lineAt(to).number + 1;
  return heads.some((h) => {
    const line = state.doc.lineAt(h);
    return (
      line.number === belowNumber && !line.text.trim() && sticky.has(line.from)
    );
  });
}

// 文档编辑落定后，光标是否正停在某个可渲染表格紧邻下方的空行上（Enter 补行）
function tableEdgeArrived(state) {
  const arrived = new Set();
  if (!state.doc.toString().includes("|")) return arrived;
  const heads = state.selection.ranges.map((r) => r.head);
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return;
      if (!parseTable(state, node.node)) return;
      const belowNumber = state.doc.lineAt(node.to).number + 1;
      for (const h of heads) {
        const line = state.doc.lineAt(h);
        if (line.number === belowNumber && !line.text.trim()) {
          arrived.add(line.from);
          break;
        }
      }
    },
  });
  return arrived;
}

const EMPTY_STICKY = new Set();

// 豁免名单：仅在「文档变了」时重算（Enter 补行那一刻命中），任何
// 纯选区变化立即清空——豁免只属于"编辑动作带进来的光标"
const tableEdgeSticky = StateField.define({
  create: () => EMPTY_STICKY,
  update(value, tr) {
    if (tr.docChanged) return tableEdgeArrived(tr.state);
    if (tr.selection) return EMPTY_STICKY;
    return value;
  },
});

export const tableEdgeStickyField = tableEdgeSticky;

function buildDecorations(view) {
  const { state } = view;
  const selHeads = state.selection.ranges.map((r) => r.head);
  const caretIn = (a, b) => selHeads.some((h) => h >= a && h <= b);
  const tableSticky = state.field(tableEdgeSticky, false) || EMPTY_STICKY;

  const ranges = [];
  // 着重号扫描要避开代码区：可见范围内顺手收集（仅实验开关打开时）
  const codeRanges = [];
  // block widget 已接管的 Table range：其子节点的 replace/line 装饰必须避开，
  // 否则与整表 block replace（由 tableWidgets StateField 下发）重叠 → CM 抛异常白屏
  const widgetTables = [];
  const inWidgetTable = (pos) =>
    widgetTables.some((t) => pos >= t.from && pos <= t.to);
  // 按行号(line.from)聚合 class，保证同一行最终只生成一个 Decoration.line，
  // 避免「引用块里的标题」等同一行命中多种行样式时 RangeSet.of 抛异常导致白屏。
  const lineClasses = new Map();
  const addLine = (from, cls) => {
    const cur = lineClasses.get(from);
    if (cur) cur.add(cls);
    else lineClasses.set(from, new Set([cls]));
  };

  const tree = syntaxTree(state);

  for (const v of view.visibleRanges) {
    tree.iterate({
      from: v.from,
      to: v.to,
      enter(node) {
        const { from, to, name } = node;
        if (lab.emphasisDot && (name === "FencedCode" || name === "InlineCode"))
          codeRanges.push([from, to]);

        // 标题：整行套用字号；光标不在本标题内时隐藏 # 标记。
        // Setext 标题的下划线行（===/---）不套标题字号——否则该行被隐藏后
        // 会残留一个 2em 字号的大空行
        const lvl = headingLevel(name);
        if (lvl) {
          const underline =
            name.startsWith("Setext") ? state.doc.lineAt(to) : null;
          eachLine(state, from, to, (line) => {
            if (underline && line.from === underline.from) return;
            addLine(line.from, `cm-h cm-h${lvl}`);
          });
        }

        switch (name) {
          case "StrongEmphasis":
            ranges.push(markStrong.range(from, to));
            break;
          case "Emphasis":
            ranges.push(markEm.range(from, to));
            break;
          case "InlineCode":
            ranges.push(markCode.range(from, to));
            break;
          case "FencedCode": {
            // P1-1 路线 A：逐行 line 装饰拼容器（mark 只能盖文字 run，画不出
            // 容器/圆角/内边距）。光标在块内 → 不加容器类，回到原文编辑态，
            // 与 Typora「进入代码块显示源码」行为一致（caretIn 同构）
            if (!caretIn(from, to)) {
              const cbLines = [];
              eachLine(state, from, to, (line) => cbLines.push(line));
              cbLines.forEach((line, i) => {
                const cls = ["cm-cb"];
                if (i === 0) cls.push("cm-cb-first");
                if (i === cbLines.length - 1) cls.push("cm-cb-last");
                addLine(line.from, cls.join(" "));
              });
            }
            break;
          }
          case "CodeInfo": {
            // ```js 的语言标签：光标不在 fence 内 → 渲染成头部条（语言 + 复制）；
            // 光标在块内 → 显示原文（HIDE_MARKS 已不含 CodeInfo，无双 replace 冲突）
            const fence = node.node.parent;
            if (fence && !caretIn(fence.from, fence.to)) {
              const lang = state.doc.sliceString(from, to).trim();
              ranges.push(
                Decoration.replace({
                  widget: new CodeHeadWidget(
                    lang,
                    codeTextOf(state, fence.from, fence.to)
                  ),
                }).range(from, to)
              );
            }
            break;
          }
          case "Link": {
            // Telari 0.5.0：文件链接虚线、网页链接实线
            const lm = /\]\(([^)\s]+)/.exec(state.doc.sliceString(from, to));
            ranges.push(
              Decoration.mark({
                class:
                  lm && classifyLinkHref(lm[1]) === "file"
                    ? "cm-link cm-link-file"
                    : "cm-link",
              }).range(from, to)
            );
            break;
          }
          case "LinkMark":
          case "URL": {
            // 链接/图片的括号与 URL：光标不在其内时折叠（Typora 只留链接文字）；
            // 独立 URL（GFM 自动链接）上链接色。表格被 widget 接管时跳过（防重叠）
            if (inWidgetTable(from)) break;
            const p = node.node.parent;
            if (p && (p.name === "Link" || p.name === "Image")) {
              if (!caretIn(p.from, p.to)) {
                ranges.push(Decoration.replace({}).range(from, to));
                break;
              }
              break;
            }
            if (name === "URL") ranges.push(markLink.range(from, to));
            break;
          }
          case "Image": {
            if (!inWidgetTable(from) && !caretIn(from, to)) {
              const parsed = parseImageNode(state, from, to);
              if (parsed) {
                ranges.push(
                  Decoration.replace({
                    widget: new ImageWidget(parsed.src, parsed.title),
                  }).range(from, to)
                );
              }
            }
            break;
          }
          case "Strikethrough":
            ranges.push(markStrike.range(from, to));
            break;
          case "ListMark": {
            // 无序列表：光标不在本项内时折叠成层级圆点 widget（P0-5）；
            // 光标在内 → 显示原文便于编辑；有序列表保留数字原文 + tabular-nums
            const item = node.node.parent; // ListMark 的父即 ListItem
            const pFrom = item ? item.from : from;
            const pTo = item ? item.to : to;
            let ordered = false;
            let depth = 0;
            for (let p = item ? item.parent : null; p; p = p.parent) {
              if (p.name === "OrderedList") ordered = true;
              // 循环从自身 ListItem 的父级起步，这里数到的是"自身项之上的
              // ListItem 祖先数"——最外层项为 0（•），嵌套一层为 1（◦）
              if (p.name === "ListItem") depth++;
            }
            if (!ordered && !caretIn(pFrom, pTo)) {
              ranges.push(
                Decoration.replace({ widget: new BulletWidget(Math.max(0, depth)) }).range(
                  from,
                  to
                )
              );
              break;
            }
            ranges.push(markList.range(from, to));
            break;
          }
          case "Table": {
            // P2-1 方案 A：整表 block widget 由 tableWidgets StateField 提供
            // （CM 硬限制：block 装饰不允许经 ViewPlugin 下发）。这里只登记
            // 接管范围供子节点装饰避让；判定规则与 StateField 严格一致
            if (
              !caretInTable(state, selHeads, from, to, tableSticky) &&
              parseTable(state, node.node)
            ) {
              const lineFrom = state.doc.lineAt(from).from;
              const lineTo = state.doc.lineAt(to).to;
              widgetTables.push({ from: lineFrom, to: lineTo });
            }
            break;
          }
          case "TableDelimiter": {
            // 表格已被 widget 接管时跳过（防重叠）；分隔行（| --- | --- |）整行
            // 是一个 TableDelimiter 节点：光标不在表内时折掉内容；单个 | 只做弱化
            if (inWidgetTable(from)) break;
            const raw = state.doc.sliceString(from, to);
            const p = node.node.parent;
            const wholeRow = !/[^|\s:-]/.test(raw);
            if (
              wholeRow &&
              p &&
              p.name === "Table" &&
              !caretInTable(state, selHeads, p.from, p.to, tableSticky)
            ) {
              ranges.push(Decoration.replace({}).range(from, to));
              break;
            }
            ranges.push(markTdMark.range(from, to));
            break;
          }
          case "TableHeader": // 表头行加粗（widget 接管时跳过，防样式渗入表格）
            if (!inWidgetTable(from))
              eachLine(state, from, to, (line) => addLine(line.from, "cm-th"));
            break;
          case "Blockquote":
            eachLine(state, from, to, (line) => addLine(line.from, "cm-quote"));
            break;
          case "HorizontalRule": {
            const line = state.doc.lineAt(from);
            addLine(line.from, "cm-hr");
            if (!caretIn(from, to)) {
              ranges.push(
                Decoration.replace({ widget: new HrWidget() }).range(from, to)
              );
            }
            break;
          }
          case "TaskMarker": {
            // 光标不在本任务项内 -> 渲染成复选框；在内 -> 显示原始 [ ]/[x] 便于编辑
            // （表格被 widget 接管时跳过，防与整表 replace 重叠）
            if (inWidgetTable(from)) break;
            const parent = node.node.parent;
            const pFrom = parent ? parent.from : from;
            const pTo = parent ? parent.to : to;
            if (caretIn(pFrom, pTo)) break; // 显示原文
            const txt = state.doc.sliceString(from, to); // "[ ]" / "[x]" / "[X]"
            const checked = /x/i.test(txt);
            ranges.push(
              Decoration.replace({ widget: new TaskBoxWidget(checked) }).range(
                from,
                to
              )
            );
            break;
          }
        }

        // 隐藏标记：仅当光标不在其所属语法节点范围内（表格被 widget 接管时跳过，
        // 单元格内的 EmphasisMark 等会与整表 block replace 重叠）
        if (HIDE_MARKS.has(name) && !inWidgetTable(from)) {
          const parent = node.node.parent;
          const pFrom = parent ? parent.from : from;
          const pTo = parent ? parent.to : to;
          if (!caretIn(pFrom, pTo)) {
            ranges.push(Decoration.replace({}).range(from, to));
          }
        }
      },
    });
  }

  // ---- ^^着重号^^（实验室开关，借鉴 Telari 0.3.5 CJK emphasis）----
  // 语法树没有这种标记，逐可见行正则扫描；避开代码区/接管表格/光标所在段
  if (lab.emphasisDot) {
    for (const v of view.visibleRanges) {
      for (let p = v.from; p <= v.to; ) {
        const line = state.doc.lineAt(p);
        for (const s of findEmphasisSpans(line.text)) {
          const from = line.from + s.from;
          const to = line.from + s.to;
          if (caretIn(from, to) || inWidgetTable(from)) continue;
          if (codeRanges.some(([a, b]) => from < b && to > a)) continue;
          ranges.push(markEmDot.range(line.from + s.contentFrom, line.from + s.contentTo));
          ranges.push(Decoration.replace({}).range(from, from + 2));
          ranges.push(Decoration.replace({}).range(to - 2, to));
        }
        p = line.to + 1;
      }
    }
  }

  // 统一生成行装饰：每行一个合并 class 的 Decoration.line
  for (const [lineFrom, classes] of lineClasses) {
    ranges.push(
      Decoration.line({ class: [...classes].join(" ") }).range(lineFrom)
    );
  }

  return RangeSet.of(ranges, true);
}

// ---- 表格 block widget 的 StateField ----
// CM6 硬限制：Decoration.replace({block:true}) 不能经 ViewPlugin 下发（会抛
// "Block decorations may not be specified via plugins"），必须走状态层。
// 表格接管范围的全量真源在这里；liveMarkdown 插件里那份 widgetTables 只是为
// 子节点装饰避让做的同规则镜像。拆成两个纯值字段：facet.from 只接受静态值，
// 包装对象经 getter 下发会在部分版本踩动态判定的坑。
function buildTableDecorations(state, sticky) {
  const decorations = [];
  const atomicRanges = [];
  const text = state.doc.toString();
  if (!text.includes("|")) {
    return {
      decorations: RangeSet.of(decorations, true),
      atomic: RangeSet.of(atomicRanges, true),
    };
  }
  const heads = state.selection.ranges.map((r) => r.head);
  // syntaxTree（非 ensure）：深处的表格等解析器追上后再出 widget，不卡按键
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return;
      if (caretInTable(state, heads, node.from, node.to, sticky)) return;
      const parsed = parseTable(state, node.node);
      if (!parsed) return;
      const lineFrom = state.doc.lineAt(node.from).from;
      const lineTo = state.doc.lineAt(node.to).to;
      decorations.push(
        Decoration.replace({
          block: true,
          widget: new TableWidget(parsed, null),
        }).range(lineFrom, lineTo)
      );
      // atomicRanges facet 消费端会调 set.between(...)，必须是 RangeSet
      // （用 mark 装饰承载 range），不能给普通 {from,to} 数组
      atomicRanges.push(Decoration.mark({}).range(lineFrom, lineTo));
    },
  });
  return {
    decorations: RangeSet.of(decorations, true),
    atomic: RangeSet.of(atomicRanges, true),
  };
}

// 字段值缓存对应的语法树身份（跨 setState 重建的场景用对象不等性自然失效）
let tableFieldTree = null;

const tableDecoField = StateField.define({
  create: (state) => {
    tableFieldTree = syntaxTree(state);
    return buildTableDecorations(
      state,
      state.field(tableEdgeSticky, false) || EMPTY_STICKY
    ).decorations;
  },
  update(value, tr) {
    // 必须追踪语法树身份：新载入的文档由 ParseWorker 后台渐进解析，其 dispatch
    // 不带 docChanged/selection——只认这两个标志的话，字段会永远停在空树时算出
    // 的空装饰（症状：刚打开的文档表格不渲染，编辑一下才出现）
    const tree = syntaxTree(tr.state);
    if (tr.docChanged || tr.selection || tree !== tableFieldTree) {
      tableFieldTree = tree;
      // tableEdgeSticky 在 extensions 里先于本字段注册，这里读到的是本轮更新后的值
      return buildTableDecorations(
        tr.state,
        tr.state.field(tableEdgeSticky, false) || EMPTY_STICKY
      ).decorations;
    }
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    // 字段值本身就是 block replace 装饰集，直接复用为 atomicRanges（方向键/点击
    // 坐标映射跳过被替换区；进入靠点击单元格显式 dispatch）
    EditorView.atomicRanges.of(
      (view) => view.state.field(f, false) || Decoration.none
    ),
  ],
});

export const tableWidgets = tableDecoField;

export const liveMarkdown = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.tree = syntaxTree(view.state);
      this.labV = labVersion;
      this.decorations = buildDecorations(view);
    }
    update(u) {
      // IME 合成期间不重建装饰，避免中文候选词被打断（掉字/断词）；
      // 合成结束后会有一次 docChanged/selectionSet 的 update，届时再刷新。
      if (u.view.composing) return;
      // 语法树身份也要追：ParseWorker 渐进解析的 dispatch 不带 doc/selection
      // 标志，镜像不同步会在 StateField 出 widget 后漏掉子节点避让 → 装饰重叠
      const tree = syntaxTree(u.view.state);
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        tree !== this.tree ||
        this.labV !== labVersion
      ) {
        this.tree = tree;
        this.labV = labVersion;
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

// 结构 + 颜色（颜色用 CSS 变量，见 style.css 的 :root / 暗色 media）
export const baseTheme = EditorView.theme({
  "&": { fontSize: "16px", color: "var(--md-text)", background: "var(--md-bg)" },
  ".cm-content": {
    // P0-2：正文字体栈——Windows 11 的 Segoe UI Variable 优先，向下兜底；
    // CJK 走 PingFang(mac)/HarmonyOS Sans/微软雅黑
    fontFamily:
      '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    // P0-4：行高 1.7 → 1.65，向 ima 的标题-正文节奏靠（先只动这一个旋钮）
    lineHeight: "1.65",
    // 左右 32px 栏内留白（ima 实测值）；底部 60vh 是"最后一行能滚到顶"的
    // Typora 技巧，必须保留。820px 容器 - 2×32px 后实际文本栏宽 ≈756px，
    // 与改版前 760px 几乎一致——加留白但不改行长（观感优化方案 P0-1）
    padding: "28px 32px 60vh",
    caretColor: "var(--md-text)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--md-text)" },
  // drawSelection() 用自绘的 .cm-selectionBackground 渲染选区（原生 ::selection 被置透明）。
  // 聚焦态要写全路径才能压过 CM 内建默认色（同特异性、后挂载者胜）
  ".cm-selectionBackground": { backgroundColor: "var(--md-selection)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--md-selection)",
  },
  // 查找面板 / tooltip / 补全框：跟随主题变量，否则暗色下是白底
  ".cm-panel.cm-search": {
    backgroundColor: "var(--ui-bg)",
    color: "var(--md-text)",
  },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": {
    backgroundColor: "var(--ui-btn-bg)",
    color: "var(--md-text)",
    border: "1px solid var(--ui-btn-border)",
    borderRadius: "4px",
  },
  ".cm-panel.cm-search label": { color: "var(--md-muted)" },
  ".cm-tooltip": {
    backgroundColor: "var(--ui-btn-bg)",
    color: "var(--md-text)",
    border: "1px solid var(--ui-border)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "inherit",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--md-selection)",
    color: "var(--md-text)",
  },
  ".cm-line": { padding: "0 4px" },
  ".cm-h": { fontWeight: "600" },
  // 标题间距必须用 padding 而非 margin：CM 按元素矩形高度量行高，margin 不计入，
  // 标题越多累计偏移越大 → 点击定位漂移、滚动条高度不准（观感优化方案 P0-3）。
  // 用 longhand 是为了不覆盖 .cm-line 的水平 padding（同行级、后定义者胜）
  ".cm-h1": { fontSize: "2em", paddingTop: "0.9em", paddingBottom: "0.3em" },
  ".cm-h2": { fontSize: "1.6em", paddingTop: "0.75em", paddingBottom: "0.25em" },
  ".cm-h3": { fontSize: "1.3em", paddingTop: "0.6em", paddingBottom: "0.2em" },
  ".cm-h4": { fontSize: "1.15em", paddingTop: "0.5em", paddingBottom: "0.15em" },
  ".cm-h5": { paddingTop: "0.5em", paddingBottom: "0.15em" },
  ".cm-h6": { paddingTop: "0.5em", paddingBottom: "0.15em" },
  ".cm-strong": { fontWeight: "700" },
  ".cm-em": { fontStyle: "italic" },
  ".cm-inline-code": {
    fontFamily:
      '"Cascadia Mono", ui-monospace, Consolas, "Sarasa Mono SC", "JetBrains Mono", monospace',
    backgroundColor: "var(--md-code-bg)",
    borderRadius: "4px",
    fontSize: "0.92em",
    padding: "2px 5px",
  },
  // P1-1 路线 A：代码块容器由逐行 line 装饰拼出——每行左右描边+背景连续，
  // 首行（头部条）承担上圆角/上边框，末行承担下圆角/下边框
  ".cm-cb": {
    fontFamily:
      '"Cascadia Mono", ui-monospace, Consolas, "Sarasa Mono SC", "JetBrains Mono", monospace',
    fontSize: "0.92em",
    background: "var(--md-codeblock-bg)",
    borderLeft: "1px solid var(--md-codeblock-border)",
    borderRight: "1px solid var(--md-codeblock-border)",
    paddingLeft: "14px",
    paddingRight: "14px",
    lineHeight: "1.55",
  },
  ".cm-cb-first": {
    paddingTop: "8px",
    paddingBottom: "4px",
    borderTop: "1px solid var(--md-codeblock-border)",
    borderTopLeftRadius: "8px",
    borderTopRightRadius: "8px",
    background: "var(--md-codeblock-head-bg)",
    fontSize: "0.8em",
    lineHeight: "1.4",
  },
  ".cm-cb-last": {
    paddingTop: "4px",
    paddingBottom: "10px",
    borderBottom: "1px solid var(--md-codeblock-border)",
    borderBottomLeftRadius: "8px",
    borderBottomRightRadius: "8px",
  },
  // 头部条内容（CodeHeadWidget）：语言标签在左，复制按钮紧随其后
  ".cm-codehead": {
    display: "inline-flex",
    alignItems: "center",
    gap: "10px",
    color: "var(--md-muted)",
  },
  ".cm-codelang": {
    fontFamily:
      '"Segoe UI Variable Text", "Segoe UI", system-ui, "Microsoft YaHei", sans-serif',
    fontSize: "0.85em",
    textTransform: "lowercase",
    letterSpacing: "0.02em",
  },
  ".cm-copybtn": {
    border: "1px solid var(--ui-btn-border)",
    background: "var(--ui-btn-bg)",
    color: "var(--md-muted)",
    borderRadius: "5px",
    fontSize: "0.85em",
    padding: "1px 8px",
    cursor: "pointer",
  },
  ".cm-copybtn:hover": {
    background: "var(--ui-btn-hover)",
    color: "var(--md-text)",
  },
  ".cm-quote": {
    borderLeft: "4px solid var(--md-border)",
    backgroundColor: "var(--md-quote-bg)",
    color: "var(--md-muted)",
    paddingLeft: "12px",
  },
  ".cm-link": { color: "var(--md-link)", textDecoration: "underline" },
  // 文件链接虚线（Telari 0.5.0）；着重号下加圆点（CSS text-emphasis，WebView 原生支持）
  ".cm-link-file": { textDecoration: "underline dotted" },
  ".cm-em-dot": { textEmphasis: "filled dot", textEmphasisPosition: "under" },
  ".cm-strike": { textDecoration: "line-through", color: "var(--md-muted)" },
  // 行样式只负责留白，横线本体由 .cm-hrline widget 画（光标进入时显示原文 `---`）
  ".cm-hr": { margin: "0.35em 0" },
  ".cm-hrline": {
    display: "inline-block",
    width: "100%",
    borderTop: "1px solid var(--md-border)",
    verticalAlign: "middle",
  },
  ".cm-listmark": {
    color: "var(--md-accent)",
    fontWeight: "700",
    fontVariantNumeric: "tabular-nums", // 有序列表数字等宽对齐
  },
  // 列表符折叠后的层级圆点（BulletWidget）：占位与原文 - 相近，点击落行首可接受
  ".cm-bullet": {
    color: "var(--md-accent)",
    fontWeight: "700",
    display: "inline-block",
    width: "1em",
    textAlign: "center",
    marginRight: "0.35em",
  },
  ".cm-td-mark": { color: "var(--md-muted)" },
  ".cm-th": { fontWeight: "700" },
  // 图片预览（Image 节点折叠后的 <img>）：块级居中 + 圆角，观感优化方案 P0-9
  ".cm-img": {
    maxWidth: "100%",
    maxHeight: "480px",
    display: "block",
    margin: "8px auto",
    borderRadius: "8px",
  },
  ".cm-img[data-loading]": {
    opacity: 0.4,
    border: "1px dashed var(--md-border)",
    minWidth: "120px",
    minHeight: "40px",
  },
  ".cm-img[data-broken]": {
    opacity: 0.5,
    border: "1px dashed var(--md-border)",
    minWidth: "120px",
    minHeight: "24px",
  },
});
