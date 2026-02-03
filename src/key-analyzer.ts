/**
 * Key Prop Analyzer Module
 *
 * Detects unstable key props in JSX elements that cause React to remount
 * components on every render. This is a high-impact performance issue because
 * unstable keys defeat React's reconciliation algorithm, causing full
 * unmount/remount cycles instead of efficient updates.
 *
 * Patterns detected:
 * - RLD-408 (high severity): Unstable key values
 *   - key={Math.random()}
 *   - key={Date.now()}
 *   - key={crypto.randomUUID()}
 *   - key={{ id: 1 }} (inline object)
 *   - key={[item]} (inline array)
 *   - key={uuid()} (UUID generator calls)
 *   - key={nanoid()} (nanoid generator calls)
 *
 * - RLD-409 (low severity): Index as key
 *   - items.map((item, index) => <Item key={index} />)
 *
 * Safe patterns (no warning):
 * - key={item.id} (property access)
 * - key="static-string" (string literal)
 * - key={123} (numeric literal)
 * - key={`prefix-${id}`} (template literal with stable value)
 */

import * as t from '@babel/types';
import traverse, { NodePath } from '@babel/traverse';
import { HookAnalysis } from './types';
import { UnstableVariable } from './state-extractor';
import { createAnalysis, isHookIgnored } from './utils';

/**
 * Function calls known to generate random/unique values - these are always
 * unstable when used as key props.
 */
const RANDOM_GENERATING_CALLS = new Set([
  'random', // Math.random()
  'now', // Date.now()
  'randomUUID', // crypto.randomUUID()
  'uuid', // uuid library
  'v4', // uuid v4
  'nanoid', // nanoid library
  'uniqueId', // lodash uniqueId
  'generateId',
  'createId',
]);

/**
 * Objects that contain random-generating methods
 */
const RANDOM_GENERATING_OBJECTS: Record<string, Set<string>> = {
  Math: new Set(['random']),
  Date: new Set(['now']),
  crypto: new Set(['randomUUID', 'getRandomValues']),
};

/**
 * Information about a map callback context (for detecting index-as-key)
 */
interface MapCallbackContext {
  indexParamName: string | null;
  startLine: number;
  endLine: number;
}

/** Options for key prop analysis */
export interface KeyAnalyzerOptions {
  /** Whether to warn on index as key (default: false - too noisy for static arrays) */
  warnOnIndex?: boolean;
}

/**
 * Analyze JSX key props for unstable patterns.
 *
 * @param ast - The AST to analyze
 * @param unstableVars - Map of unstable variables in the file
 * @param filePath - Path of the current file
 * @param fileContent - Raw file content (for ignore comment detection)
 * @param options - Analysis options
 */
export function analyzeKeyProps(
  ast: t.Node,
  unstableVars: Map<string, UnstableVariable>,
  filePath: string,
  fileContent: string,
  options: KeyAnalyzerOptions = {}
): HookAnalysis[] {
  const { warnOnIndex = false } = options;
  const results: HookAnalysis[] = [];

  // Track map callback contexts to detect index-as-key patterns
  const mapCallbackContexts: MapCallbackContext[] = [];

  traverse(ast, {
    // Track map callback entry to get index parameter names
    CallExpression: {
      enter(nodePath: NodePath<t.CallExpression>) {
        // Check for .map() calls
        if (
          t.isMemberExpression(nodePath.node.callee) &&
          t.isIdentifier(nodePath.node.callee.property) &&
          nodePath.node.callee.property.name === 'map' &&
          nodePath.node.arguments.length > 0
        ) {
          const callback = nodePath.node.arguments[0];

          // Get the index parameter name (second param of map callback)
          let indexParamName: string | null = null;

          if (t.isArrowFunctionExpression(callback) || t.isFunctionExpression(callback)) {
            if (callback.params.length >= 2) {
              const indexParam = callback.params[1];
              if (t.isIdentifier(indexParam)) {
                indexParamName = indexParam.name;
              }
            }
          }

          mapCallbackContexts.push({
            indexParamName,
            startLine: nodePath.node.loc?.start.line || 0,
            endLine: nodePath.node.loc?.end.line || 0,
          });
        }
      },
      exit(nodePath: NodePath<t.CallExpression>) {
        // Remove map callback context when exiting
        if (
          t.isMemberExpression(nodePath.node.callee) &&
          t.isIdentifier(nodePath.node.callee.property) &&
          nodePath.node.callee.property.name === 'map'
        ) {
          mapCallbackContexts.pop();
        }
      },
    },

    // Analyze JSX key attributes
    JSXAttribute(nodePath: NodePath<t.JSXAttribute>) {
      // Only check "key" attributes
      if (!t.isJSXIdentifier(nodePath.node.name) || nodePath.node.name.name !== 'key') {
        return;
      }

      const line = nodePath.node.loc?.start.line || 0;

      // Check for rld-ignore comments
      if (isHookIgnored(fileContent, line)) {
        return;
      }

      const value = nodePath.node.value;

      // String literal keys are always safe: key="static"
      if (t.isStringLiteral(value)) {
        return;
      }

      // Must be a JSX expression container
      if (!t.isJSXExpressionContainer(value)) {
        return;
      }

      const expression = value.expression;

      // Skip JSXEmptyExpression
      if (t.isJSXEmptyExpression(expression)) {
        return;
      }

      // Check for various unstable patterns
      const issue = analyzeKeyExpression(
        expression,
        line,
        filePath,
        mapCallbackContexts,
        unstableVars,
        warnOnIndex
      );

      if (issue) {
        results.push(issue);
      }
    },
  });

  return results;
}

