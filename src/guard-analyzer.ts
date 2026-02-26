/**
 * Guard Analyzer Module
 *
 * Analyzes conditional guards around setState calls to determine if they prevent infinite loops.
 * This module handles:
 * - Toggle guards: if (!value) setValue(true)
 * - Equality guards: if (value !== newValue) setValue(newValue)
 * - Early return patterns: if (condition) return; setValue(...)
 * - Object spread risk detection
 */

import * as t from '@babel/types';
import { GuardedModification } from './types';
import { containsNode, usesObjectSpread, conditionInvolvesState } from './utils';

/**
 * Analyze whether a conditional guard around a state setter prevents infinite loops.
 *
 * Common safe patterns:
 * 1. Toggle guard: `if (!value) setValue(true)` - only sets when false
 * 2. Equality guard: `if (value !== newValue) setValue(newValue)` - only sets when different
 * 3. Early return: `if (value === something) return; setValue(...)` - exits before setting
 */
export function analyzeConditionalGuard(
  setterCall: t.CallExpression,
  ancestorStack: t.Node[],
  setterName: string,
  stateVar: string | undefined,
  _allStateVars: string[] // Reserved for future use
): GuardedModification | null {
  if (!stateVar) return null;

  // Find the nearest conditional ancestor
  for (let i = ancestorStack.length - 1; i >= 0; i--) {
    const ancestor = ancestorStack[i];

    // Check for IfStatement
    if (ancestor.type === 'IfStatement') {
      const condition = ancestor.test;
      const guardType = analyzeCondition(condition, stateVar, setterCall, ancestor, setterName);

      if (guardType) {
        return {
          setter: setterName,
          stateVariable: stateVar,
          guardType: guardType.type,
          isSafe: guardType.isSafe,
          warning: guardType.warning,
        };
      }
    }

    // Check for early return pattern in BlockStatement
    if (ancestor.type === 'BlockStatement') {
      const earlyReturnGuard = checkEarlyReturnPattern(ancestor, setterCall, stateVar);
      if (earlyReturnGuard) {
        return {
          setter: setterName,
          stateVariable: stateVar,
          guardType: 'early-return',
          isSafe: true,
        };
      }
    }
  }

  return null;
}

/**
 * Analyze if a condition creates a safe guard for state modification.
 */
export function analyzeCondition(
  condition: t.Node | null | undefined,
  stateVar: string,
  setterCall: t.CallExpression,
  _ifStatement: t.IfStatement,
  setterName?: string
): { type: GuardedModification['guardType']; isSafe: boolean; warning?: string } | null {
  if (!condition) return null;

  // Pattern 1: Toggle guard - `if (!stateVar)` or `if (stateVar === false)`
  // Setting to true when false (or vice versa) - only runs once
  if (condition.type === 'UnaryExpression' && condition.operator === '!') {
    if (condition.argument?.type === 'Identifier' && condition.argument.name === stateVar) {
      // Check if we're setting to a truthy value (common: true, or any non-falsy)
      const setterArg = setterCall.arguments?.[0];
      if (setterArg) {
        // `if (!value) setValue(true)` - toggle guard, safe
        if (setterArg.type === 'BooleanLiteral' && setterArg.value === true) {
          return { type: 'toggle-guard', isSafe: true };
        }
        // `if (!value) setValue(something)` where something is truthy - likely safe
        if (setterArg.type !== 'Identifier' || setterArg.name !== stateVar) {
          return { type: 'toggle-guard', isSafe: true };
        }
      } else if (setterCall.callee?.type === 'Identifier') {
        // No setter arguments — this is an indirect function call pattern:
        // if (!token) { fetchAndSetToken(); }
        // The called function will internally call the actual setter with a value.
        // The !stateVar guard ensures it only runs when the state is falsy,
        // and the function is expected to set it to something truthy, breaking the loop.
        // We check that the callee is NOT the setter itself (e.g., setState() with no args
        // would set to undefined, which is falsy and would loop).
        const calleeName = setterCall.callee.name;
        if (calleeName !== setterName) {
          return { type: 'toggle-guard', isSafe: true };
        }
      }
    }
  }

  // Pattern 1b: `if (stateVar)` with setting to falsy
  if (condition.type === 'Identifier' && condition.name === stateVar) {
    const setterArg = setterCall.arguments?.[0];
    if (setterArg?.type === 'BooleanLiteral' && setterArg.value === false) {
      return { type: 'toggle-guard', isSafe: true };
    }
    if (
      setterArg?.type === 'NullLiteral' ||
      (setterArg?.type === 'Identifier' && setterArg.name === 'undefined')
    ) {
      return { type: 'toggle-guard', isSafe: true };
    }
  }

  // Pattern 2: Equality guard - `if (stateVar !== newValue)` or `if (newValue !== stateVar)`
  if (condition.type === 'BinaryExpression') {
    const { left, right, operator } = condition;

    // Check for !== or !=
    if (operator === '!==' || operator === '!=') {
      const hasStateOnLeft = left?.type === 'Identifier' && left.name === stateVar;
      const hasStateOnRight = right?.type === 'Identifier' && right.name === stateVar;

      if (hasStateOnLeft || hasStateOnRight) {
        return { type: 'equality-guard', isSafe: true };
      }

      // Check for PROPERTY equality guard with object spread risk
      // Pattern: if (user.id !== 5) setUser({ ...user, id: 5 })
      const leftIsMemberOfState =
        left?.type === 'MemberExpression' &&
        left.object?.type === 'Identifier' &&
        left.object.name === stateVar;

      const rightIsMemberOfState =
        right?.type === 'MemberExpression' &&
        right.object?.type === 'Identifier' &&
        right.object.name === stateVar;

      if (leftIsMemberOfState || rightIsMemberOfState) {
        // Check if setter creates a new object reference
        const setterArg = setterCall.arguments?.[0];
        if (setterArg && usesObjectSpread(setterArg, stateVar)) {
          // This is risky: guard checks property, but setter creates new object
          return {
            type: 'object-spread-risk',
            isSafe: false,
            warning:
              `Guard checks property of '${stateVar}' but setter creates new object reference. ` +
              `Even after the property matches, the object reference changes each render, ` +
              `which may cause issues if other effects or memoized values depend on object identity.`,
          };
        }

        // Property check without object spread - could be safe
        return { type: 'equality-guard', isSafe: true };
      }
    }

    // Check for === or == with early return (handled elsewhere)
  }

  // Pattern 3: Logical AND with state check - `if (someCondition && !stateVar)`
  if (condition.type === 'LogicalExpression' && condition.operator === '&&') {
    // Recursively check both sides
    const leftResult = analyzeCondition(condition.left, stateVar, setterCall, _ifStatement, setterName);
    const rightResult = analyzeCondition(condition.right, stateVar, setterCall, _ifStatement, setterName);

    if (leftResult?.isSafe) return leftResult;
    if (rightResult?.isSafe) return rightResult;
  }

  return null;
}

