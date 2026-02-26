/**
 * Effect Analyzer Module
 *
 * Analyzes useEffect and useLayoutEffect hooks for infinite loop patterns.
 * This module handles:
 * - useEffect without dependency array detection
 * - State interaction analysis within effect callbacks
 * - Deferred modification detection (setInterval, onSnapshot, etc.)
 * - Function reference tracking (event listeners, callbacks)
 */

import * as t from '@babel/types';
import traverse, { NodePath } from '@babel/traverse';
import { HookAnalysis, StateInteraction } from './types';
import { isHookIgnored, createAnalysis } from './utils';
import { analyzeConditionalGuard } from './guard-analyzer';

/**
 * Build a map of local functions to the state setters they call (directly or transitively).
 * This is used to detect indirect state modifications through function calls.
 *
 * For example:
 * ```
 * const outerFn = () => { innerFn(); };
 * const innerFn = () => { setCount(c => c + 1); };
 * useEffect(() => { outerFn(); }, [count]); // Indirect loop via outerFn -> innerFn -> setCount
 * ```
 */
export function buildLocalFunctionSetterMap(
  ast: t.Node,
  stateInfo: Map<string, string>
): Map<string, string[]> {
  const setterNames = new Set(stateInfo.values());
  const functionsCallingSetters = new Map<string, string[]>();
  const functionCallingFunctions = new Map<string, string[]>(); // function -> functions it calls

  // Helper to find setters called within a function body
  function findSettersCalledInFunction(funcNode: t.Node): string[] {
    const settersCalled: string[] = [];
    traverse(funcNode, {
      noScope: true,
      CallExpression(innerCallPath: NodePath<t.CallExpression>) {
        if (t.isIdentifier(innerCallPath.node.callee)) {
          const calleeName = innerCallPath.node.callee.name;
          if (setterNames.has(calleeName)) {
            settersCalled.push(calleeName);
          }
        }
      },
    });
    return settersCalled;
  }

  // Helper to find other local functions called within a function body
  function findFunctionsCalledInFunction(funcNode: t.Node, knownFunctions: Set<string>): string[] {
    const functionsCalled: string[] = [];
    traverse(funcNode, {
      noScope: true,
      CallExpression(innerCallPath: NodePath<t.CallExpression>) {
        if (t.isIdentifier(innerCallPath.node.callee)) {
          const calleeName = innerCallPath.node.callee.name;
          if (knownFunctions.has(calleeName)) {
            functionsCalled.push(calleeName);
          }
        }
      },
    });
    return functionsCalled;
  }

  // First pass: collect all function definitions (but don't traverse them yet)
  // We must not do nested traversals from inside traverse callbacks
  const functionBodies = new Map<string, t.Node>();

  traverse(ast, {
    VariableDeclarator(varPath: NodePath<t.VariableDeclarator>) {
      if (!t.isIdentifier(varPath.node.id)) return;
      const varName = varPath.node.id.name;
      const init = varPath.node.init;

      if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) {
        functionBodies.set(varName, init);
      }
    },
    FunctionDeclaration(funcPath: NodePath<t.FunctionDeclaration>) {
      if (!funcPath.node.id) return;
      const funcName = funcPath.node.id.name;
      functionBodies.set(funcName, funcPath.node);
    },
  });

  // Now analyze each function AFTER the main traversal is complete
  // This avoids nested traversal issues
  for (const [funcName, funcBody] of functionBodies) {
    const settersCalled = findSettersCalledInFunction(funcBody);
    if (settersCalled.length > 0) {
      functionsCallingSetters.set(funcName, settersCalled);
    }
  }

  // Second pass: build call graph between local functions
  const knownFunctions = new Set(functionBodies.keys());
  for (const [funcName, funcBody] of functionBodies) {
    const calledFunctions = findFunctionsCalledInFunction(funcBody, knownFunctions);
    if (calledFunctions.length > 0) {
      functionCallingFunctions.set(funcName, calledFunctions);
    }
  }

  // Third pass: transitively propagate setters through the call graph
  // Use iterative approach to handle chains like outerFn -> innerFn -> dispatch
  let changed = true;
  let iterations = 0;
  const maxIterations = 100; // Safety limit to prevent infinite loops

  while (changed && iterations < maxIterations) {
    iterations++;
    changed = false;
    for (const [funcName, calledFunctions] of functionCallingFunctions) {
      const currentSetters = functionsCallingSetters.get(funcName) || [];
      const currentSettersSet = new Set(currentSetters);
      const originalSize = currentSettersSet.size;

      for (const calledFunc of calledFunctions) {
        const transitiveSetters = functionsCallingSetters.get(calledFunc) || [];
        for (const setter of transitiveSetters) {
          currentSettersSet.add(setter);
        }
      }

      // Only update if we actually added new unique setters
      if (currentSettersSet.size > originalSize) {
        functionsCallingSetters.set(funcName, Array.from(currentSettersSet));
        changed = true;
      }
    }
  }

  return functionsCallingSetters;
}

