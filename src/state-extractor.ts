/**
 * State Extractor Module
 *
 * Extracts state variables, ref variables, and unstable local variables from React components.
 * This module handles:
 * - useState/useReducer state extraction
 * - useRef variable tracking
 * - Custom hook state patterns
 * - useContext destructuring patterns
 * - Unstable variable detection (objects, arrays, functions created in component body)
 * - Stability heuristics for function calls
 */

import * as t from '@babel/types';
import traverse, { NodePath } from '@babel/traverse';
import { TypeChecker } from './type-checker';

/** Information about a local variable that may be recreated on each render */
export interface UnstableVariable {
  name: string;
  type: 'object' | 'array' | 'function' | 'function-call';
  line: number;
  /** True if wrapped in useMemo/useCallback/useRef */
  isMemoized: boolean;
  /** True if defined at module level (outside component) */
  isModuleLevel: boolean;
  /** Name of the component that contains this variable (for per-component scoping) */
  componentName?: string;
  /** Start line of the component that contains this variable */
  componentStartLine?: number;
  /** End line of the component that contains this variable */
  componentEndLine?: number;
}

export interface StateAndRefInfo {
  stateVariables: Map<string, string>; // state var -> setter name
  refVariables: Set<string>; // ref variable names
}

/** Function calls that return stable/primitive values */
const STABLE_FUNCTION_CALLS = new Set([
  'require',
  'String',
  'Number',
  'Boolean',
  'parseInt',
  'parseFloat',
]);

/**
 * Method calls that return primitive values (string, number, boolean).
 * Primitives are compared by value, not reference, so they're stable.
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
  'length', // Not a method but included for member expressions
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
  // Reduce can return primitives (commonly does)
  // Note: We'll be conservative here - reduce CAN return objects
]);

/**
 * Static methods on built-in objects that return primitives.
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
  JSON: new Set(['stringify']), // Returns string
};

/**
 * React hooks that are guaranteed to return stable values/references.
 * Note: useState and useReducer return tuples where the setter/dispatch is stable,
 * but we handle those via destructuring patterns separately.
 * Custom hooks (any other `use*` function) are NOT assumed stable since they
 * can return new objects or arrays on every render.
 */
const STABLE_REACT_HOOKS = new Set([
  'useRef', // Returns stable ref object
  'useId', // Returns stable string ID
]);

/**
 * State hooks that return [state, setter] tuples.
 * These are handled specially since both the state and setter are stable.
 */
const STATE_HOOKS = new Set(['useState', 'useReducer']);

/**
 * Check if a call expression is a state hook (useState or useReducer).
 * Handles both direct calls (useState) and namespaced calls (React.useState).
 */
function isStateHookCall(node: t.CallExpression): boolean {
  const callee = node.callee;

  // Direct call: useState() or useReducer()
  if (t.isIdentifier(callee) && STATE_HOOKS.has(callee.name)) {
    return true;
  }

  // Namespaced call: React.useState() or React.useReducer()
  if (
    t.isMemberExpression(callee) &&
    t.isIdentifier(callee.object) &&
    callee.object.name === 'React' &&
    t.isIdentifier(callee.property) &&
    STATE_HOOKS.has(callee.property.name)
  ) {
    return true;
  }

  return false;
}

/**
 * Check if a call expression is useRef.
 * Handles both direct calls (useRef) and namespaced calls (React.useRef).
 */
function isRefHookCall(node: t.CallExpression): boolean {
  const callee = node.callee;

  // Direct call: useRef()
  if (t.isIdentifier(callee) && callee.name === 'useRef') {
    return true;
  }

  // Namespaced call: React.useRef()
  if (
    t.isMemberExpression(callee) &&
    t.isIdentifier(callee.object) &&
    callee.object.name === 'React' &&
    t.isIdentifier(callee.property) &&
    callee.property.name === 'useRef'
  ) {
    return true;
  }

  return false;
}

