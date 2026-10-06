/** @type {import('next').NextConfig} */

const isStaticExport = process.env.NEXT_STATIC_EXPORT === "1";
const isProd = process.env.NODE_ENV === "production";

/** Hosts que o navegador pode chamar (RPC http/ws, API, S3 pré-assinado). */
function connectSources() {
  const out = new Set(["'self'", "https://*.amazonaws.com"]);
  for (const url of [
    process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com",
    process.env.NEXT_PUBLIC_RPC_URL_FALLBACK,
    process.env.NEXT_PUBLIC_API_URL,
  ]) {
    if (!url) continue;
    const u = new URL(url);
    out.add(`${u.protocol}//${u.host}`);
    if (u.protocol === "https:") out.add(`wss://${u.host}`); // confirmação de transação via websocket
  }
  if (!isProd) out.add("ws://localhost:*");
  return [...out].join(" ");
}

/**
 * Headers de segurança (PS-12). 'unsafe-inline' em script-src é exigido pelo
 * Next sem nonce (export estático); o ganho principal aqui é connect-src/img-src
 * restritos (dificulta exfiltrar o token) e frame-ancestors 'none'.
 * Com `output: 'export'` o Next não envia headers: replique-os no CloudFront
 * (response headers policy) ou no Amplify (customHttp) — ver docs/runbook.md.
 */
export function securityHeaders() {
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources()}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ];
  if (isProd) headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
  return headers;
}

const nextConfig = {
  reactStrictMode: true,
  // A página é 100% client-side: `output: 'export'` permite hospedar em S3+CloudFront.
  output: isStaticExport ? "export" : undefined,
  ...(isStaticExport ? {} : { headers: async () => [{ source: "/:path*", headers: securityHeaders() }] }),
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        os: false,
        path: false,
        crypto: false,
      };
      // Anchor / web3.js usam Buffer no navegador
      config.plugins.push(new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] }));
    }
    return config;
  },
};

export default nextConfig;
