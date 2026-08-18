import type { NextConfig } from 'next';

/**
 * Workspace packages are consumed as built output (`dist`) rather than raw
 * source. TypeScript's NodeNext convention writes `./foo.js` in imports that
 * resolve to `foo.ts`, which Turbopack does not remap — building first avoids
 * the mismatch entirely and keeps the app's bundle honest about what it ships.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