/**
 * Context for type-aware stability checking
 */
export interface StabilityCheckContext {
  filePath?: string;
  line?: number;
}

/**
 * Configuration context for stability checking
 */
export interface StabilityConfig {
  stableHooks?: string[];
  unstableHooks?: string[];
  /** Regex patterns for hooks that return stable references (e.g., /^use\w+Store$/ for Zustand) */
  stableHookPatterns?: RegExp[];
  /** Regex patterns for hooks that return unstable references */
  unstableHookPatterns?: RegExp[];
  customFunctions?: Record<
    string,
    {
      stable?: boolean;
      deferred?: boolean;
    }
  >;
}

/**
 * Check if a hook is configured as stable via options (includes pattern matching)
 */
export function isConfiguredStableHook(hookName: string, config: StabilityConfig): boolean {
  // Check explicit list first
  if (config.stableHooks?.includes(hookName)) {
    return true;
  }
  // Check patterns
  if (config.stableHookPatterns?.some((pattern) => pattern.test(hookName))) {
    return true;
  }
  return false;
}

/**
 * Check if a hook is configured as unstable via options (includes pattern matching)
 */
export function isConfiguredUnstableHook(hookName: string, config: StabilityConfig): boolean {
  // Check explicit list first
  if (config.unstableHooks?.includes(hookName)) {
    return true;
  }
  // Check patterns
  if (config.unstableHookPatterns?.some((pattern) => pattern.test(hookName))) {
    return true;
  }
  return false;
}

/**
 * Check if a function is configured as stable via options
 * Reserved for future use when customFunctions config is fully integrated
 */
export function isConfiguredStableFunction(functionName: string, config: StabilityConfig): boolean {
  return config.customFunctions?.[functionName]?.stable ?? false;
}

/**
 * Check if a function is configured as deferred (async) via options
 * Reserved for future use when customFunctions config is fully integrated
 */
export function isConfiguredDeferredFunction(
  functionName: string,
  config: StabilityConfig
): boolean {
  return config.customFunctions?.[functionName]?.deferred ?? false;
}

/**
 * Check if a function call returns a stable type using TypeScript type checker.
 * Returns null if type checker is not available or cannot determine stability.
 */
export function checkFunctionReturnStability(
  typeChecker: TypeChecker | null,
  filePath: string,
  line: number,
  functionName: string
): boolean | null {
  if (!typeChecker) {
    return null;
  }

  try {
    const returnInfo = typeChecker.getFunctionReturnType(filePath, line, functionName);
    if (!returnInfo) {
      return null;
    }
    return returnInfo.isStableReturn;
  } catch {
    return null;
  }
}

/**
 * Check if a CallExpression is a stable function call (returns primitive or stable value)
 *
 * Check order (IMPORTANT - presets must override TypeChecker):
 * 1. Built-in React hooks (STABLE_REACT_HOOKS)
 * 2. Known stable function calls (require, String, Number, etc.)
 * 3. User config + library presets (stableHooks, unstableHooks, patterns)
 * 4. TypeScript type checker (strict mode only, for unknown hooks)
 * 5. use* heuristic (fallback for unrecognized hooks)
 *
 * This order ensures that library presets (Zustand, expo-router, etc.) take
 * precedence over TypeScript type analysis, preventing false positives for
 * libraries that return stable references but have object return types.
 */
