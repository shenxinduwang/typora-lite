// listEditing.js —— Markdown 列表缩进：Tab / Shift+Tab
// 回车续写（含空项退出、有序递增、任务重置）由 @codemirror/lang-markdown 内建提供
// （markdownKeymap 以 Prec.high 绑定 insertNewlineContinueMarkup），这里只补它没有的缩进。
import { syntaxTree } from "@codemirror/language";

// 行首 = [空白/引用前缀] + 列表标记 + 空格 + [任务标记] + 内容
const LIST_RE = /^([ \t]*(?:>[ \t]*)*)([-*+]|\d{1,9}[.)])[ \t]+(\[[ xX]\][ \t]+)?(.*)$/;

function inCodeBlock(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "CodeText") {
      return true;
    }
  }
  return false;
}

// 对选区覆盖到的每一行列表项整体缩进（前缀内加/删 2 空格）。
// 不在列表行/代码块内则返回 false，Tab 继续走 indentWithTab。
function shiftIndent(state, dispatch, dir) {
  const range = state.selection.main;
  if (inCodeBlock(state, range.head)) return false;
  const firstLine = state.doc.lineAt(range.from);
  const lastLine = state.doc.lineAt(range.to);
  const changes = [];

  for (let pos = firstLine.from; pos <= lastLine.to; ) {
    const line = state.doc.lineAt(pos);
    pos = line.to + 1;
    const m = LIST_RE.exec(line.text);
    if (!m) continue;
    const markerStart = m[1].length; // 前缀末尾 = 标记起点
    if (dir > 0) {
      changes.push({
        from: line.from + markerStart,
        to: line.from + markerStart,
        insert: "  ",
      });
    } else {
      // 从标记前的空白里移除最多 2 个空格；没有可移除的缩进则跳过该行
      let i = markerStart;
      let removed = 0;
      while (i > 0 && removed < 2) {
        const ch = line.text[i - 1];
        if (ch === " " || ch === "\t") {
          i--;
          removed++;
        } else break;
      }
      if (removed) {
        changes.push({ from: line.from + i, to: line.from + markerStart, insert: "" });
      }
    }
  }
  if (!changes.length) return false;

  dispatch({
    changes,
    scrollIntoView: true,
    userEvent: "indent",
  }); // 不传 selection：CM 按事务自动映射光标
  return true;
}

export function indentList({ state, dispatch }) {
  return shiftIndent(state, dispatch, 1);
}
export function outdentList({ state, dispatch }) {
  return shiftIndent(state, dispatch, -1);
}
