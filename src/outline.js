// outline.js —— 大纲侧栏数据源：从语法树提取全部标题（ATX/Setext 1-6）
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";

// 返回 [{ level, text, from }]，from 用于点击跳转与"当前章节"定位。
// ensureSyntaxTree 强制解析到文末（大纲需要全文档标题，不能只看已解析的视口）。
// 预算 200ms（默认 50ms 会在长文档首次打开时拿部分树，尾部标题缺失；
// 调用点都在 500ms 防抖/面板开关后，追加预算不卡按键）。
export function collectOutline(state) {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) || syntaxTree(state);
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