export function isStableFunctionCall(
  init: t.CallExpression,
  context?: StabilityCheckContext,
  typeChecker?: TypeChecker | null,
  config?: StabilityConfig
): boolean {
  const callee = init.callee;

  // 1. Built-in React hooks are guaranteed to return stable references
  if (t.isIdentifier(callee) && STABLE_REACT_HOOKS.has(callee.name)) {
    return true;
  }

  // 2. Known stable function calls (require, String, Number, etc.)
  if (t.isIdentifier(callee) && STABLE_FUNCTION_CALLS.has(callee.name)) {
    return true;
  }

  // 3. Check user-configured stable/unstable hooks BEFORE TypeChecker
  // This ensures library presets (Zustand, expo-router) override TypeScript analysis
  if (t.isIdentifier(callee) && config) {
    // If explicitly marked as unstable in config, return false
    if (isConfiguredUnstableHook(callee.name, config)) {
      return false;
    }
    // If explicitly marked as stable in config (or matches a pattern), return true
    if (isConfiguredStableHook(callee.name, config)) {
      return true;
    }
  }

  // 4. In strict mode with type checker, use actual types for UNKNOWN hooks only
  // This runs AFTER preset checks, so known-stable libraries won't be flagged
  if (typeChecker && context?.filePath && context?.line) {
    let functionName: string | null = null;

    if (t.isIdentifier(callee)) {
      functionName = callee.name;
    } else if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
      functionName = callee.property.name;
    }

    if (functionName) {
      const typeStability = checkFunctionReturnStability(
        typeChecker,
        context.filePath,
        context.line,
        functionName
      );
      if (typeStability !== null) {
        // Type checker gave us a definitive answer for this unknown hook
        return typeStability;
      }
      // Fall through to heuristics if type checker couldn't determine
    }
  }

  // 5. Custom hooks (use* prefix) are treated as stable by default (fallback heuristic)
  // Rationale: Most custom hooks in real apps either:
  // - Return values from state management (Zustand, Redux, etc.) - stable references
  // - Return primitives - stable by value
  // - Memoize their return values internally
  // Treating them as unstable causes too many false positives in practice.
  // If a custom hook genuinely returns new objects, users can configure it via unstableHooks.
  if (t.isIdentifier(callee) && callee.name.startsWith('use')) {
    return true;
  }

  // Check for method calls that return primitives (e.g., array.join(), string.slice())
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
    const methodName = callee.property.name;

    // Methods that return primitives (strings, numbers, booleans)
    if (PRIMITIVE_RETURNING_METHODS.has(methodName)) {
      return true;
    }

    // Check for static methods on built-in objects (e.g., Math.round(), Date.now())
    if (t.isIdentifier(callee.object)) {
      const objectName = callee.object.name;
      const staticMethods = PRIMITIVE_RETURNING_STATIC_METHODS[objectName];
      if (staticMethods?.has(methodName)) {
        return true;
      }
    }

    // Zustand/store pattern: store.getState() returns stable references
    // Pattern: useXxxStore.getState() or xxxStore.getState()
    if (methodName === 'getState') {
      return true;
    }
  }

  return false;
}

/**
 * Determine the appropriate type for an unstable variable based on its initializer
 */
export function getUnstableVarType(
  init: t.Expression | null | undefined
): UnstableVariable['type'] {
  if (t.isArrayExpression(init)) return 'array';
  if (t.isObjectExpression(init)) return 'object';
  if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) return 'function';
  return 'function-call';
}

/**
 * Recursively extract all identifier names from a destructuring pattern.
 * Handles nested patterns like: const { data: { user } } = obj
 * or: const [a, [b, c]] = arr
 */
export function extractIdentifiersFromPattern(pattern: t.LVal): string[] {
  const identifiers: string[] = [];

  if (t.isIdentifier(pattern)) {
    identifiers.push(pattern.name);
  } else if (t.isArrayPattern(pattern)) {
    for (const element of pattern.elements) {
      if (element && t.isLVal(element)) {
        identifiers.push(...extractIdentifiersFromPattern(element));
      }
    }
  } else if (t.isObjectPattern(pattern)) {
    for (const prop of pattern.properties) {
      if (t.isObjectProperty(prop)) {
        // The value could be an identifier or another pattern
        identifiers.push(...extractIdentifiersFromPattern(prop.value as t.LVal));
      } else if (t.isRestElement(prop)) {
        identifiers.push(...extractIdentifiersFromPattern(prop.argument));
      }
    }
  } else if (t.isRestElement(pattern)) {
    identifiers.push(...extractIdentifiersFromPattern(pattern.argument));
  } else if (t.isAssignmentPattern(pattern)) {
    // Handle default values: const { a = 1 } = obj or const [a = 1] = arr
    identifiers.push(...extractIdentifiersFromPattern(pattern.left));
  }

  return identifiers;
}

