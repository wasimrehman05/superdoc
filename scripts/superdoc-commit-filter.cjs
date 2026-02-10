/**
 * Custom commit filter for the superdoc meta-package.
 *
 * Replaces `semantic-release-commit-filter` which only filters commits for a
 * single directory (the cwd). Since superdoc bundles code from multiple
 * sub-packages, we need git log to include commits touching any of them.
 *
 * Keep this list in sync with .github/workflows/release-superdoc.yml paths.
 */
'use strict';

const path = require('path');

const SUPERDOC_PACKAGES = [
  'packages/superdoc',
  'packages/super-editor',
  'packages/layout-engine',
  'packages/ai',
  'packages/word-layout',
  'packages/preset-geometry',
];

Object.keys(require.cache)
  .filter(m =>
    path.posix.normalize(m).endsWith('/node_modules/git-log-parser/src/index.js')
  )
  .forEach(moduleName => {
    const parse = require.cache[moduleName].exports.parse;
    require.cache[moduleName].exports.parse = (config, options) => {
      const repoRoot = path.resolve(options.cwd, '..', '..');
      const packagePaths = SUPERDOC_PACKAGES.map(p => path.join(repoRoot, p));

      if (Array.isArray(config._)) {
        config._.push(...packagePaths);
      } else if (config._) {
        config._ = [config._, ...packagePaths];
      } else {
        config._ = packagePaths;
      }

      return parse(config, options);
    };
  });
