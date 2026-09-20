import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The demo bundle (lib/generated/*) is produced by scripts/build-demo-bundle.mjs
  // from the real src/core, which lives outside this directory.
  outputFileTracingRoot: import.meta.dirname,
};

export default config;