/** Component boundary information for unstable variable tracking */
interface ComponentBoundaryInfo {
  name: string;
  startLine: number;
  endLine: number;
}

/**
 * Check if an initializer is an unstable source and add all destructured identifiers
 * to the unstable variables map if so.
 */
export function addUnstableDestructuredVariables(
  id: t.LVal,
  init: t.Expression | null | undefined,
  line: number,
  unstableVars: Map<string, UnstableVariable>,
  filePath?: string,
  typeChecker?: TypeChecker | null,
  config?: StabilityConfig,
  componentBoundary?: ComponentBoundaryInfo
): void {
  if (!init) return;

  const context: StabilityCheckContext | undefined = filePath ? { filePath, line } : undefined;
  const isUnstableSource =
    (t.isCallExpression(init) && !isStableFunctionCall(init, context, typeChecker, config)) ||
    t.isArrayExpression(init) ||
    t.isObjectExpression(init);

  if (isUnstableSource) {
    const varType = getUnstableVarType(init);
    for (const name of extractIdentifiersFromPattern(id)) {
      const key = componentBoundary ? `${componentBoundary.name}:${name}` : name;
      unstableVars.set(key, {
        name,
        type: varType,
        line,
        isMemoized: false,
        isModuleLevel: !componentBoundary,
        componentName: componentBoundary?.name,
        componentStartLine: componentBoundary?.startLine,
        componentEndLine: componentBoundary?.endLine,
      });
    }
  }
}

/**
 * Extract state variables and their setters from an AST.
 * Handles:
 * - useState: const [state, setState] = useState(...)
 * - useReducer: const [state, dispatch] = useReducer(...)
 * - Custom hooks: const [state, setState] = useCustomHook(...)
 * - useContext: const { data, setData } = useContext(...)
 * - useRef: const ref = useRef(...)
 */
