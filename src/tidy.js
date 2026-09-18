// tidy.js —— 文本整理纯函数（借鉴 Telari 0.4.2 中英混排 / 0.5.3 全角纠偏）。
// 不依赖 CM/DOM，可被 node --test 直接单测（test/tidy.test.mjs）。
// 「保护区间」约定为半开 [from, to)：代码块、行内代码、链接、图片等区间内
// 的文本一律不参与整理——调用方（main.js）从语法树收集，这里只做掩码。

// CJK 汉字 + 假名（日韩一并受益，与 Telari 0.2.0 的 CJK 支持范围对齐）
const HAN = "\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff";
const HAN_RE = new RegExp(`[${HAN}]`);
const LATIN_RE = /[A-Za-z0-9]/;

function freeMask(len, protectedRanges) {
  const mask = new Uint8Array(len).fill(1); // 1 = 可整理
  for (const [from, to] of protectedRanges || [])
    for (let i = Math.max(0, from); i < Math.min(len, to); i++) mask[i] = 0;
  return mask;
}

function segments(mask) {
  const segs = [];
  let start = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && start < 0) start = i;
    if (!mask[i] && start >= 0) {
      segs.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) segs.push([start, mask.length]);
  return segs;
}

const HAN_LATIN_RE = new RegExp(`([${HAN}])([A-Za-z0-9])`, "g");
const LATIN_HAN_RE = new RegExp(`([A-Za-z0-9])([${HAN}])`, "g");

/** 中英/中数交界插入半角空格；幂等（已有空格时两字符不相邻，不会再次匹配）。
 * 传入 stats 对象时累加 stats.changes——改动处数在插入现场计，
 * 不做前后文本 diff：散布式小改动的掐头去尾 diff 会把中段整段算成改动（严重虚高） */
export function tidyMixedSpacing(text, protectedRanges, stats) {
  const mask = freeMask(text.length, protectedRanges);
  const count = () => (_m, a, b) => {
    if (stats) stats.changes++;
    return a + " " + b;
  };
  let out = "";
  let pos = 0;
  for (const [from, to] of segments(mask)) {
    out += text.slice(pos, from);
    out += text
      .slice(from, to)
      .replace(HAN_LATIN_RE, count())
      .replace(LATIN_HAN_RE, count());
    pos = to;
  }
  return out + text.slice(pos);
}

const PUNCT_MAP = { ",": "，", "!": "！", "?": "？", ":": "：", ";": "；", ".": "。" };

/**
 * 半角标点 → 全角（Telari 0.1.2「hang 标点」/ 0.5.3「纠正为全角」的守卫版）。
 * 逐字符判定（上下文取原文）：
 * - 前置字符必须是 CJK；
 * - 后随字符不得是字母/数字/下划线/同种半角标点——守卫三类误伤：
 *   文件名 `index.md`、版本号 `1.2.3` / `4.2`、省略号 `...`、英文列举 `a, b`；
 * - `(` 看后随是否 CJK，`)` 看前置是否 CJK（`foo(1)` 不动）。
 */
export function tidyFullWidthPunct(text, protectedRanges, stats) {
  const mask = freeMask(text.length, protectedRanges);
  const chars = text.split("");
  for (let i = 0; i < chars.length; i++) {
    if (!mask[i]) continue;
    const c = chars[i];
    const prev = i > 0 ? text[i - 1] : "";
    const next = i < text.length - 1 ? text[i + 1] : "";
    if (c === "(") {
      if (HAN_RE.test(next)) {
        chars[i] = "（";
        if (stats) stats.changes++;
      }
      continue;
    }
    if (c === ")") {
      if (HAN_RE.test(prev)) {
        chars[i] = "）";
        if (stats) stats.changes++;
      }
      continue;
    }
    if (!PUNCT_MAP[c]) continue;
    if (!HAN_RE.test(prev)) continue;
    if (LATIN_RE.test(next) || next === "_" || next === c || next === ".") continue;
    chars[i] = PUNCT_MAP[c];
    if (stats) stats.changes++;
  }
  return chars.join("");
}

/**
 * 一次跑完两遍整理。**先标点、后间距**：标点替换是 1:1 不换长度，
 * 而间距会插字符——若先跑间距，保护区间（按原文索引）会整体错位。
 * stats（可选）：{changes} 累计实际改动处数，toast 展示用。
 */
export function tidyText(text, protectedRanges, stats) {
  return tidyMixedSpacing(
    tidyFullWidthPunct(text, protectedRanges, stats),
    protectedRanges,
    stats
  );
}

/** ^^着重号^^ 扫描（单行文本，相对偏移）：跨行、空内容、`^^^` 连排均不匹配 */
export function findEmphasisSpans(lineText) {
  const spans = [];
  const re = /\^\^([^\n^]+)\^\^/g;
  let m;
  while ((m = re.exec(lineText))) {
    spans.push({
      from: m.index, // 整段（含 ^^）起点
      to: m.index + m[0].length,
      contentFrom: m.index + 2,
      contentTo: m.index + 2 + m[1].length,
    });
  }
  return spans;
}

/** 链接分类（Telari 0.5.0：网页实线 / 文件虚线）；带协议或 // 开头的算网页 */
export function classifyLinkHref(href) {
  const h = String(href || "").trim().toLowerCase();
  return /^(https?:|mailto:|data:|\/\/)/.test(h) ? "web" : "file";
}
