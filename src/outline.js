// outline.js —— 大纲侧栏数据源：从语法树提取全部标题（ATX/Setext 1-6）
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";

// 返回 [{ level, text, from }]，from 用于点击跳转与"当前章节"定位。
// ensureSyntaxTree 强制解析到文末（大纲需要全文档标题，不能只看已解析的视口）。
export function collectOutline(state) {
  const tree = ensureSyntaxTree(state, state.doc.length) || syntaxTree(state);
  const entries = [];
  tree.iterate({
    enter(node) {
      const m = /^(ATX|Setext)Heading([1-6])$/.exec(node.name);
      if (!m) return;
      const line = state.doc.lineAt(node.from);
      const text =
        line.text
          .replace(/^\s*#{1,6}\s+/, "") // ATX 前缀井号
          .replace(/\s+#+\s*$/, "") // ATX 尾部闭合井号
          .trim() || line.text.trim();
      entries.push({ level: Number(m[2]), text, from: node.from });
    },
  });
  return entries;
}
