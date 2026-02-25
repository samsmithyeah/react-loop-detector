/**
 * Shared utilities for ESLint rules
 */

import type { TSESTree, TSESLint } from '@typescript-eslint/utils';

/**
 * React hooks that create state
 */
export const STATE_HOOKS = new Set(['useState', 'useReducer']);

/**
 * React hooks that accept a callback and dependency array
 */
export const EFFECT_HOOKS = new Set([
  'useEffect',
  'useLayoutEffect',
  'useCallback',
  'useMemo',
  'useImperativeHandle',
]);

/**
 * React hooks that return stable references
 */
const STABLE_HOOKS = new Set(['useRef', 'useId']);

/**
 * Built-in functions that return primitive values
 */
const STABLE_FUNCTION_CALLS = new Set([
  'require',
  'String',
  'Number',
  'Boolean',
  'parseInt',
  'parseFloat',
]);

/**
 * Method calls that return primitive values
 */
const PRIMITIVE_RETURNING_METHODS = new Set([
  // String methods
  'join',
  'toString',
  'toLocaleString',
  'valueOf',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'substring',
  'substr',
  'slice',
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'normalize',
  'padStart',
  'padEnd',
  'repeat',
  'replace',
  'replaceAll',
  // Number methods
  'toFixed',
  'toExponential',
  'toPrecision',
  // Array methods that return primitives
  'indexOf',
  'lastIndexOf',
  'length',
  // Boolean checks
  'includes',
  'startsWith',
  'endsWith',
  'every',
  'some',
  // Collection/Web API methods that return primitives
  // e.g., URLSearchParams.get() returns string|null, Headers.get() returns string|null
  'get',
  // e.g., URLSearchParams.has(), Map.has(), Set.has() return boolean
  'has',
]);

/**
 * Static methods on built-in objects that return primitives
 */
const PRIMITIVE_RETURNING_STATIC_METHODS: Record<string, Set<string>> = {
  Math: new Set([
    'abs',
    'acos',
    'acosh',
    'asin',
    'asinh',
    'atan',
    'atan2',
    'atanh',
    'cbrt',
    'ceil',
    'clz32',
    'cos',
    'cosh',
    'exp',
    'expm1',
    'floor',
    'fround',
    'hypot',
    'imul',
    'log',
    'log10',
    'log1p',
    'log2',
    'max',
    'min',
    'pow',
    'random',
    'round',
    'sign',
    'sin',
    'sinh',
    'sqrt',
    'tan',
    'tanh',
    'trunc',
  ]),
  Number: new Set(['isFinite', 'isInteger', 'isNaN', 'isSafeInteger', 'parseFloat', 'parseInt']),
  String: new Set(['fromCharCode', 'fromCodePoint']),
  Object: new Set(['is', 'hasOwn']),
  Array: new Set(['isArray']),
  Date: new Set(['now', 'parse', 'UTC']),
  JSON: new Set(['stringify']),
};

/**
 * Check if a name looks like a React component (PascalCase)
 */
export function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/**
 * Check if a name looks like a state setter (setXxx)
 */
export function isSetterName(name: string): boolean {
  return name.startsWith('set') && name.length > 3 && name[3] === name[3].toUpperCase();
}

/**
 * Check if a name looks like a custom hook (useXxx)
 */
function isHookName(name: string): boolean {
  return name.startsWith('use') && name.length > 3;
}

/**
 * Get the state variable name from a setter name
 * e.g., setCount -> count
 */
export function getStateNameFromSetter(setterName: string): string {
  return setterName.charAt(3).toLowerCase() + setterName.slice(4);
}

/**
 * Check if a call is a stable function call (returns primitive or stable value)
 */
