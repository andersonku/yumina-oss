import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { isLocalSandboxDocument, LOCAL_SANDBOX_CACHE_HEADERS, prepareSandboxAppShell } from "./local-sandbox-document.js";

test("a normal local app load bypasses the previously cached hashed iframe document", () => {
  const html = '<html><head><script type="module" src="/assets/main.js"></script><script>window.__YUMINA_SANDBOX_DOC_URL="/assets/sandbox-doc-old.html";</script></head><body></body></html>';
  const output = prepareSandboxAppShell(html, true);
  const context = { window: { __YUMINA_SANDBOX_DOC_URL: "" } };
  for (const [, code] of output.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInNewContext(code!, context);
  assert.equal(context.window.__YUMINA_SANDBOX_DOC_URL, "/sandbox/index.html");
  assert.ok(output.includes('type="module" src="/assets/main.js"'));
  assert.equal(prepareSandboxAppShell(html, false), html, "hosted builds retain their content-hashed URL");
});

test("local authored, hashed and stale alias documents all require fresh response headers", () => {
  for (const path of ["/sandbox/index.html", "/assets/sandbox-doc-79be2076.html", "/assets/sandbox-doc-stale.html"]) {
    assert.equal(isLocalSandboxDocument(path, true), true);
    assert.equal(isLocalSandboxDocument(path, false), false);
  }
  for (const path of ["/assets/sandbox.js", "/assets/main.js", "/assets/other.html", "/api/sessions"]) assert.equal(isLocalSandboxDocument(path, true), false);
  assert.equal(LOCAL_SANDBOX_CACHE_HEADERS["Cache-Control"], "no-store, no-cache, must-revalidate");
  assert.equal(LOCAL_SANDBOX_CACHE_HEADERS["CDN-Cache-Control"], "no-store");
  assert.equal(LOCAL_SANDBOX_CACHE_HEADERS["Surrogate-Control"], "no-store");
});