export function extractStateInfo(ast: t.Node): StateAndRefInfo {
  const stateVariables = new Map<string, string>(); // state var -> setter name
  const refVariables = new Set<string>(); // ref variable names

  traverse(ast, {
    VariableDeclarator(nodePath: NodePath<t.VariableDeclarator>) {
      // Extract useRef patterns: const myRef = useRef(...)
      if (
        t.isIdentifier(nodePath.node.id) &&
        t.isCallExpression(nodePath.node.init) &&
        t.isIdentifier(nodePath.node.init.callee) &&
        nodePath.node.init.callee.name === 'useRef'
      ) {
        refVariables.add(nodePath.node.id.name);
      }
      // Extract useState/useReducer patterns: const [state, setState] = useState(...)
      // or const [state, dispatch] = useReducer(...)
      // Handles both: useState() and React.useState()
      if (
        t.isArrayPattern(nodePath.node.id) &&
        t.isCallExpression(nodePath.node.init) &&
        isStateHookCall(nodePath.node.init)
      ) {
        const elements = nodePath.node.id.elements;
        if (elements.length >= 2 && t.isIdentifier(elements[0]) && t.isIdentifier(elements[1])) {
          const stateVar = elements[0].name;
          const setter = elements[1].name;
          stateVariables.set(stateVar, setter);
        }
      }

      // Extract custom hook patterns: const [state, setState] = useCustomHook(...)
      // Custom hooks start with 'use' and return array destructuring
      if (
        t.isArrayPattern(nodePath.node.id) &&
        t.isCallExpression(nodePath.node.init) &&
        t.isIdentifier(nodePath.node.init.callee) &&
        nodePath.node.init.callee.name.startsWith('use') &&
        nodePath.node.init.callee.name !== 'useState'
      ) {
        const elements = nodePath.node.id.elements;
        if (elements.length >= 2 && t.isIdentifier(elements[0]) && t.isIdentifier(elements[1])) {
          const firstElement = elements[0].name;
          const secondElement = elements[1].name;

          // Check if second element looks like a setter (starts with 'set' + uppercase)
          if (
            secondElement.startsWith('set') &&
            secondElement.length > 3 &&
            secondElement[3] === secondElement[3].toUpperCase()
          ) {
            stateVariables.set(firstElement, secondElement);
          }
        }
      }

      // Extract useContext patterns: const { data, setData } = useContext(MyContext)
      if (
        t.isObjectPattern(nodePath.node.id) &&
        t.isCallExpression(nodePath.node.init) &&
        t.isIdentifier(nodePath.node.init.callee) &&
        nodePath.node.init.callee.name === 'useContext'
      ) {
        const properties = nodePath.node.id.properties;
        const extractedNames: string[] = [];

        // First pass: collect all destructured names
        for (const prop of properties) {
          if (t.isObjectProperty(prop) && t.isIdentifier(prop.value)) {
            extractedNames.push(prop.value.name);
          } else if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
            extractedNames.push(prop.key.name);
          }
        }

        // Second pass: match setters with state variables
        for (const name of extractedNames) {
          // Check if this is a setter (starts with 'set' + uppercase)
          if (name.startsWith('set') && name.length > 3 && name[3] === name[3].toUpperCase()) {
            // Try to find corresponding state variable
            const stateVar = name.charAt(3).toLowerCase() + name.slice(4);
            if (extractedNames.includes(stateVar)) {
              stateVariables.set(stateVar, name);
            }
          }
        }
      }
    },
  });

  return { stateVariables, refVariables };
}

/**
 * Extract local variables that are potentially unstable (recreated on each render).
 * This includes object literals, array literals, functions, and function call results
 * that are defined inside a component but not wrapped in useMemo/useCallback/useRef.
 *
 * @param ast - The AST node to analyze
 * @param filePath - Optional file path for type-aware stability checking in strict mode
 * @param typeChecker - Optional TypeScript type checker for strict mode
 * @param config - Optional stability configuration
 */
