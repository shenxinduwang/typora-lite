// tidy.test.mjs —— src/tidy.js 纯函数单测（npm test：node --test，零依赖）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tidyMixedSpacing,
  tidyFullWidthPunct,
  tidyText,
  findEmphasisSpans,
  classifyLinkHref,
} from "../src/tidy.js";

test("混排间距：CJK 与拉丁/数字交界补空格，已有空格不重复", () => {
  assert.equal(tidyMixedSpacing("中文English中文", []), "中文 English 中文");
  assert.equal(tidyMixedSpacing("使用React 18开发", []), "使用 React 18 开发");
  assert.equal(tidyMixedSpacing("中文 已空格English", []), "中文 已空格 English");
  // 幂等
  const once = tidyMixedSpacing("装Tauri框架", []);
  assert.equal(tidyMixedSpacing(once, []), once);
});

test("混排间距：保护区间内不注入", () => {
  const text = "看 `npm install-x` 与install中文";
  // 保护 [2, 17)：整段反引号（含两个反引号本身）
  const out = tidyMixedSpacing(text, [[2, 17]]);
  assert.ok(out.includes("`npm install-x`"), "代码区原样");
  assert.ok(out.includes("与 install 中文"));
});

test("全角标点：CJK 语境的半角标点转全角", () => {
  assert.equal(tidyFullWidthPunct("你好,世界.", []), "你好，世界。");
  assert.equal(tidyFullWidthPunct("备注: 见下", []), "备注： 见下");
  assert.equal(tidyFullWidthPunct("真的吗?太好了!", []), "真的吗？太好了！");
});

test("全角标点守卫：文件名/版本号/省略号/英文语境不误伤（Telari 4.→4。坑）", () => {
  assert.equal(tidyFullWidthPunct("打开 index.md 文件", []), "打开 index.md 文件");
  assert.equal(tidyFullWidthPunct("版本 1.2.3 发布", []), "版本 1.2.3 发布");
  assert.equal(tidyFullWidthPunct("## 4. 章节标题", []), "## 4. 章节标题");
  assert.equal(tidyFullWidthPunct("等等...", []), "等等...");
  assert.equal(tidyFullWidthPunct("a, b and c", []), "a, b and c");
  assert.equal(tidyFullWidthPunct("使用React,Vue开发", []), "使用React,Vue开发");
  assert.equal(tidyFullWidthPunct("foo(1) 与 bar(x)", []), "foo(1) 与 bar(x)");
});

test("括号：内容含 CJK 才全角", () => {
  assert.equal(tidyFullWidthPunct("(中文测试)", []), "（中文测试）");
  assert.equal(tidyFullWidthPunct("(english)", []), "(english)");
});

test("tidyText：标点+间距一次完成，保护区语义按原文索引", () => {
  const text = "看 http://a.com/x, y与中文English结束.";
  const out = tidyText(text, [[2, 18]]); // 保护 URL 主体
  assert.ok(out.includes("http://a.com/x, y"), "URL 段原样");
  assert.ok(out.includes("y 与中文 English 结束"));
  assert.ok(out.endsWith("。"));
  // 标点先行（1:1 不换长度）间距后行（插字符），保护区索引不会错位
});

test("stats.changes：现场计数（散布小改动不虚高，diff 方案曾算出 45）", () => {
  const s1 = { changes: 0 };
  tidyText("这是English文本,还有`保护,这里`.打开测试\n第二行4.序号结尾.", [], s1);
  // 空格×3（是E / h文 / 行4）+ 标点×3（文本, 护, 结尾. 三处转全角）
  assert.equal(s1.changes, 6);
  const s2 = { changes: 0 };
  tidyText("已经整理好的文本。", [], s2);
  assert.equal(s2.changes, 0);
});

test("findEmphasisSpans：^^..^^ 扫描（单行、不跨行、不吞连排 ^）", () => {
  const spans = findEmphasisSpans("注意^^重点^^这里");
  assert.equal(spans.length, 1);
  const s = spans[0];
  assert.equal(s.contentFrom, 4); // 注(0)意(1)^(2)^(3) → 内容自 4 起
  assert.equal(s.contentTo, 6);
  assert.equal(findEmphasisSpans("^^^", []).length, 0);
  assert.equal(findEmphasisSpans("^^^^", []).length, 0);
  assert.equal(findEmphasisSpans("a^^b^^c^^d^^", []).length, 2);
});

test("classifyLinkHref：网页/文件二分（虚线实线依据）", () => {
  assert.equal(classifyLinkHref("https://a.com"), "web");
  assert.equal(classifyLinkHref("HTTP://A.COM"), "web");
  assert.equal(classifyLinkHref("mailto:x@y.z"), "web");
  assert.equal(classifyLinkHref("//cdn/a.png"), "web");
  assert.equal(classifyLinkHref("assets/p.png"), "file");
  assert.equal(classifyLinkHref("./note.md"), "file");
  assert.equal(classifyLinkHref("../a/b.md"), "file");
  assert.equal(classifyLinkHref("data:image/png;base64,xx"), "web");
});
