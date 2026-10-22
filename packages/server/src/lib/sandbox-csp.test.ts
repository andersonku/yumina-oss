import assert from "node:assert/strict";
import test from "node:test";
import { sandboxContentSecurityPolicy } from "./sandbox-csp.js";

function directives(policy: string) {
  return new Map(policy.split("; ").map(directive => {
    const [name, ...sources] = directive.split(" ");
    return [name!, sources];
  }));
}

for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "http://192.168.1.10:8080"]) {
  test(`local sandbox authorizes assets from its exact HTTP origin: ${origin}`, () => {
    const policy = directives(sandboxContentSecurityPolicy(`${origin}/assets/sandbox-doc-fixture.html?parentOrigin=ignored`, true));
    for (const directive of ["default-src", "img-src", "font-src", "media-src"]) {
      assert.ok(policy.get(directive)?.includes(origin));
      assert.equal(policy.get(directive)?.includes("http:"), false, "other HTTP origins stay blocked");
    }
    assert.deepEqual(policy.get("connect-src"), ["'none'"]);
    assert.deepEqual(policy.get("frame-ancestors"), ["'self'"]);
    assert.equal(policy.get("frame-src")?.includes(origin), false);
  });
}

test("hosted and HTTPS sandbox policies preserve existing asset restrictions", () => {
  const hosted = sandboxContentSecurityPolicy("https://yumina.io/assets/sandbox-doc-fixture.html", false);
  assert.equal(sandboxContentSecurityPolicy("http://localhost:3000/sandbox/index.html", false), hosted);
  assert.equal(sandboxContentSecurityPolicy("https://local.example/sandbox/index.html", true), hosted);
  assert.deepEqual(directives(hosted).get("default-src"), ["https:", "'unsafe-inline'", "'unsafe-eval'"]);
});