/**
 * Detect useEffect calls without a dependency array that contain setState.
 * This is a guaranteed infinite loop pattern.
 *
 * Pattern detected:
 * ```
 * useEffect(() => {
 *   setCount(c => c + 1);
 * }); // Missing dependency array!
 * ```
 *
 * Also detects indirect patterns:
 * ```
 * const fetchData = () => { setData(x); };
 * useEffect(() => {
 *   fetchData(); // calls function that eventually calls setState
 * });
 * ```
 */
export function detectUseEffectWithoutDeps(
  ast: t.Node,
  stateInfo: Map<string, string>,
  filePath: string,
  fileContent?: string
): HookAnalysis[] {
  const results: HookAnalysis[] = [];
  const setterNames = new Set(stateInfo.values());

  // Build reverse map: setter -> state variable
  const setterToState = new Map<string, string>();
  stateInfo.forEach((setter, state) => setterToState.set(setter, state));

  // First pass: find local functions that call state setters (directly or indirectly)
  const functionsCallingSetters = new Map<string, string[]>(); // function name -> setters it calls

  // Helper to find setters called within a function body
  function findSettersCalledInFunction(
    funcPath: NodePath<t.ArrowFunctionExpression | t.FunctionExpression | t.ObjectMethod>
  ): string[] {
    const settersCalled: string[] = [];
    funcPath.traverse({
      CallExpression(innerCallPath: NodePath<t.CallExpression>) {
        // Check for direct calls: setData(x)
        if (t.isIdentifier(innerCallPath.node.callee)) {
          const calleeName = innerCallPath.node.callee.name;
          if (setterNames.has(calleeName)) {
            settersCalled.push(calleeName);
          }
        }

        // Check for setters passed as arguments: .then(setData)
        for (const arg of innerCallPath.node.arguments || []) {
          if (t.isIdentifier(arg) && setterNames.has(arg.name)) {
            settersCalled.push(arg.name);
          }
        }
      },
    });
    return settersCalled;
  }

  // Track object methods: const utils = { update: () => setCount(...) }
  // We track these as "objectName.methodName" for matching later
  const objectMethodsCallingSetters = new Map<string, string[]>(); // "obj.method" -> setters

  traverse(ast, {
    // Track arrow function assignments: const fetchData = () => { setData(...) }
    VariableDeclarator(varPath: NodePath<t.VariableDeclarator>) {
      if (!t.isIdentifier(varPath.node.id)) return;
      const varName = varPath.node.id.name;
      const init = varPath.node.init;

      // Handle direct function assignments
      if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) {
        const funcPath = varPath.get('init') as NodePath<
          t.ArrowFunctionExpression | t.FunctionExpression
        >;
        const settersCalled = findSettersCalledInFunction(funcPath);
        if (settersCalled.length > 0) {
          functionsCallingSetters.set(varName, settersCalled);
        }
      }

      // Handle object expressions: const utils = { update: () => setCount(...) }
      if (t.isObjectExpression(init)) {
        const objPath = varPath.get('init') as NodePath<t.ObjectExpression>;
        for (const propPath of objPath.get('properties')) {
          if (!propPath.isObjectProperty() && !propPath.isObjectMethod()) continue;

          const prop = propPath.node;
          let methodName: string | null = null;

          if (t.isIdentifier(prop.key)) {
            methodName = prop.key.name;
          } else if (t.isStringLiteral(prop.key)) {
            methodName = prop.key.value;
          }

          if (!methodName) continue;

          if (propPath.isObjectMethod()) {
            const settersCalled = findSettersCalledInFunction(propPath as NodePath<t.ObjectMethod>);
            if (settersCalled.length > 0) {
              objectMethodsCallingSetters.set(`${varName}.${methodName}`, settersCalled);
            }
          } else if (propPath.isObjectProperty()) {
            const value = (prop as t.ObjectProperty).value;
            if (t.isArrowFunctionExpression(value) || t.isFunctionExpression(value)) {
              const valuePath = (propPath as NodePath<t.ObjectProperty>).get('value') as NodePath<
                t.ArrowFunctionExpression | t.FunctionExpression
              >;
              const settersCalled = findSettersCalledInFunction(valuePath);
              if (settersCalled.length > 0) {
                objectMethodsCallingSetters.set(`${varName}.${methodName}`, settersCalled);
              }
            }
          }
        }
      }
    },

    // Track function declarations: function fetchData() { setData(...) }
    FunctionDeclaration(funcPath: NodePath<t.FunctionDeclaration>) {
      const funcName = funcPath.node.id?.name;
      if (!funcName) return;

      // Skip component functions (PascalCase)
      if (/^[A-Z]/.test(funcName)) return;

      const settersCalled = findSettersCalledInFunction(
        funcPath as unknown as NodePath<t.FunctionExpression>
      );
      if (settersCalled.length > 0) {
        functionsCallingSetters.set(funcName, settersCalled);
      }
    },
  });

  // Second pass: find useEffect without deps
  traverse(ast, {
    CallExpression(callPath: NodePath<t.CallExpression>) {
      if (!t.isIdentifier(callPath.node.callee)) return;
      const hookName = callPath.node.callee.name;

      // Only check useEffect and useLayoutEffect
      if (hookName !== 'useEffect' && hookName !== 'useLayoutEffect') return;

      const args = callPath.node.arguments;

      // Check if there's no dependency array (only 1 argument - the callback)
      if (args.length !== 1) return;

      const callback = args[0];
      if (!t.isArrowFunctionExpression(callback) && !t.isFunctionExpression(callback)) return;

      const line = callPath.node.loc?.start.line || 0;

      // Check for ignore comments
      if (fileContent && isHookIgnored(fileContent, line)) return;

      // Check if the callback contains any setState calls (direct or indirect)
      const setterCallsInCallback: string[] = [];
      const functionCallsInCallback: string[] = [];

      const callbackPath = callPath.get('arguments.0') as NodePath<
        t.ArrowFunctionExpression | t.FunctionExpression
      >;
      callbackPath.traverse({
        CallExpression(innerCallPath: NodePath<t.CallExpression>) {
          const callee = innerCallPath.node.callee;

          // Handle direct function calls: funcName()
          if (t.isIdentifier(callee)) {
            const calleeName = callee.name;

            // Direct setter call
            if (setterNames.has(calleeName)) {
              setterCallsInCallback.push(calleeName);
            }

            // Function call that might lead to setter
            if (functionsCallingSetters.has(calleeName)) {
              functionCallsInCallback.push(calleeName);
              const indirectSetters = functionsCallingSetters.get(calleeName) || [];
              setterCallsInCallback.push(...indirectSetters);
            }
          }

          // Handle member expression calls: obj.method()
          if (
            t.isMemberExpression(callee) &&
            t.isIdentifier(callee.object) &&
            t.isIdentifier(callee.property)
          ) {
            const methodKey = `${callee.object.name}.${callee.property.name}`;
            if (objectMethodsCallingSetters.has(methodKey)) {
              functionCallsInCallback.push(methodKey);
              const indirectSetters = objectMethodsCallingSetters.get(methodKey) || [];
              setterCallsInCallback.push(...indirectSetters);
            }
          }
        },
      });

      if (setterCallsInCallback.length > 0) {
        const firstSetter = setterCallsInCallback[0];
        const stateVar = setterToState.get(firstSetter) || firstSetter;
        const isIndirect = functionCallsInCallback.length > 0;

        results.push(
          createAnalysis({
            type: 'confirmed-infinite-loop',
            errorCode: 'RLD-201',
            category: 'critical',
            severity: 'high',
            confidence: isIndirect ? 'medium' : 'high',
            hookType: hookName,
            line,
            file: filePath,
            problematicDependency: 'missing-deps',
            stateVariable: stateVar,
            setterFunction: firstSetter,
            actualStateModifications: setterCallsInCallback,
            stateReads: [],
            explanation: isIndirect
              ? `${hookName} has no dependency array, so it runs after every render. ` +
                `It calls '${functionCallsInCallback[0]}()' which calls '${firstSetter}()', triggering re-renders.`
              : `${hookName} has no dependency array, so it runs after every render. ` +
                `It calls '${firstSetter}()' which triggers a re-render, causing an infinite loop.`,
            suggestion: `Add a dependency array: useEffect(() => { ... }, []) for run-once, or [dep1, dep2] for specific dependencies.`,
          })
        );
      }
    },
  });

  return results;
}