/**
 * Check if a node is a falsy literal value (false, 0, '', null, undefined).
 * Used to detect toggle guard patterns where setting a falsy value terminates the loop.
 */
function isFalsyLiteralNode(node: t.Node | null | undefined): boolean {
  if (!node) return false;
  return (
    (node.type === 'BooleanLiteral' && node.value === false) ||
    (node.type === 'NumericLiteral' && node.value === 0) ||
    (node.type === 'StringLiteral' && node.value === '') ||
    node.type === 'NullLiteral' ||
    (node.type === 'Identifier' && node.name === 'undefined')
  );
}

/**
 * Result of render-phase guard analysis.
 */
export interface RenderPhaseGuardResult {
  /** Whether the guard makes this setState safe */
  isSafe: boolean;
  /** The type of guard detected */
  guardType: 'derived-state' | 'toggle-guard' | 'unknown';
  /** Optional warning message */
  warning?: string;
}

/**
 * Analyze whether a render-phase setState is guarded by a safe condition.
 *
 * The "derived state" pattern is the valid use case:
 * ```tsx
 * function Component({ row }) {
 *   const [prevRow, setPrevRow] = useState(null);
 *   if (row !== prevRow) {
 *     setPrevRow(row);  // Safe - only runs once per prop change
 *   }
 *   return <div>...</div>;
 * }
 * ```
 *
 * This is explicitly documented by React as a valid pattern:
 * https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
 *
 * The key to a safe guard is:
 * 1. The condition compares a prop/external value to the state being set
 * 2. The setter updates the state to match the comparison value
 * 3. After the update, the condition becomes false
 */
export function analyzeRenderPhaseGuard(
  setterCall: t.CallExpression,
  ancestorStack: t.Node[],
  _setterName: string,
  stateVar: string
): RenderPhaseGuardResult | null {
  // Search all ancestor IfStatements for a safe guard pattern.
  // We iterate from nearest to outermost to find any safe guard.
  // Example where we need to check multiple levels:
  // if (prop !== state) { // Safe outer guard - we want to find this
  //   if (someOtherCondition) { // Unrecognized inner guard
  //     setState(prop);
  //   }
  // }
  let isGuarded = false;

  for (let i = 1; i < ancestorStack.length; i++) {
    const ancestor = ancestorStack[i];

    if (ancestor.type === 'IfStatement') {
      isGuarded = true;
      const condition = ancestor.test;
      const result = analyzeRenderGuardCondition(condition, stateVar, setterCall);

      if (result) {
        // Found a recognizable safe guard pattern
        return result;
      }
      // Unrecognized guard found, but continue searching upward
      // in case a safe guard exists in an outer scope
    }
  }

  if (isGuarded) {
    // The call is inside one or more IfStatements, but no recognized safe pattern was found
    return {
      isSafe: false,
      guardType: 'unknown',
    };
  }

  // No guard found - unconditional render-phase setState
  return null;
}

