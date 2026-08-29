import { fileURLToPath } from 'node:url';
import { coverageConfigDefaults, defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  // Resolve the tsconfig path alias explicitly; `*.spec.ts` files are excluded
  // from tsconfig.json (they live in tsconfig.spec.json), so a tsconfig-driven
  // plugin would not map `@/…` for them.
  resolve: {
    alias: [{ find: /^@\//, replacement: `${srcDir}/` }],
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      // Narrows the untested-file scan to src. Vitest 3 already pulls
      // unimported files into the denominator via the coverage.all default;
      // vitest 4 removes that option and requires an explicit include for a
      // new src file that no spec imports to keep reporting at 0%.
      include: ['src/**/*.ts'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        // Manual smoke script against a live system, not a test.
        'scripts/**',
        // Re-export barrel; no logic of its own.
        'src/index.ts',
        // Types only; no runtime exports for v8 to see.
        'src/catalog/tool.ts',
        // Fixtures the specs import, not code under test. Counted, they would
        // report 100% and move the global percentages without a line of the
        // library being tested any better.
        'src/testing/**',
      ],
      // Floors, not targets: set at the measured level so a decrease fails CI.
      // Raised by hand in the same PR that raises the coverage — never lowered,
      // never auto-updated. See docs/testing-plan.md in truenas-mcp-server.
      // Branch is the primary gate; the statements floor exists because v8
      // reports a file that no test touches as 100% branch (no branches
      // recorded), so a branch-only floor cannot see a file losing all its
      // tests at once.
      thresholds: {
        branches: 96,
        statements: 97,
        // Per-file floors on the files where the safety model lives. A key
        // that matches no file passes vacuously, so renaming one of these
        // files must carry its key along or the floor silently disappears.
        'src/execution/executor.ts': { branches: 95, statements: 97 },
        'src/registry/system-registry.ts': { branches: 96, statements: 97 },
        'src/execution/confirmation.ts': { branches: 97, statements: 97 },
        'src/catalog/catalog.ts': { branches: 95, statements: 96 },
        // The content seam holds two invariants nothing else can: the byte
        // bound, and the download URL never reaching a caller.
        'src/content/file-content.ts': { branches: 100, statements: 100 },
      },
    },
  },
});