// Common event listener methods that receive callback references (not invoked immediately)
const EVENT_LISTENER_METHODS = new Set([
  'addEventListener',
  'removeEventListener',
  'on',
  'off',
  'once',
  'addListener',
  'removeListener',
  'subscribe',
  'unsubscribe',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'then',
  'catch',
  'finally', // Promise methods
  'map',
  'filter',
  'forEach',
  'reduce',
  'find',
  'some',
  'every', // Array methods
]);

// Functions that execute their callbacks asynchronously (deferred execution)
// State modifications inside these callbacks won't cause immediate re-render loops
const ASYNC_CALLBACK_FUNCTIONS = new Set([
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'requestIdleCallback',
  'then',
  'catch',
  'finally', // Promise methods
  'onSnapshot',
  'onAuthStateChanged',
  'onValue',
  'onChildAdded',
  'onChildChanged',
  'onChildRemoved', // Firebase
  'subscribe',
  'observe', // Common subscription patterns
  'addEventListener', // Event listeners are async (user-triggered)
]);

/**
 * Analyze state interactions within a hook body.
 * Tracks:
 * - State reads and modifications
 * - Conditional vs unconditional modifications
 * - Functional updates
 * - Deferred modifications (inside async callbacks)
 * - Function references passed to event listeners
 * - Ref mutations
 * - Indirect modifications through local function calls
 *
 * @param hookBody - The hook callback body to analyze
 * @param stateInfo - Map of state variables to their setters
 * @param refVars - Set of ref variable names
 * @param localFunctionSetters - Optional map of local functions to the setters they call (transitively)
 */