/**
 * Analyze if a condition creates a safe guard for render-phase setState.
 *
 * Safe patterns:
 * 1. Derived state: `if (prop !== prevProp) setPrevProp(prop)`
 *    - Condition compares external value to state
 *    - Setter updates state to match external value
 * 2. Toggle: `if (!isInitialized) setIsInitialized(true)`
 *    - Condition checks state is falsy
 *    - Setter sets to truthy, so condition becomes false
 * 3. Related state reset: `if (prop !== prevProp) { setPrevProp(prop); setRelated(null); }`
 *    - Condition is a derived state pattern for one variable
 *    - Other setters reset related state to a constant value
 */
function analyzeRenderGuardCondition(
  condition: t.Node | null | undefined,
  stateVar: string,
  setterCall: t.CallExpression
): RenderPhaseGuardResult | null {
  if (!condition) return null;

  // Pattern 1: Inequality comparison - `if (prop !== state)` or `if (state !== prop)`
  if (condition.type === 'BinaryExpression') {
    const { left, right, operator } = condition;

    // Check for !== or !=
    if (operator === '!==' || operator === '!=') {
      const hasStateOnLeft = left?.type === 'Identifier' && left.name === stateVar;
      const hasStateOnRight = right?.type === 'Identifier' && right.name === stateVar;

      if (hasStateOnLeft || hasStateOnRight) {
        // Get the "other" side of the comparison (the prop/external value)
        const otherSide = hasStateOnLeft ? right : left;

        // Check if the setter argument matches the "other" side
        // This confirms the pattern: if (prop !== state) setState(prop)
        const setterArg = setterCall.arguments?.[0];

        if (setterArg && nodesAreEquivalent(setterArg, otherSide)) {
          // This is the classic derived state pattern
          return {
            isSafe: true,
            guardType: 'derived-state',
          };
        }
        // Note: We intentionally don't mark other patterns as safe here.
        // if (A !== state) setState(B) where A !== B could cause infinite loops.
      }

      // Check for derived state pattern with a DIFFERENT state variable
      // Pattern: if (prop !== otherState) setThisState(constant)
      // This handles: if (items !== prevItems) setSelection(null)
      // where the condition is a derived state pattern for prevItems, not selection
      //
      // To reduce false negatives, we require:
      // 1. At least one side is a MemberExpression (more likely to be a prop like props.items)
      //    OR we're setting to a strict "reset" value (null, undefined, false, empty array/object)
      // 2. The setter sets to a constant reset value
      //
      // Note: This heuristic could still miss cases like `if (state1 !== state2) setState3(null)`
      // where both sides are state variables. A full fix would require passing state info down.
      const leftIsIdentifierOrMember =
        left?.type === 'Identifier' || left?.type === 'MemberExpression';
      const rightIsIdentifierOrMember =
        right?.type === 'Identifier' || right?.type === 'MemberExpression';

      // At least one side should be an identifier or member expression
      if (leftIsIdentifierOrMember && rightIsIdentifierOrMember) {
        const setterArg = setterCall.arguments?.[0];

        // Check if setter argument is a strict reset value (excludes arbitrary numbers/strings)
        const isStrictResetValue =
          setterArg?.type === 'NullLiteral' ||
          (setterArg?.type === 'Identifier' && setterArg.name === 'undefined') ||
          (setterArg?.type === 'BooleanLiteral' && setterArg.value === false) ||
          (setterArg?.type === 'ArrayExpression' && setterArg.elements.length === 0) ||
          (setterArg?.type === 'ObjectExpression' && setterArg.properties.length === 0);

        // Also allow falsy literals (0, '') as reset values
        const isFalsyResetValue =
          (setterArg?.type === 'NumericLiteral' && setterArg.value === 0) ||
          (setterArg?.type === 'StringLiteral' && setterArg.value === '');

        if (isStrictResetValue || isFalsyResetValue) {
          return {
            isSafe: true,
            guardType: 'derived-state',
          };
        }
      }
    }
  }

  // Pattern 2: Toggle guard - `if (!stateVar)`
  if (condition.type === 'UnaryExpression' && condition.operator === '!') {
    if (condition.argument?.type === 'Identifier' && condition.argument.name === stateVar) {
      const setterArg = setterCall.arguments?.[0];

      // `if (!state) setState(someTruthyValue)`
      // The guard is safe if the new value is "truthy", which will make `!state` false on the next render.
      // We can't know the truthiness of all expressions, but we can check for common falsy literals.
      if (setterArg && !isFalsyLiteralNode(setterArg)) {
        return {
          isSafe: true,
          guardType: 'toggle-guard',
        };
      }
    }
  }

  // Pattern 3: Direct state check - `if (stateVar)` with falsy setter
  if (condition.type === 'Identifier' && condition.name === stateVar) {
    const setterArg = setterCall.arguments?.[0];
    if (isFalsyLiteralNode(setterArg)) {
      return {
        isSafe: true,
        guardType: 'toggle-guard',
      };
    }
  }

  // Pattern 4: Logical AND with state check - `if (someCondition && prop !== state)`
  if (condition.type === 'LogicalExpression' && condition.operator === '&&') {
    const leftResult = analyzeRenderGuardCondition(condition.left, stateVar, setterCall);
    const rightResult = analyzeRenderGuardCondition(condition.right, stateVar, setterCall);

    if (leftResult?.isSafe) return leftResult;
    if (rightResult?.isSafe) return rightResult;
  }

  return null;
}

