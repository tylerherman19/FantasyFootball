import type { NextConfig } from 'next';

/**
 * Workspace packages are consumed as built output (`dist`) rather than raw
 * source, because TypeScript's NodeNext convention writes `./foo.js` for
 * imports that resolve to `foo.ts` and Turbopack does not remap that.
 */
const nextConfig: NextConfig = {
  /**
   * Model artifacts are read from disk at request time, and Next only traces
   * files it can see being imported. Without this the deployed app finds no
   * projections and every page renders empty — which looks like a data problem
   * and is actually a bundling one.
   */
  outputFileTracingRoot: `${process.cwd()}/../..`,
  outputFileTracingIncludes: {
    '/**': ['../../model/artifacts/**'],
  },
};

export default nextConfig;
