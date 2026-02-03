/**
 * Rule: no-unstable-key
 *
 * Detects unstable key props in JSX elements that cause React to remount
 * components on every render. This is a high-impact performance issue.
 *
 * Error Codes: RLD-408, RLD-409
 *
 * @example
 * // Bad - random-generating function calls
 * <Item key={Math.random()} />
 * <Item key={Date.now()} />
 * <Item key={crypto.randomUUID()} />
 * <Item key={uuid()} />
 * <Item key={nanoid()} />
 *
 * // Bad - inline object/array literals
 * <Item key={{ id: 1 }} />
 * <Item key={[item]} />
 *
 * // Bad - array index as key (can cause issues with reordering)
 * items.map((item, index) => <Item key={index} />)
 *
 * // Good - stable identifiers
 * <Item key={item.id} />
 * <Item key="static-string" />
 * <Item key={`item-${item.id}`} />
 */

import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import { isNodeRldIgnored } from '../utils';

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/samsmithyeah/react-loop-detector/blob/main/eslint-plugin/docs/rules/${name}.md`
);

type MessageIds = 'unstableKeyCall' | 'unstableKeyObject' | 'unstableKeyArray' | 'indexAsKey';

export interface Options {
  /** Whether to warn on index as key (default: false) */
  warnOnIndex?: boolean;
}

/**
 * Function calls known to generate random/unique values
 */
const RANDOM_GENERATING_CALLS = new Set([
  'random',
  'now',
  'randomUUID',
  'uuid',
  'v4',
  'nanoid',
  'uniqueId',
  'generateId',
  'createId',
]);

/**
 * Objects with random-generating methods
 */
const RANDOM_GENERATING_OBJECTS: Record<string, Set<string>> = {
  Math: new Set(['random']),
  Date: new Set(['now']),
  crypto: new Set(['randomUUID', 'getRandomValues']),
};

// Note: We intentionally don't have a heuristic for common index names like 'i'.
// We only flag index-as-key when we've CONFIRMED the variable is the second
// parameter of a map callback. Variables named 'i' could be element values.

export default createRule<[Options], MessageIds>({
  name: 'no-unstable-key',
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow unstable values as key props in JSX elements',
    },
    messages: {
      unstableKeyCall:
        "Calling '{{call}}' as key generates a new value on every render, causing React to remount the component. Use a stable identifier (e.g., item.id).",
      unstableKeyObject:
        'Inline object literal as key creates a new reference on every render, causing React to remount the component. Use a stable identifier (e.g., item.id).',
      unstableKeyArray:
        'Inline array literal as key creates a new reference on every render, causing React to remount the component. Use a stable identifier (e.g., item.id).',
      indexAsKey:
        "Using array index '{{name}}' as key can cause issues when items are reordered, inserted, or deleted. Use a unique, stable identifier (e.g., item.id).",
    },
    schema: [
      {
        type: 'object',
        properties: {
          warnOnIndex: {
            type: 'boolean',
          },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ warnOnIndex: false }],
  create(context, [options]) {
    const warnOnIndex = options.warnOnIndex === true;

    // Track map callback contexts to detect index parameters
    interface MapContext {
      indexParam: string | null;
      node: TSESTree.CallExpression;
    }
    const mapContextStack: MapContext[] = [];

    /**
     * Check if a call expression generates random values
     */
    function isRandomGeneratingCall(node: TSESTree.CallExpression): {
      isRandom: boolean;
      callDescription: string;
    } {
      const callee = node.callee;

      // Direct call: uuid(), nanoid()
      if (callee.type === 'Identifier') {
        if (RANDOM_GENERATING_CALLS.has(callee.name)) {
          return { isRandom: true, callDescription: `${callee.name}()` };
        }
      }

      // Member expression: Math.random(), Date.now()
      if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
        const methodName = callee.property.name;

        if (callee.object.type === 'Identifier') {
          const objectName = callee.object.name;
          const objectMethods = RANDOM_GENERATING_OBJECTS[objectName];
          if (objectMethods?.has(methodName)) {
            return {
              isRandom: true,
              callDescription: `${objectName}.${methodName}()`,
            };
          }
        }

        // Standalone random-generating method names
        if (RANDOM_GENERATING_CALLS.has(methodName)) {
          return { isRandom: true, callDescription: `${methodName}()` };
        }
      }

      return { isRandom: false, callDescription: '' };
    }

    /**
     * Check if an identifier is a map callback index parameter.
     * Searches from innermost to outermost context for nested .map() calls.
     */
    function isMapIndexParam(identifierNode: TSESTree.Identifier): boolean {
      const name = identifierNode.name;
      // Search from end to find innermost context first (for nested .map() calls with shadowed variables)
      const containingMapContext = [...mapContextStack]
        .reverse()
        .find(
          (ctx) =>
            ctx.indexParam === name &&
            identifierNode.range[0] >= ctx.node.range[0] &&
            identifierNode.range[1] <= ctx.node.range[1]
        );
      return !!containingMapContext;
    }

    /**
     * Analyze a key attribute value
     */
    function analyzeKeyValue(node: TSESTree.JSXAttribute): void {
      const value = node.value;

      // No value or string literal - safe
      if (!value || value.type === 'Literal') {
        return;
      }

      // Must be expression container
      if (value.type !== 'JSXExpressionContainer') {
        return;
      }

      const expression = value.expression;

      // Empty expression - ignore
      if (expression.type === 'JSXEmptyExpression') {
        return;
      }

      // Check for rld-ignore
      if (isNodeRldIgnored(context.sourceCode, expression)) {
        return;
      }

      // Literal in expression - safe
      if (expression.type === 'Literal') {
        return;
      }

      // Member expression (item.id) - safe
      if (expression.type === 'MemberExpression') {
        return;
      }

      // Template literal - generally safe (unless it contains random calls)
      if (expression.type === 'TemplateLiteral') {
        // Check expressions within the template
        for (const expr of expression.expressions) {
          analyzeExpression(expr);
        }
        return;
      }

      analyzeExpression(expression);
    }

    /**
     * Analyze an expression used as key
     */
    function analyzeExpression(expression: TSESTree.Expression): void {
      // Object literal: key={{ id: 1 }}
      if (expression.type === 'ObjectExpression') {
        context.report({
          node: expression,
          messageId: 'unstableKeyObject',
        });
        return;
      }

      // Array literal: key={[item]}
      if (expression.type === 'ArrayExpression') {
        context.report({
          node: expression,
          messageId: 'unstableKeyArray',
        });
        return;
      }

      // Binary expression: key={'foo' + Math.random()}
      if (expression.type === 'BinaryExpression') {
        // Left side of BinaryExpression is always Expression (not PrivateIdentifier)
        analyzeExpression(expression.left as TSESTree.Expression);
        analyzeExpression(expression.right);
        return;
      }

      // Call expression: key={Math.random()}
      if (expression.type === 'CallExpression') {
        const { isRandom, callDescription } = isRandomGeneratingCall(expression);
        if (isRandom) {
          context.report({
            node: expression,
            messageId: 'unstableKeyCall',
            data: { call: callDescription },
          });
        }
        return;
      }

      // Identifier: could be index parameter
      if (expression.type === 'Identifier' && warnOnIndex) {
        // Only flag if it's a CONFIRMED map index parameter (second param of .map callback)
        // We don't blindly flag common index names like 'i' because they could be:
        // - The element value (first param of map): items.map((i) => <Item key={i} />)
        // - A loop counter or other variable
        if (isMapIndexParam(expression)) {
          context.report({
            node: expression,
            messageId: 'indexAsKey',
            data: { name: expression.name },
          });
        }
      }
    }

    return {
      // Track map callbacks to detect index parameters
      CallExpression(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'map' &&
          node.arguments.length > 0
        ) {
          const callback = node.arguments[0];
          let indexParam: string | null = null;

          if (
            (callback.type === 'ArrowFunctionExpression' ||
              callback.type === 'FunctionExpression') &&
            callback.params.length >= 2
          ) {
            const secondParam = callback.params[1];
            if (secondParam.type === 'Identifier') {
              indexParam = secondParam.name;
            }
          }

          mapContextStack.push({ indexParam, node });
        }
      },

      'CallExpression:exit'(node: TSESTree.CallExpression) {
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'map'
        ) {
          mapContextStack.pop();
        }
      },

      // Check key attributes
      JSXAttribute(node) {
        if (node.name.type === 'JSXIdentifier' && node.name.name === 'key') {
          analyzeKeyValue(node);
        }
      },
    };
  },
});