/**
 * Check if two AST nodes are structurally equivalent.
 * Used to match patterns like: if (prop !== state) setState(prop)
 */
function nodesAreEquivalent(a: t.Node | null | undefined, b: t.Node | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;

  // Simple identifier comparison
  if (a.type === 'Identifier' && b.type === 'Identifier') {
    return a.name === b.name;
  }

  // Member expression comparison (e.g., props.row === props.row or props['row'] === props.row)
  if (a.type === 'MemberExpression' && b.type === 'MemberExpression') {
    if (!nodesAreEquivalent(a.object, b.object)) {
      return false;
    }

    const propA = a.property;
    const propB = b.property;

    // Case 1: a.prop vs b.prop (both non-computed)
    if (t.isIdentifier(propA) && !a.computed && t.isIdentifier(propB) && !b.computed) {
      return propA.name === propB.name;
    }
    // Case 2: a['prop'] vs b['prop'] (both computed with string literals)
    if (t.isStringLiteral(propA) && a.computed && t.isStringLiteral(propB) && b.computed) {
      return propA.value === propB.value;
    }
    // Case 3: a.prop vs b['prop'] (mixed)
    if (t.isIdentifier(propA) && !a.computed && t.isStringLiteral(propB) && b.computed) {
      return propA.name === propB.value;
    }
    // Case 4: a['prop'] vs b.prop (mixed)
    if (t.isStringLiteral(propA) && a.computed && t.isIdentifier(propB) && !b.computed) {
      return propA.value === propB.name;
    }

    // Fallback for other cases, e.g., a[prop] vs b[prop] where prop is a variable
    return nodesAreEquivalent(propA, propB);
  }

  // Literal comparison
  if (a.type === 'NumericLiteral' && b.type === 'NumericLiteral') {
    return a.value === b.value;
  }
  if (a.type === 'StringLiteral' && b.type === 'StringLiteral') {
    return a.value === b.value;
  }
  if (a.type === 'BooleanLiteral' && b.type === 'BooleanLiteral') {
    return a.value === b.value;
  }
  if (a.type === 'NullLiteral' && b.type === 'NullLiteral') {
    return true;
  }

  return false;
}

/**
 * Check for early return pattern:
 * ```
 * if (value === something) return;
 * setValue(newValue);
 * ```
 */
export function checkEarlyReturnPattern(
  blockStatement: t.BlockStatement,
  setterCall: t.CallExpression,
  stateVar: string
): boolean {
  if (!blockStatement.body || !Array.isArray(blockStatement.body)) return false;

  // Find the index of the setter call in the block
  let setterIndex = -1;
  for (let i = 0; i < blockStatement.body.length; i++) {
    if (containsNode(blockStatement.body[i], setterCall)) {
      setterIndex = i;
      break;
    }
  }

  if (setterIndex <= 0) return false;

  // Check statements before the setter for early return guards
  for (let i = 0; i < setterIndex; i++) {
    const stmt = blockStatement.body[i];

    if (stmt.type === 'IfStatement') {
      // Check if it's `if (condition) return;`
      const hasReturn =
        stmt.consequent?.type === 'ReturnStatement' ||
        (stmt.consequent?.type === 'BlockStatement' &&
          stmt.consequent.body?.length === 1 &&
          stmt.consequent.body[0]?.type === 'ReturnStatement');

      if (hasReturn) {
        // Check if condition involves the state variable
        if (conditionInvolvesState(stmt.test, stateVar)) {
          return true;
        }
      }
    }
  }

  return false;
}
