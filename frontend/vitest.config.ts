import { defineConfig } from 'vitest/config';

// The pure layers (chart, timing math, judgment, scoring, engine, camera framing, lane state)
// run in the default `node` environment: the module graph under test deliberately avoids
// importing Web Audio, the DOM or a GPU context, so those tests stay fast and deterministic.
//
// The input, layout and orientation suites drive real DOM events, so they opt into jsdom with a
// `// @vitest-environment jsdom` docblock at the top of the file (jsdom is a devDependency).
// three.js is imported directly by a few tests for maths only (projection, instanced meshes);
// it needs no browser.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
