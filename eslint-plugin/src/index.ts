/**
 * ESLint Plugin for React Loop Detector
 *
 * This plugin provides single-file analysis rules to detect infinite re-render risks
 * in React hooks. For cross-file analysis, use the CLI tool (react-loop-detector).
 *
 * @example
 * ```javascript
 * // eslint.config.js
 * import reactLoopDetector from 'eslint-plugin-react-loop-detector';
 *
 * export default [
 *   {
 *     plugins: {
 *       'react-loop-detector': reactLoopDetector,
 *     },
 *     rules: {
 *       'react-loop-detector/no-render-phase-setstate': 'error',
 *       'react-loop-detector/no-effect-loop': 'error',
 *       'react-loop-detector/no-unstable-deps': 'warn',
 *       'react-loop-detector/no-missing-deps-array': 'error',
 *     },
 *   },
 * ];
 * ```
 */

import noRenderPhaseSetState from './rules/no-render-phase-setstate';
import noEffectLoop from './rules/no-effect-loop';
import noUnstableDeps from './rules/no-unstable-deps';
import noUnstableVariableDeps from './rules/no-unstable-variable-deps';
import noMissingDepsArray from './rules/no-missing-deps-array';
import noUnstableContextValue from './rules/no-unstable-context-value';
import noUnstableJsxProps from './rules/no-unstable-jsx-props';
import noUnstableKey from './rules/no-unstable-key';
import pkg from '../package.json';

const rules = {
  'no-render-phase-setstate': noRenderPhaseSetState,
  'no-effect-loop': noEffectLoop,
  'no-unstable-deps': noUnstableDeps,
  'no-unstable-variable-deps': noUnstableVariableDeps,
  'no-missing-deps-array': noMissingDepsArray,
  'no-unstable-context-value': noUnstableContextValue,
  'no-unstable-jsx-props': noUnstableJsxProps,
  'no-unstable-key': noUnstableKey,
};

const plugin = {
  meta: {
    name: pkg.name,
    version: pkg.version,
  },
  rules,
  configs: {} as Record<string, unknown>,
};

// Flat config format (ESLint 9+)
plugin.configs = {
  recommended: {
    plugins: {
      'react-loop-detector': plugin,
    },
    rules: {
      'react-loop-detector/no-render-phase-setstate': 'error',
      'react-loop-detector/no-effect-loop': 'error',
      'react-loop-detector/no-unstable-deps': 'warn',
      'react-loop-detector/no-unstable-variable-deps': 'error',
      'react-loop-detector/no-missing-deps-array': 'error',
      'react-loop-detector/no-unstable-context-value': 'error',
      'react-loop-detector/no-unstable-key': 'error',
      // no-unstable-jsx-props is off by default as it can be noisy
    },
  },
  strict: {
    plugins: {
      'react-loop-detector': plugin,
    },
    rules: {
      'react-loop-detector/no-render-phase-setstate': 'error',
      'react-loop-detector/no-effect-loop': 'error',
      'react-loop-detector/no-unstable-deps': 'error',
      'react-loop-detector/no-unstable-variable-deps': 'error',
      'react-loop-detector/no-missing-deps-array': 'error',
      'react-loop-detector/no-unstable-context-value': 'error',
      'react-loop-detector/no-unstable-jsx-props': 'warn',
      'react-loop-detector/no-unstable-key': 'error',
    },
  },
};

export = plugin;