export function extractUnstableVariables(
  ast: t.Node,
  filePath?: string,
  typeChecker?: TypeChecker | null,
  config?: StabilityConfig
): Map<string, UnstableVariable> {
  const unstableVars = new Map<string, UnstableVariable>();
  // Track memoized vars per component (key: "componentName:varName" or just "varName" for module level)
  const memoizedVars = new Map<string, Set<string>>();
  const stateVars = new Set<string>();
  const refVars = new Set<string>();

  // Track which function scopes we're in - now as a stack to handle nesting
  const componentStack: ComponentBoundaryInfo[] = [];
  const moduleLevelVars = new Set<string>();

  // Helper to get current component info
  const getCurrentComponent = (): ComponentBoundaryInfo | undefined => {
    return componentStack.length > 0 ? componentStack[componentStack.length - 1] : undefined;
  };

  // Helper to mark a variable as memoized in current scope
  const markMemoizedInCurrentScope = (varName: string): void => {
    const currentComp = getCurrentComponent();
    const key = currentComp?.name ?? '__module__';
    if (!memoizedVars.has(key)) {
      memoizedVars.set(key, new Set());
    }
    memoizedVars.get(key)!.add(varName);
  };

  traverse(ast, {
    // Track function component boundaries
    FunctionDeclaration: {
      enter(nodePath: NodePath<t.FunctionDeclaration>) {
        // Check if this looks like a React component (PascalCase name)
        const name = nodePath.node.id?.name;
        if (name && /^[A-Z]/.test(name)) {
          componentStack.push({
            name,
            startLine: nodePath.node.loc?.start.line || 0,
            endLine: nodePath.node.loc?.end.line || 0,
          });
        }
      },
      exit(nodePath: NodePath<t.FunctionDeclaration>) {
        const name = nodePath.node.id?.name;
        if (name && /^[A-Z]/.test(name)) {
          componentStack.pop();
        }
      },
    },

    // Track arrow function components assigned to variables
    VariableDeclarator(nodePath: NodePath<t.VariableDeclarator>) {
      const id = nodePath.node.id;
      const init = nodePath.node.init;
      const line = nodePath.node.loc?.start.line || 0;

      // Handle array destructuring: const [a, b] = ... or const [a, [b, c]] = ...
      if (t.isArrayPattern(id)) {
        // Track array destructuring from useState/useReducer - these are stable
        // Handles both: useState() and React.useState()
        if (t.isCallExpression(init) && isStateHookCall(init)) {
          // Use recursive extraction to handle all identifiers
          for (const name of extractIdentifiersFromPattern(id)) {
            stateVars.add(name);
          }
          return;
        }

        // Track custom hooks that follow the [state, setState] pattern
        // These are treated as state-like even though the hook itself isn't guaranteed stable
        if (
          t.isCallExpression(init) &&
          t.isIdentifier(init.callee) &&
          init.callee.name.startsWith('use') &&
          init.callee.name !== 'useState'
        ) {
          const elements = id.elements;
          if (elements.length >= 2 && t.isIdentifier(elements[0]) && t.isIdentifier(elements[1])) {
            const secondElement = elements[1].name;
            // If second element looks like a setter (starts with 'set' + uppercase),
            // treat this as a state pattern - the first element is managed state
            if (
              secondElement.startsWith('set') &&
              secondElement.length > 3 &&
              secondElement[3] === secondElement[3].toUpperCase()
            ) {
              for (const name of extractIdentifiersFromPattern(id)) {
                stateVars.add(name);
              }
              return;
            }
          }
        }

        // Skip stable function calls (React hooks, parseInt, etc.)
        const context: StabilityCheckContext | undefined = filePath
          ? { filePath, line }
          : undefined;
        if (t.isCallExpression(init) && isStableFunctionCall(init, context, typeChecker, config)) {
          return;
        }

        // Inside component: destructuring from unstable source
        const currentComp = getCurrentComponent();
        if (currentComp) {
          addUnstableDestructuredVariables(
            id,
            init,
            line,
            unstableVars,
            filePath,
            typeChecker,
            config,
            currentComp
          );
        }
        return;
      }

      // Handle object destructuring: const { a, b } = ... or const { data: { user } } = ...
      if (t.isObjectPattern(id)) {
        // Track useContext patterns with state/setter pairs: const { data, setData } = useContext(...)
        if (
          t.isCallExpression(init) &&
          t.isIdentifier(init.callee) &&
          init.callee.name === 'useContext'
        ) {
          // Use extractIdentifiersFromPattern to handle all destructuring cases including nested
          const extractedNames = extractIdentifiersFromPattern(id);

          // Mark state variables (those with matching setters) as stable
          for (const name of extractedNames) {
            if (name.startsWith('set') && name.length > 3 && name[3] === name[3].toUpperCase()) {
              const stateVar = name.charAt(3).toLowerCase() + name.slice(4);
              if (extractedNames.includes(stateVar)) {
                stateVars.add(stateVar);
                stateVars.add(name); // setter is also stable
              }
            }
          }
          return;
        }

        // Track object destructuring from any custom hook (use* prefix)
        // Custom hooks typically return stable values from state management (Zustand, Redux, etc.)
        // or memoized values. Treating them as unstable causes many false positives.
        if (
          t.isCallExpression(init) &&
          t.isIdentifier(init.callee) &&
          init.callee.name.startsWith('use')
        ) {
          // Mark all destructured values from custom hooks as stable
          for (const name of extractIdentifiersFromPattern(id)) {
            stateVars.add(name);
          }
          return;
        }

        // Skip stable function calls (React hooks, parseInt, etc.)
        const objContext: StabilityCheckContext | undefined = filePath
          ? { filePath, line }
          : undefined;
        if (
          t.isCallExpression(init) &&
          isStableFunctionCall(init, objContext, typeChecker, config)
        ) {
          return;
        }

        // Inside component: destructuring from unstable source
        const objCurrentComp = getCurrentComponent();
        if (objCurrentComp) {
          addUnstableDestructuredVariables(
            id,
            init,
            line,
            unstableVars,
            filePath,
            typeChecker,
            config,
            objCurrentComp
          );
        }
        return;
      }

      // Simple identifier assignment: const x = ...
      if (!t.isIdentifier(id)) return;
      const varName = id.name;

      // Check if this is a useState/useReducer call - track state variables
      // Handles both: useState() and React.useState()
      if (t.isCallExpression(init) && isStateHookCall(init)) {
        stateVars.add(varName);
        return;
      }

      // Check if this is a useRef call - refs are stable
      // Handles both: useRef() and React.useRef()
      if (t.isCallExpression(init) && isRefHookCall(init)) {
        refVars.add(varName);
        return;
      }

      // Check if this is a useMemo/useCallback call - memoized values are stable
      // Handles both `useCallback(...)` and `React.useCallback(...)`
      if (t.isCallExpression(init)) {
        const callee = init.callee;
        const isMemoHook =
          // Direct call: useCallback(...) or useMemo(...)
          (t.isIdentifier(callee) &&
            (callee.name === 'useMemo' || callee.name === 'useCallback')) ||
          // Namespaced call: React.useCallback(...) or React.useMemo(...)
          (t.isMemberExpression(callee) &&
            t.isIdentifier(callee.property) &&
            (callee.property.name === 'useMemo' || callee.property.name === 'useCallback'));

        if (isMemoHook) {
          markMemoizedInCurrentScope(varName);
          return;
        }
      }

      // Track module-level variables (before any component function)
      const simpleCurrentComp = getCurrentComponent();
      if (!simpleCurrentComp) {
        moduleLevelVars.add(varName);
        return;
      }

      // Now check for unstable patterns inside components
      // Object literal: const obj = { ... }
      if (t.isObjectExpression(init)) {
        unstableVars.set(`${simpleCurrentComp.name}:${varName}`, {
          name: varName,
          type: 'object',
          line,
          isMemoized: false,
          isModuleLevel: false,
          componentName: simpleCurrentComp.name,
          componentStartLine: simpleCurrentComp.startLine,
          componentEndLine: simpleCurrentComp.endLine,
        });
      }
      // Array literal: const arr = [...]
      else if (t.isArrayExpression(init)) {
        unstableVars.set(`${simpleCurrentComp.name}:${varName}`, {
          name: varName,
          type: 'array',
          line,
          isMemoized: false,
          isModuleLevel: false,
          componentName: simpleCurrentComp.name,
          componentStartLine: simpleCurrentComp.startLine,
          componentEndLine: simpleCurrentComp.endLine,
        });
      }
      // Arrow function: const fn = () => ...
      else if (t.isArrowFunctionExpression(init)) {
        unstableVars.set(`${simpleCurrentComp.name}:${varName}`, {
          name: varName,
          type: 'function',
          line,
          isMemoized: false,
          isModuleLevel: false,
          componentName: simpleCurrentComp.name,
          componentStartLine: simpleCurrentComp.startLine,
          componentEndLine: simpleCurrentComp.endLine,
        });
      }
      // Function expression: const fn = function() ...
      else if (t.isFunctionExpression(init)) {
        unstableVars.set(`${simpleCurrentComp.name}:${varName}`, {
          name: varName,
          type: 'function',
          line,
          isMemoized: false,
          isModuleLevel: false,
          componentName: simpleCurrentComp.name,
          componentStartLine: simpleCurrentComp.startLine,
          componentEndLine: simpleCurrentComp.endLine,
        });
      }
      // Function call that likely returns new object/array: const config = createConfig()
      else if (t.isCallExpression(init)) {
        // Skip stable function calls (React hooks, parseInt, etc.)
        const callContext: StabilityCheckContext | undefined = filePath
          ? { filePath, line }
          : undefined;
        if (isStableFunctionCall(init, callContext, typeChecker, config)) {
          return;
        }
        // Other function calls may return new objects
        unstableVars.set(`${simpleCurrentComp.name}:${varName}`, {
          name: varName,
          type: 'function-call',
          line,
          isMemoized: false,
          isModuleLevel: false,
          componentName: simpleCurrentComp.name,
          componentStartLine: simpleCurrentComp.startLine,
          componentEndLine: simpleCurrentComp.endLine,
        });
      }
    },

    // Track arrow function components
    ArrowFunctionExpression: {
      enter(nodePath: NodePath<t.ArrowFunctionExpression>) {
        // Check if parent is a variable declarator with PascalCase name
        const parent = nodePath.parent;
        if (
          t.isVariableDeclarator(parent) &&
          t.isIdentifier(parent.id) &&
          /^[A-Z]/.test(parent.id.name)
        ) {
          componentStack.push({
            name: parent.id.name,
            startLine: nodePath.node.loc?.start.line || 0,
            endLine: nodePath.node.loc?.end.line || 0,
          });
        }
      },
      exit(nodePath: NodePath<t.ArrowFunctionExpression>) {
        const parent = nodePath.parent;
        if (
          t.isVariableDeclarator(parent) &&
          t.isIdentifier(parent.id) &&
          /^[A-Z]/.test(parent.id.name)
        ) {
          componentStack.pop();
        }
      },
    },

    // Track function expression components: const MyComponent = function() { ... }
    FunctionExpression: {
      enter(nodePath: NodePath<t.FunctionExpression>) {
        // Check if parent is a variable declarator with PascalCase name
        const parent = nodePath.parent;
        if (
          t.isVariableDeclarator(parent) &&
          t.isIdentifier(parent.id) &&
          /^[A-Z]/.test(parent.id.name)
        ) {
          componentStack.push({
            name: parent.id.name,
            startLine: nodePath.node.loc?.start.line || 0,
            endLine: nodePath.node.loc?.end.line || 0,
          });
        }
      },
      exit(nodePath: NodePath<t.FunctionExpression>) {
        const parent = nodePath.parent;
        if (
          t.isVariableDeclarator(parent) &&
          t.isIdentifier(parent.id) &&
          /^[A-Z]/.test(parent.id.name)
        ) {
          componentStack.pop();
        }
      },
    },
  });

  // Remove any variables that are actually memoized, state, refs, or module-level
  // Since keys now include component name, we need to check each unstable var
  const keysToDelete: string[] = [];

  for (const [key, unstableVar] of unstableVars) {
    const varName = unstableVar.name;
    const componentName = unstableVar.componentName;

    // Check if memoized in this component's scope
    if (componentName && memoizedVars.get(componentName)?.has(varName)) {
      keysToDelete.push(key);
      continue;
    }

    // Check if it's a state var
    if (stateVars.has(varName)) {
      keysToDelete.push(key);
      continue;
    }

    // Check if it's a ref var
    if (refVars.has(varName)) {
      keysToDelete.push(key);
      continue;
    }

    // Check if it's a module-level var (shouldn't happen as we don't add those, but just in case)
    if (moduleLevelVars.has(varName)) {
      keysToDelete.push(key);
      continue;
    }
  }

  for (const key of keysToDelete) {
    unstableVars.delete(key);
  }

  return unstableVars;
}