export function analyzeStateInteractions(
  hookBody: t.Node,
  stateInfo: Map<string, string>,
  refVars: Set<string> = new Set(),
  localFunctionSetters: Map<string, string[]> = new Map()
): StateInteraction {
  const interactions: StateInteraction = {
    reads: [],
    modifications: [],
    conditionalModifications: [],
    functionalUpdates: [],
    deferredModifications: [],
    guardedModifications: [],
    functionReferences: [],
    refMutations: [],
    cleanupModifications: [],
  };

  const setterNames = Array.from(stateInfo.values());
  const stateNames = Array.from(stateInfo.keys());

  // Build reverse map: setter -> state variable
  const setterToState = new Map<string, string>();
  stateInfo.forEach((setter, state) => setterToState.set(setter, state));

  // Track functions that are passed as arguments (not invoked)
  const functionsPassedAsArgs = new Set<string>();

  // Track CallExpression nodes that are async callback receivers
  const asyncCallbackNodes = new Set<t.Node>();

  // Track cleanup function nodes (functions returned from the effect callback)
  const cleanupFunctionNodes = new Set<t.Node>();

  // Track named function identifiers passed to async callbacks (e.g., addEventListener('click', handleClick))
  // These need to be resolved to their function bodies after the first pass.
  const namedAsyncCallbackRefs = new Set<string>();

  // Track locally defined functions: name → function expression node
  const localFunctions = new Map<string, t.Node>();

  // First pass: find all functions passed as arguments to known safe receivers,
  // track async callback nodes, and identify cleanup functions (returned from effect)
  traverse(hookBody, {
    noScope: true,

    // Detect cleanup functions: return () => { ... } or return function() { ... }
    ReturnStatement(path: NodePath<t.ReturnStatement>) {
      const returnArg = path.node.argument;
      if (t.isArrowFunctionExpression(returnArg) || t.isFunctionExpression(returnArg)) {
        cleanupFunctionNodes.add(returnArg);
      }
    },

    // Collect locally defined function variables:
    // const handleClick = () => { ... } or const handleClick = function() { ... }
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      const node = path.node;
      if (
        t.isIdentifier(node.id) &&
        (t.isArrowFunctionExpression(node.init) || t.isFunctionExpression(node.init))
      ) {
        localFunctions.set(node.id.name, node.init);
      }
    },

    // Collect function declarations: function handleClick() { ... }
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      const node = path.node;
      if (node.id && t.isIdentifier(node.id)) {
        localFunctions.set(node.id.name, node);
      }
    },

    CallExpression(path: NodePath<t.CallExpression>) {
      const node = path.node;
      let receivingFuncName: string | null = null;

      // Handle: addEventListener('click', handler)
      if (t.isIdentifier(node.callee)) {
        receivingFuncName = node.callee.name;
      }
      // Handle: element.addEventListener('click', handler) or window.addEventListener(...)
      else if (t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.property)) {
        receivingFuncName = node.callee.property.name;
      }

      if (receivingFuncName && EVENT_LISTENER_METHODS.has(receivingFuncName)) {
        // Check each argument - if it's an identifier, it's passed as reference
        for (const arg of node.arguments) {
          if (t.isIdentifier(arg)) {
            functionsPassedAsArgs.add(arg.name);
            interactions.functionReferences.push({
              functionName: arg.name,
              context: [
                'addEventListener',
                'removeEventListener',
                'on',
                'off',
                'addListener',
                'removeListener',
              ].includes(receivingFuncName)
                ? 'event-listener'
                : 'callback-arg',
              receivingFunction: receivingFuncName,
            });
          }
        }
      }

      // Track async callback function calls - these contain callbacks that execute asynchronously
      // e.g., setInterval(() => setCount(...), 1000) or onSnapshot(q, (snapshot) => { ... })
      if (receivingFuncName && ASYNC_CALLBACK_FUNCTIONS.has(receivingFuncName)) {
        // Mark all function arguments (arrow functions, function expressions) as async callbacks
        for (const arg of node.arguments) {
          if (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg)) {
            asyncCallbackNodes.add(arg);
          }
          // Track named function references for resolution after this pass
          // e.g., addEventListener('mousedown', handleClickOutside)
          else if (t.isIdentifier(arg)) {
            namedAsyncCallbackRefs.add(arg.name);
          }
        }
      }
    },
  });

  // Resolve named function references passed to async callbacks.
  // e.g., const handleClick = () => { setState(...) }; addEventListener('click', handleClick);
  // → mark handleClick's function body as an async callback node
  for (const name of namedAsyncCallbackRefs) {
    const funcNode = localFunctions.get(name);
    if (funcNode) {
      asyncCallbackNodes.add(funcNode);
    }
  }

  // Helper: check if a path is inside an async callback
  function isInsideAsyncCallback(path: NodePath): boolean {
    return path.findParent((p) => asyncCallbackNodes.has(p.node)) !== null;
  }

  // Helper: check if a path is inside a cleanup function
  function isInsideCleanupFunction(path: NodePath): boolean {
    return path.findParent((p) => cleanupFunctionNodes.has(p.node)) !== null;
  }

  // Helper: get ancestor stack as array of nodes (for analyzeConditionalGuard)
  function getAncestorStack(path: NodePath): t.Node[] {
    const ancestors: t.Node[] = [];
    let current: NodePath | null = path;
    while (current) {
      ancestors.push(current.node);
      current = current.parentPath;
    }
    return ancestors;
  }

  // Helper: check if any identifier in a node references a state variable
  function nodeReferencesState(node: t.Node): boolean {
    let found = false;
    traverse(node, {
      noScope: true,
      Identifier(innerPath: NodePath<t.Identifier>) {
        if (stateNames.includes(innerPath.node.name) && innerPath.isReferencedIdentifier()) {
          found = true;
          innerPath.stop();
        }
      },
    });
    return found;
  }

  // Main traversal pass
  traverse(hookBody, {
    noScope: true,

    // Check for function calls (state setters or local functions that call setters)
    CallExpression(path: NodePath<t.CallExpression>) {
      const node = path.node;
      if (!t.isIdentifier(node.callee)) return;

      const calleeName = node.callee.name;

      // Check if this is a direct call to a state setter
      if (setterNames.includes(calleeName)) {
        const stateVar = setterToState.get(calleeName);

        // Check if this modification is inside an async callback (deferred)
        if (isInsideAsyncCallback(path)) {
          interactions.deferredModifications.push(calleeName);
        }
        // Check if this modification is inside a cleanup function
        else if (isInsideCleanupFunction(path)) {
          interactions.cleanupModifications.push(calleeName);
        } else {
          // Not deferred and not in cleanup, so analyze for loop risks
          const guardAnalysis = analyzeConditionalGuard(
            node,
            getAncestorStack(path),
            calleeName,
            stateVar,
            stateNames
          );

          if (guardAnalysis) {
            interactions.guardedModifications.push(guardAnalysis);
            if (!guardAnalysis.isSafe) {
              interactions.conditionalModifications.push(calleeName);
            }
          } else {
            // If we couldn't analyze the guard, treat as a regular modification
            // The CFG-based analysis will determine if it's truly unconditional
            interactions.modifications.push(calleeName);
          }
        }

        // Check if it's a functional update (applies to both deferred and non-deferred calls)
        if (
          node.arguments.length > 0 &&
          (t.isArrowFunctionExpression(node.arguments[0]) ||
            t.isFunctionExpression(node.arguments[0]))
        ) {
          interactions.functionalUpdates.push(calleeName);
        }
        return; // Already handled as direct setter call
      }

      // Check if this is a call to a local function that transitively calls setters
      const transitiveSetters = localFunctionSetters.get(calleeName);
      if (transitiveSetters && transitiveSetters.length > 0) {
        // Check context (async, cleanup, etc.)
        if (isInsideAsyncCallback(path)) {
          // Indirect calls inside async callbacks are deferred
          for (const setter of transitiveSetters) {
            interactions.deferredModifications.push(setter);
          }
        } else if (isInsideCleanupFunction(path)) {
          // Indirect calls inside cleanup functions
          for (const setter of transitiveSetters) {
            interactions.cleanupModifications.push(setter);
          }
        } else {
          // Indirect calls in main effect body — check if the function call itself
          // is guarded by a condition on the state variable.
          // e.g., if (!token) { setNewToken(); } where setNewToken calls setToken
          // The guard on the function call effectively guards the transitive setState.
          for (const setter of transitiveSetters) {
            const stateVar = setterToState.get(setter);
            const guardAnalysis = analyzeConditionalGuard(
              node,
              getAncestorStack(path),
              setter,
              stateVar,
              stateNames
            );

            if (guardAnalysis) {
              interactions.guardedModifications.push(guardAnalysis);
              if (!guardAnalysis.isSafe) {
                interactions.conditionalModifications.push(setter);
              }
            } else {
              interactions.modifications.push(setter);
            }
          }
        }
      }
    },

    // Check for member expressions (state reads)
    MemberExpression(path: NodePath<t.MemberExpression>) {
      const node = path.node;
      if (t.isIdentifier(node.object) && stateNames.includes(node.object.name)) {
        interactions.reads.push(node.object.name);
      }
    },

    // Check for identifier references (state reads)
    Identifier(path: NodePath<t.Identifier>) {
      const node = path.node;
      if (!stateNames.includes(node.name)) return;

      // Only count as read if it's a reference (not a property key, etc.)
      if (!path.isReferencedIdentifier()) return;

      // Skip if this is the left side of an assignment
      const parent = path.parent;
      if (t.isAssignmentExpression(parent) && parent.left === node) return;

      interactions.reads.push(node.name);
    },

    // Check for ref.current mutations (e.g., ref.current = value)
    AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
      const node = path.node;
      if (
        !t.isMemberExpression(node.left) ||
        !t.isIdentifier(node.left.object) ||
        !t.isIdentifier(node.left.property) ||
        node.left.property.name !== 'current' ||
        !refVars.has(node.left.object.name)
      ) {
        return;
      }

      const refName = node.left.object.name;
      const rightSide = node.right;

      // Check if the assigned value is a state variable
      let assignedValue: string | undefined;
      let usesStateValue = false;

      if (t.isIdentifier(rightSide)) {
        assignedValue = rightSide.name;
        usesStateValue = stateNames.includes(rightSide.name);
      } else {
        usesStateValue = nodeReferencesState(rightSide);
      }

      interactions.refMutations.push({
        refName,
        assignedValue,
        usesStateValue,
        line: node.loc?.start.line || 0,
      });
    },
  });

  // Remove duplicates
  interactions.reads = [...new Set(interactions.reads)];
  interactions.modifications = [...new Set(interactions.modifications)];
  interactions.conditionalModifications = [...new Set(interactions.conditionalModifications)];
  interactions.functionalUpdates = [...new Set(interactions.functionalUpdates)];
  interactions.deferredModifications = [...new Set(interactions.deferredModifications)];

  return interactions;
}
