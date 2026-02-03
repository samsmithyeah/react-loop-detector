/**
 * Shared Utilities for React Loop Detector
 *
 * This module contains utility functions used across the analyzer modules.
 */

import * as t from '@babel/types';
import traverse from '@babel/traverse';
import { HookAnalysis, CreateAnalysisParams, AnalyzerOptions } from './types';

/**
 * Module-level options storage for helper functions.
 *
 * Note: This is intentional - the analyzer runs synchronously in a single thread,
 * and options are reset at the start of each analyzeHooks() call.
 * While passing options through the call chain would be more pure, the current
 * approach avoids threading options through 10+ function calls for a simple
 * config lookup. The tradeoff is acceptable since the analyzer is not concurrent.
 */
let currentOptions: AnalyzerOptions = {};

/**
 * Set the current analyzer options
 */
export function setCurrentOptions(options: AnalyzerOptions): void {
  currentOptions = options;
}

/**
 * Check if a hook at the given line should be ignored based on comments.
 * Supports:
 * - // rld-ignore (on same line)
 * - // rld-ignore-next-line (on previous line)
 * - Block comments with rld-ignore (inline or on same line)
 */
export function isHookIgnored(fileContent: string, hookLine: number): boolean {
  const lines = fileContent.split('\n');

  // Check the hook's line for inline ignore comment
  if (hookLine > 0 && hookLine <= lines.length) {
    const currentLine = lines[hookLine - 1];
    if (/\/\/\s*rld-ignore\b/.test(currentLine) || /\/\*\s*rld-ignore\s*\*\//.test(currentLine)) {
      return true;
    }
  }

  // Check the previous line for rld-ignore-next-line
  if (hookLine > 1 && hookLine <= lines.length) {
    const previousLine = lines[hookLine - 2];
    if (
      /\/\/\s*rld-ignore-next-line\b/.test(previousLine) ||
      /\/\*\s*rld-ignore-next-line\s*\*\//.test(previousLine)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a node contains another node (by reference)
 */
export function containsNode(tree: t.Node | null | undefined, target: t.Node): boolean {
  if (tree === target) return true;
  if (!tree || typeof tree !== 'object') return false;

  const indexableTree = tree as unknown as Record<string, unknown>;
  for (const key of Object.keys(tree)) {
    const value = indexableTree[key];
    if (Array.isArray(value)) {
      if (value.some((child) => containsNode(child as t.Node, target))) return true;
    } else if (value && typeof value === 'object') {
      if (containsNode(value as t.Node, target)) return true;
    }
  }

  return false;
}

/**
 * Create an analysis result object
 */
export function createAnalysis(params: CreateAnalysisParams): HookAnalysis {
  const result: HookAnalysis = {
    type: params.type,
    errorCode: params.errorCode,
    category: params.category,
    description: getDescriptionForErrorCode(params.errorCode, params.hookType),
    file: params.file,
    line: params.line,
    column: params.column,
    hookType: params.hookType,
    problematicDependency: params.problematicDependency,
    stateVariable: params.stateVariable,
    setterFunction: params.setterFunction,
    severity: params.severity,
    confidence: params.confidence,
    explanation: params.explanation,
    suggestion: params.suggestion,
    actualStateModifications: params.actualStateModifications,
    stateReads: params.stateReads,
  };

  // Only include debug info if debug mode is enabled
  if (currentOptions.debug && params.debugInfo) {
    result.debugInfo = params.debugInfo;
  }

  return result;
}

/**
 * Get a human-readable description for an error code
 */
function getDescriptionForErrorCode(errorCode: string, hookType: string): string {
  const descriptions: Record<string, string> = {
    'RLD-100': 'setState during render phase',
    'RLD-101': 'setState via function call during render',
    'RLD-200': 'Unconditional setState in effect dependency loop',
    'RLD-201': 'Missing dependency array with setState',
    'RLD-202': 'Unconditional setState in useLayoutEffect',
    'RLD-300': 'Cross-file infinite loop',
    'RLD-301': 'Cross-file conditional modification',
    'RLD-400': 'Unstable object in dependency array',
    'RLD-401': 'Unstable array in dependency array',
    'RLD-402': 'Unstable function in dependency array',
    'RLD-403': 'Unstable function call in dependency array',
    'RLD-404': 'Unstable Context.Provider value',
    'RLD-405': 'Unstable prop to memoized component',
    'RLD-406': 'Unstable callback in useCallback deps',
    'RLD-407': 'Unstable getSnapshot in useSyncExternalStore',
    'RLD-408': 'Unstable key prop causes remounting',
    'RLD-409': 'Index used as key',
    'RLD-410': 'Object spread guard may not prevent loop',
    'RLD-420': 'Memoized hook modifies its dependency',
    'RLD-500': 'Missing dependency array',
    'RLD-501': 'Conditional modification needs review',
    'RLD-600': 'Render-phase ref mutation with state value',
  };

  return descriptions[errorCode] || `${hookType} issue`;
}

/**
 * Check if a setter argument uses object spread with the state variable.
 * Examples that return true:
 * - `{ ...user, id: 5 }`
 * - `{ ...user }`
 * - `Object.assign({}, user, { id: 5 })`
 */
export function usesObjectSpread(setterArg: t.Node | null | undefined, stateVar: string): boolean {
  if (!setterArg) return false;

  // Check for object expression with spread: { ...stateVar, ... }
  if (setterArg.type === 'ObjectExpression') {
    for (const prop of setterArg.properties || []) {
      if (prop.type === 'SpreadElement') {
        // Check if spreading the state variable
        if (prop.argument?.type === 'Identifier' && prop.argument.name === stateVar) {
          return true;
        }
      }
    }
  }

  // Check for Object.assign({}, stateVar, ...)
  if (setterArg.type === 'CallExpression') {
    const callee = setterArg.callee;
    if (
      callee?.type === 'MemberExpression' &&
      callee.object?.type === 'Identifier' &&
      callee.object.name === 'Object' &&
      callee.property?.type === 'Identifier' &&
      callee.property.name === 'assign'
    ) {
      // Check if any argument is the state variable
      for (const arg of setterArg.arguments || []) {
        if (arg.type === 'Identifier' && arg.name === stateVar) {
          return true;
        }
      }
    }
  }

  // Check for array spread: [...items, newItem]
  if (setterArg.type === 'ArrayExpression') {
    for (const element of setterArg.elements || []) {
      if (element?.type === 'SpreadElement') {
        if (element.argument?.type === 'Identifier' && element.argument.name === stateVar) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Check if a condition references a state variable.
 * Uses @babel/traverse for robust traversal that handles all node types
 * including CallExpression arguments, computed properties, etc.
 */
export function conditionInvolvesState(
  condition: t.Node | null | undefined,
  stateVar: string
): boolean {
  if (!condition) return false;

  let found = false;

  // Using @babel/traverse is more robust than manual traversal
  // as it handles all node types and expression contexts correctly.
  traverse(condition, {
    noScope: true,
    Identifier(path) {
      if (path.node.name === stateVar && path.isReferencedIdentifier()) {
        found = true;
        path.stop();
      }
    },
  });

  return found;
}

/**
 * Check if a node is a memo() or React.memo() call expression.
 * This is used to detect memoized components for:
 * - Export detection in parser.ts
 * - Local component detection in jsx-prop-analyzer.ts
 *
 * Patterns detected:
 * - memo(Component)
 * - React.memo(Component)
 * - memo(() => ...)
 * - React.memo(function Component() { ... })
 */
export function isMemoCallExpression(node: t.Node | null | undefined): boolean {
  if (!node || !t.isCallExpression(node)) return false;
  const callee = node.callee;
  return (
    (t.isIdentifier(callee) && callee.name === 'memo') ||
    (t.isMemberExpression(callee) &&
      t.isIdentifier(callee.object) &&
      callee.object.name === 'React' &&
      t.isIdentifier(callee.property) &&
      callee.property.name === 'memo')
  );
}

/**
 * Check if strict mode (TypeScript type checking) is enabled.
 */
export function isStrictModeEnabled(): boolean {
  return currentOptions.strictMode === true;
}

/**
 * Confidence level type
 */
type ConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * Adjust confidence level based on analysis context to reduce false positives.
 *
 * This implements "heuristic downgrading" - when the analyzer uses heuristics
 * instead of definitive type information, we should be less confident.
 *
 * Downgrade rules:
 * 1. If not in strict mode and detection relies on type inference → max medium
 * 2. If cross-file chain is deeper than 2 levels → max medium
 * 3. If the detection is for conditional code paths → max medium
 *
 * @param baseConfidence - The initial confidence level from detection
 * @param context - Context about how the detection was made
 * @returns Adjusted confidence level
 */
// Note: _adjustConfidence is available for future use in analyzer modules
// that need to downgrade confidence based on context. Prefixed with _ to
// satisfy the linter since it's not yet used.
function _adjustConfidence(
  baseConfidence: ConfidenceLevel,
  context: {
    /** Whether type inference was used (e.g., heuristic-based stability detection) */
    usedTypeInference?: boolean;
    /** Depth of cross-file call chain (1 = direct, 2+ = indirect) */
    crossFileChainDepth?: number;
    /** Whether the setter is inside conditional code */
    isConditional?: boolean;
    /** Whether strict mode (TypeScript type checker) is enabled */
    isStrictMode?: boolean;
  }
): ConfidenceLevel {
  let confidence = baseConfidence;

  // Rule 1: If we used type inference without strict mode, downgrade from high to medium
  // Rationale: Without TypeScript's actual type information, we're guessing based on naming conventions
  if (context.usedTypeInference && !context.isStrictMode && confidence === 'high') {
    confidence = 'medium';
  }

  // Rule 2: Deep cross-file chains are hard to trace statically
  // More than 2 levels deep → downgrade from high to medium
  if (context.crossFileChainDepth && context.crossFileChainDepth > 2 && confidence === 'high') {
    confidence = 'medium';
  }

  // Rule 3: Conditional setters are inherently uncertain
  // We can't know at static analysis time if the condition will prevent the loop
  if (context.isConditional && confidence === 'high') {
    confidence = 'medium';
  }

  return confidence;
}

/**
 * Generate explanation suffix for why confidence was adjusted.
 * Returns an empty string if no adjustment was made or if context doesn't require explanation.
 */
export function getConfidenceExplanation(
  confidence: ConfidenceLevel,
  context: {
    usedTypeInference?: boolean;
    crossFileChainDepth?: number;
    isConditional?: boolean;
    isStrictMode?: boolean;
  }
): string {
  const reasons: string[] = [];

  if (context.usedTypeInference && !context.isStrictMode) {
    reasons.push('type information is inferred (enable --strict for higher accuracy)');
  }

  if (context.crossFileChainDepth && context.crossFileChainDepth > 2) {
    reasons.push(`involves a ${context.crossFileChainDepth}-level cross-file dependency chain`);
  }

  if (context.isConditional) {
    reasons.push('the setState is inside a conditional block');
  }

  if (reasons.length === 0) {
    return '';
  }

  return ` Confidence is ${confidence} because ${reasons.join(', ')}.`;
}

/**
 * Check if console logging should be enabled.
 * Returns false during tests or when JSON/SARIF/quiet output is requested.
 */
export function shouldLogToConsole(): boolean {
  return (
    process.env.NODE_ENV !== 'test' &&
    !process.argv.includes('--json') &&
    !process.argv.includes('--sarif') &&
    !process.argv.includes('--quiet')
  );
}
