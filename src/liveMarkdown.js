// liveMarkdown.js —— Typora 式「打字即渲染」核心
// 用 CodeMirror 6 的 Decoration：把 Markdown 语法标记(# ** ` > ~~)在光标不靠近时原地隐藏，
// 并对标题/粗斜体/行内代码/代码块/引用/链接/删除线/分割线套用样式；任务列表渲染成复选框、
// 列表符与表格表头/分隔符做原地渲染。颜色全部走 CSS 变量，暗色主题由 style.css 的 media 切换。
// 光标进入某段时，该段的标记会自动重新显示，便于编辑——与 Typora 行为一致。

import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { RangeSet } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

// ---- 行内标记样式 ----
const markStrong = Decoration.mark({ class: "cm-strong" });
const markEm = Decoration.mark({ class: "cm-em" });
const markCode = Decoration.mark({ class: "cm-inline-code" });
const markLink = Decoration.mark({ class: "cm-link" });
const markBlock = Decoration.mark({ class: "cm-codeblock" });
const markStrike = Decoration.mark({ class: "cm-strike" });
const markList = Decoration.mark({ class: "cm-listmark" });
const markTdMark = Decoration.mark({ class: "cm-td-mark" });

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

// 需要「隐藏」的标记节点：隐藏即 replace 成空
const HIDE_MARKS = new Set([
  "HeaderMark", // # ##
  "QuoteMark", // >
  "CodeMark", // ``` 和行内 `
  "CodeInfo", // ```js 的语言标签（父节点 FencedCode：光标进块内显示、在外隐藏）
  "EmphasisMark", // * _
  "StrongEmphasisMark", // ** __
  "StrikethroughMark", // ~~ (GFM)
]);

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

function buildDecorations(view) {
  const { state } = view;
  const selHeads = state.selection.ranges.map((r) => r.head);
  const caretIn = (a, b) => selHeads.some((h) => h >= a && h <= b);

  const ranges = [];
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
          case "FencedCode":
            ranges.push(markBlock.range(from, to));
            break;
          case "Link":
            ranges.push(markLink.range(from, to));
            break;
          case "LinkMark":
          case "URL": {
            // 链接/图片的括号与 URL：光标不在其内时折叠（Typora 只留链接文字）；
            // 独立 URL（GFM 自动链接）上链接色
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
            if (!caretIn(from, to)) {
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
          case "ListMark": // - * 1. 列表符：原地高亮
            ranges.push(markList.range(from, to));
            break;
          case "TableDelimiter": {
            // 分隔行（| --- | --- |）整行是一个 TableDelimiter 节点：
            // 光标不在表内时折掉内容；表头行里的单个 | 只做弱化
            const raw = state.doc.sliceString(from, to);
            const p = node.node.parent;
            const wholeRow = !/[^|\s:-]/.test(raw);
            if (wholeRow && p && p.name === "Table" && !caretIn(p.from, p.to)) {
              ranges.push(Decoration.replace({}).range(from, to));
              break;
            }
            ranges.push(markTdMark.range(from, to));
            break;
          }
          case "TableHeader": // 表头行加粗
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

        // 隐藏标记：仅当光标不在其所属语法节点范围内
        if (HIDE_MARKS.has(name)) {
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

  // 统一生成行装饰：每行一个合并 class 的 Decoration.line
  for (const [lineFrom, classes] of lineClasses) {
    ranges.push(
      Decoration.line({ class: [...classes].join(" ") }).range(lineFrom)
    );
  }

  return RangeSet.of(ranges, true);
}

export const liveMarkdown = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(u) {
      // IME 合成期间不重建装饰，避免中文候选词被打断（掉字/断词）；
      // 合成结束后会有一次 docChanged/selectionSet 的 update，届时再刷新。
      if (u.view.composing) return;
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// 结构 + 颜色（颜色用 CSS 变量，见 style.css 的 :root / 暗色 media）
export const baseTheme = EditorView.theme({
  "&": { fontSize: "16px", color: "var(--md-text)", background: "var(--md-bg)" },
  ".cm-content": {
    fontFamily:
      '"Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif',
    lineHeight: "1.7",
    padding: "20px 0 60vh 0",
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
  ".cm-h1": { fontSize: "2em", marginTop: "0.6em" },
  ".cm-h2": { fontSize: "1.6em", marginTop: "0.5em" },
  ".cm-h3": { fontSize: "1.3em" },
  ".cm-h4": { fontSize: "1.15em" },
  ".cm-strong": { fontWeight: "700" },
  ".cm-em": { fontStyle: "italic" },
  ".cm-inline-code": {
    fontFamily: '"Cascadia Code", Consolas, monospace',
    backgroundColor: "var(--md-code-bg)",
    borderRadius: "4px",
    padding: "1px 4px",
  },
  ".cm-codeblock": {
    fontFamily: '"Cascadia Code", Consolas, monospace',
    backgroundColor: "var(--md-codeblock-bg)",
  },
  ".cm-quote": {
    borderLeft: "4px solid var(--md-border)",
    color: "var(--md-muted)",
    paddingLeft: "12px",
  },
  ".cm-link": { color: "var(--md-link)", textDecoration: "underline" },
  ".cm-strike": { textDecoration: "line-through", color: "var(--md-muted)" },
  // 行样式只负责留白，横线本体由 .cm-hrline widget 画（光标进入时显示原文 `---`）
  ".cm-hr": { margin: "0.35em 0" },
  ".cm-hrline": {
    display: "inline-block",
    width: "100%",
    borderTop: "1px solid var(--md-border)",
    verticalAlign: "middle",
  },
  ".cm-listmark": { color: "var(--md-accent)", fontWeight: "700" },
  ".cm-td-mark": { color: "var(--md-muted)" },
  ".cm-th": { fontWeight: "700" },
  // 图片预览（Image 节点折叠后的 <img>）
  ".cm-img": {
    maxWidth: "100%",
    maxHeight: "340px",
    display: "block",
    margin: "4px 0",
    borderRadius: "4px",
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