export function isStableFunctionCall(node: TSESTree.CallExpression): boolean {
  const { callee } = node;

  // Check built-in stable functions
  if (callee.type === 'Identifier') {
    if (STABLE_FUNCTION_CALLS.has(callee.name)) {
      return true;
    }
    // React hooks that return stable values
    if (STABLE_HOOKS.has(callee.name)) {
      return true;
    }
    // Custom hooks are treated as stable by default (configurable)
    if (isHookName(callee.name)) {
      return true;
    }
  }

  // Check method calls that return primitives
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    const methodName = callee.property.name;

    if (PRIMITIVE_RETURNING_METHODS.has(methodName)) {
      return true;
    }

    // Check static methods
    if (callee.object.type === 'Identifier') {
      const objectName = callee.object.name;
      const staticMethods = PRIMITIVE_RETURNING_STATIC_METHODS[objectName];
      if (staticMethods?.has(methodName)) {
        return true;
      }
    }

    // Zustand pattern: getState()
    if (methodName === 'getState') {
      return true;
    }
  }

  return false;
}

/**
 * Check if a value is an AST node
 */
function isAstNode(value: unknown): value is TSESTree.Node {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string'
  );
}

/**
 * Result from finding setter calls - includes the node, setter name, and associated state
 */
interface SetterCallInfo {
  node: TSESTree.CallExpression;
  setter: string;
  state: string | null;
}

/**
 * Find all setter calls in a function body.
 * Returns an array of setter call information.
 *
 * @param body - The AST node to search
 * @param getStateFn - Function to get the state name from a setter name (returns null if not a setter)
 */
export function findSetterCallsWithInfo(
  body: TSESTree.Node,
  getStateFn: (name: string) => string | null
): SetterCallInfo[] {
  const calls: SetterCallInfo[] = [];
  const visited = new WeakSet<TSESTree.Node>();

  function visit(node: TSESTree.Node) {
    if (visited.has(node)) return;
    visited.add(node);

    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
      const setterName = node.callee.name;
      const state = getStateFn(setterName);

      if (state !== null) {
        calls.push({ node: node as TSESTree.CallExpression, setter: setterName, state });
      }
    }

    // Recursively visit children (skip 'parent' and 'loc' to avoid non-node objects)
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (isAstNode(item)) {
              visit(item);
            }
          }
        } else if (isAstNode(value)) {
          visit(value);
        }
      }
    }
  }

  visit(body);
  return calls;
}

/**
 * Find all setter calls in a function body.
 * Returns an array of setter names found.
 * This is a simpler version that just returns the names.
 *
 * @param body - The AST node to search
 * @param isSetterFn - Function to check if a name is a setter
 */
export function findSetterCallsInBody(
  body: TSESTree.Node,
  isSetterFn: (name: string) => boolean
): string[] {
  const result = findSetterCallsWithInfo(body, (name) => (isSetterFn(name) ? name : null));
  return result.map((info) => info.setter);
}

/**
 * Check if a node should be ignored based on rld-ignore comments.
 * Supports:
 * - // rld-ignore (on same line)
 * - // rld-ignore-next-line (on previous line)
 * - Block comments with rld-ignore (inline or on same line)
 *
 * This provides unified ignore comment support between the CLI/VS Code extension
 * and the ESLint plugin.
 *
 * @param sourceCode - The ESLint source code object
 * @param node - The AST node to check
 * @returns true if the node should be ignored
 */
export function isNodeRldIgnored(sourceCode: TSESLint.SourceCode, node: TSESTree.Node): boolean {
  const nodeLine = node.loc.start.line;
  const lines = sourceCode.getLines();

  // Check the node's line for inline ignore comment
  if (nodeLine > 0 && nodeLine <= lines.length) {
    const currentLine = lines[nodeLine - 1];
    if (/\/\/\s*rld-ignore\b/.test(currentLine) || /\/\*\s*rld-ignore\s*\*\//.test(currentLine)) {
      return true;
    }
  }

  // Check the previous line for rld-ignore-next-line
  if (nodeLine > 1 && nodeLine <= lines.length) {
    const previousLine = lines[nodeLine - 2];
    if (
      /\/\/\s*rld-ignore-next-line\b/.test(previousLine) ||
      /\/\*\s*rld-ignore-next-line\s*\*\//.test(previousLine)
    ) {
      return true;
    }
  }

  return false;
}
