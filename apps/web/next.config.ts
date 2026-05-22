import type { NextConfig } from 'next';

const config: NextConfig = {
  // Standalone output → minimal production Docker image.
  output: 'standalone',
  reactStrictMode: true,
  // Transpile the shared contract package (it ships as TypeScript-built ESM).
  transpilePackages: ['@diet-app/shared'],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  },
};

export default config;
