import type { NextConfig } from 'next';

// Where the browser-facing `/api/*` path is proxied to. Server-to-server, so
// this is the API's internal address (the `api` service in Docker, or
// localhost for `npm run dev`) — never the public URL. Resolved at build time.
const API_PROXY_URL = process.env.API_PROXY_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  // Standalone output → minimal production Docker image.
  output: 'standalone',
  reactStrictMode: true,
  // Transpile the shared contract package (it ships as TypeScript-built ESM).
  transpilePackages: ['@diet-app/shared'],
  // Proxy `/api/*` to the backend so the browser only ever talks to its own
  // origin — no CORS, and the stack works via localhost, 127.0.0.1, a LAN IP
  // or a domain without reconfiguration.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_PROXY_URL}/api/:path*` }];
  },
};

export default config;