/**
 * Analyze a key expression for unstable patterns.
 */
function analyzeKeyExpression(
  expression: t.Expression,
  line: number,
  filePath: string,
  mapCallbackContexts: MapCallbackContext[],
  unstableVars: Map<string, UnstableVariable>,
  warnOnIndex: boolean
): HookAnalysis | null {
  // Numeric literal keys are safe: key={1}
  if (t.isNumericLiteral(expression)) {
    return null;
  }

  // String literal in expression is safe: key={"static"}
  if (t.isStringLiteral(expression)) {
    return null;
  }

  // Template literals with only stable parts are safe: key={`item-${id}`}
  // (Template literals that contain random calls would be caught by nested analysis)
  if (t.isTemplateLiteral(expression)) {
    // Check if any expressions in the template are unstable
    for (const expr of expression.expressions) {
      const nestedIssue = analyzeKeyExpression(
        expr as t.Expression,
        line,
        filePath,
        mapCallbackContexts,
        unstableVars,
        warnOnIndex
      );
      if (nestedIssue) {
        return nestedIssue;
      }
    }
    return null;
  }

  // Binary expressions (string concatenation): key={"item-" + id}
  if (t.isBinaryExpression(expression)) {
    const leftIssue = analyzeKeyExpression(
      expression.left as t.Expression,
      line,
      filePath,
      mapCallbackContexts,
      unstableVars,
      warnOnIndex
    );
    if (leftIssue) return leftIssue;

    const rightIssue = analyzeKeyExpression(
      expression.right as t.Expression,
      line,
      filePath,
      mapCallbackContexts,
      unstableVars,
      warnOnIndex
    );
    if (rightIssue) return rightIssue;

    return null;
  }

  // Inline object literal: key={{ id: 1 }}
  if (t.isObjectExpression(expression)) {
    return createAnalysis({
      type: 'potential-issue',
      errorCode: 'RLD-408',
      category: 'performance',
      severity: 'high',
      confidence: 'high',
      hookType: 'key-prop',
      line,
      file: filePath,
      problematicDependency: 'inline object',
      stateVariable: undefined,
      setterFunction: undefined,
      actualStateModifications: [],
      stateReads: [],
      explanation:
        'Inline object literal as key creates a new object reference on every render, ' +
        "causing React to remount the component instead of updating it. This defeats React's reconciliation algorithm.",
      suggestion:
        'Use a stable identifier from your data (e.g., item.id) or a string literal as the key.',
    });
  }

  // Inline array literal: key={[item]}
  if (t.isArrayExpression(expression)) {
    return createAnalysis({
      type: 'potential-issue',
      errorCode: 'RLD-408',
      category: 'performance',
      severity: 'high',
      confidence: 'high',
      hookType: 'key-prop',
      line,
      file: filePath,
      problematicDependency: 'inline array',
      stateVariable: undefined,
      setterFunction: undefined,
      actualStateModifications: [],
      stateReads: [],
      explanation:
        'Inline array literal as key creates a new array reference on every render, ' +
        "causing React to remount the component instead of updating it. This defeats React's reconciliation algorithm.",
      suggestion:
        'Use a stable identifier from your data (e.g., item.id) or a string literal as the key.',
    });
  }

  // Call expression: key={Math.random()}, key={Date.now()}, etc.
  if (t.isCallExpression(expression)) {
    const callInfo = getCallExpressionInfo(expression);
    if (callInfo && isRandomGeneratingCall(callInfo.objectName, callInfo.methodName)) {
      const callDescription = callInfo.objectName
        ? `${callInfo.objectName}.${callInfo.methodName}()`
        : `${callInfo.methodName}()`;

      return createAnalysis({
        type: 'potential-issue',
        errorCode: 'RLD-408',
        category: 'performance',
        severity: 'high',
        confidence: 'high',
        hookType: 'key-prop',
        line,
        file: filePath,
        problematicDependency: callDescription,
        stateVariable: undefined,
        setterFunction: undefined,
        actualStateModifications: [],
        stateReads: [],
        explanation:
          `Calling ${callDescription} as key generates a new value on every render, ` +
          "causing React to remount the component instead of updating it. This defeats React's reconciliation algorithm " +
          'and causes all component state to be lost.',
        suggestion: 'Use a stable identifier from your data (e.g., item.id) as the key.',
      });
    }
  }

  // Member expression: key={item.id} - this is safe
  if (t.isMemberExpression(expression)) {
    return null;
  }

  // Identifier: could be index-as-key or unstable variable
  if (t.isIdentifier(expression)) {
    const varName = expression.name;

    // Check if this is an index parameter from a map callback (only if warnOnIndex is enabled)
    if (warnOnIndex) {
      const currentContext = mapCallbackContexts.find(
        (ctx) => ctx.indexParamName === varName && line >= ctx.startLine && line <= ctx.endLine
      );

      if (currentContext) {
        return createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-409',
          category: 'warning',
          severity: 'low',
          confidence: 'high',
          hookType: 'key-prop',
          line,
          file: filePath,
          problematicDependency: varName,
          stateVariable: undefined,
          setterFunction: undefined,
          actualStateModifications: [],
          stateReads: [],
          explanation:
            `Using array index '${varName}' as key can cause issues when items are reordered, ` +
            'inserted, or deleted. React may incorrectly reuse component instances, leading to ' +
            'state bugs and unexpected behavior.',
          suggestion:
            'Use a unique, stable identifier from your data (e.g., item.id) as the key. ' +
            'If your items have no unique ID, consider using a hash of the item content or generating IDs when data is created.',
        });
      }
    }

    // NOTE: We intentionally do NOT flag variables just because they have common
    // index names like 'i' or 'idx'. The variable could be:
    // - The element value (first param of map): items.map((i) => <Item key={i} />)
    // - A loop counter in a for loop
    // - Any other variable that happens to be named 'i'
    // We only flag index-as-key when we've CONFIRMED the variable is actually
    // the second parameter of a map callback (handled above via mapCallbackContexts).

    // Check if variable is known to be unstable (e.g., result of Math.random() call)
    for (const unstableVar of unstableVars.values()) {
      if (
        unstableVar.name === varName &&
        unstableVar.type === 'function-call' &&
        line >= (unstableVar.componentStartLine || 0) &&
        line <= (unstableVar.componentEndLine || Infinity)
      ) {
        return createAnalysis({
          type: 'potential-issue',
          errorCode: 'RLD-408',
          category: 'performance',
          severity: 'high',
          confidence: 'medium',
          hookType: 'key-prop',
          line,
          file: filePath,
          problematicDependency: varName,
          stateVariable: undefined,
          setterFunction: undefined,
          actualStateModifications: [],
          stateReads: [],
          explanation:
            `Variable '${varName}' is assigned from a function call that may return a new value each render. ` +
            "Using it as key may cause React to remount components unnecessarily, defeating React's reconciliation algorithm.",
          suggestion: 'Use a stable identifier from your data (e.g., item.id) as the key.',
        });
      }
    }

    return null;
  }

  return null;
}

/**
 * Extract object and method name from a call expression.
 */
function getCallExpressionInfo(
  node: t.CallExpression
): { objectName: string | null; methodName: string } | null {
  const callee = node.callee;

  // Direct call: uuid(), nanoid()
  if (t.isIdentifier(callee)) {
    return { objectName: null, methodName: callee.name };
  }

  // Member expression call: Math.random(), Date.now()
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
    const methodName = callee.property.name;

    if (t.isIdentifier(callee.object)) {
      return { objectName: callee.object.name, methodName };
    }

    return { objectName: null, methodName };
  }

  return null;
}

/**
 * Check if a function call is known to generate random/unique values.
 */
function isRandomGeneratingCall(objectName: string | null, methodName: string): boolean {
  // Check object-specific methods: Math.random(), Date.now(), etc.
  if (objectName) {
    const objectMethods = RANDOM_GENERATING_OBJECTS[objectName];
    if (objectMethods?.has(methodName)) {
      return true;
    }
  }

  // Check standalone functions: uuid(), nanoid(), etc.
  if (RANDOM_GENERATING_CALLS.has(methodName)) {
    return true;
  }

  return false;
}
