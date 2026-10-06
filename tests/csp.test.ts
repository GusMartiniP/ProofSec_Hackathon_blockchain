/**
 * PS-47: o connect-src da CSP não pode liberar `*.amazonaws.com` quando o bucket de relatórios está
 * configurado (qualquer bucket/API AWS de terceiros serviria de destino de exfiltração do token).
 *
 *   npm --prefix agent exec tsx -- --test ../tests/csp.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

async function csp(env: Record<string, string | undefined>): Promise<string> {
  const keys = ["NEXT_PUBLIC_REPORTS_BUCKET", "NEXT_PUBLIC_REPORTS_REGION", "NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_RPC_URL"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    const mod = await import(`../frontend/next.config.mjs?${Math.random()}`);
    const h = mod.securityHeaders().find((x: { key: string }) => x.key === "Content-Security-Policy");
    return h.value as string;
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const connect = (v: string) => v.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src")) ?? "";

describe("CSP connect-src (PS-47)", () => {
  it("com o bucket configurado libera só o host dele, sem curinga da AWS", async () => {
    const c = connect(
      await csp({
        NEXT_PUBLIC_REPORTS_BUCKET: "proofsec-reports-dev-111122223333-us-east-1",
        NEXT_PUBLIC_API_URL: "https://abc123.execute-api.us-east-1.amazonaws.com",
      })
    );
    assert.ok(c.includes("https://proofsec-reports-dev-111122223333-us-east-1.s3.amazonaws.com"));
    assert.ok(c.includes("https://proofsec-reports-dev-111122223333-us-east-1.s3.us-east-1.amazonaws.com"));
    assert.ok(c.includes("https://abc123.execute-api.us-east-1.amazonaws.com"));
    assert.ok(!c.includes("*.amazonaws.com"), `curinga encontrado: ${c}`);
  });

  it("sem o bucket mantém o comportamento antigo (curinga) para não quebrar o upload", async () => {
    assert.ok(connect(await csp({})).includes("https://*.amazonaws.com"));
  });

  it("restante da política segue restritiva", async () => {
    const v = await csp({ NEXT_PUBLIC_REPORTS_BUCKET: "b" });
    assert.ok(v.includes("frame-ancestors 'none'"));
    assert.ok(v.includes("object-src 'none'"));
    assert.ok(v.includes("default-src 'self'"));
  });
});
