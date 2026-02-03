/**
 * Shared Types for React Loop Detector
 *
 * This module contains all shared type definitions used across the analyzer modules.
 */

import * as t from '@babel/types';
import type { TypeChecker, TypeCheckerPool } from './type-checker';

/**
 * Error codes for categorizing issues.
 * - RLD-1XX: Critical issues that will crash the browser (synchronous/render-phase loops)
 * - RLD-2XX: Critical issues from effect loops (useEffect/useLayoutEffect)
 * - RLD-3XX: Warning-level cross-file risks
 * - RLD-4XX: Performance issues (unstable references)
 * - RLD-5XX: Performance issues (missing dependencies)
 * - RLD-6XX: Ref mutation issues
 */
export type ErrorCode =
  | 'RLD-100' // Render phase setState (synchronous loop)
  | 'RLD-101' // Render phase setState via function call
  | 'RLD-200' // useEffect unconditional setState loop
  | 'RLD-201' // useEffect missing deps with setState
  | 'RLD-202' // useLayoutEffect unconditional setState loop
  | 'RLD-300' // Cross-file loop risk
  | 'RLD-301' // Cross-file conditional modification
  | 'RLD-400' // Unstable object reference in deps
  | 'RLD-401' // Unstable array reference in deps
  | 'RLD-402' // Unstable function reference in deps
  | 'RLD-403' // Unstable function call result in deps
  | 'RLD-404' // Unstable context provider value
  | 'RLD-405' // Unstable JSX prop
  | 'RLD-406' // Unstable callback in useCallback deps (dependency chain)
  | 'RLD-407' // useSyncExternalStore unstable getSnapshot function
  | 'RLD-408' // Unstable key prop (causes remounting every render)
  | 'RLD-409' // Index used as key (code smell with reordering)
  | 'RLD-410' // Object spread guard risk
  | 'RLD-420' // useCallback/useMemo modifies dependency (no direct loop but review)
  | 'RLD-500' // useEffect missing dependency array
  | 'RLD-501' // Conditional modification needs review
  | 'RLD-600'; // Ref mutation with state value during render phase (effect-phase is safe)

/**
 * Issue categories for filtering and display.
 * - critical: Will crash the browser (infinite loops)
 * - warning: May cause logic bugs or race conditions
 * - performance: Causes unnecessary re-renders (lag)
 * - safe: Safe pattern (informational only)
 */
export type IssueCategory = 'critical' | 'warning' | 'performance' | 'safe';

/** Debug information about why a decision was made */
export interface DebugInfo {
  /** Why this issue was flagged */
  reason: string;
  /** State tracking information */
  stateTracking?: {
    declaredStateVars: string[];
    setterFunctions: string[];
    stableVariables: string[];
    unstableVariables: string[];
  };
  /** Dependency analysis */
  dependencyAnalysis?: {
    rawDependencies: string[];
    problematicDeps: string[];
    safeDeps: string[];
  };
  /** Guard detection */
  guardInfo?: {
    hasGuard: boolean;
    guardType?: string;
    guardVariable?: string;
  };
  /** Deferred modification detection */
  deferredInfo?: {
    isDeferred: boolean;
    deferredContext?: string;
  };
  /** Cross-file analysis */
  crossFileInfo?: {
    analyzedImports: string[];
    foundStateModifications: string[];
  };
}

export interface HookAnalysis {
  type: 'confirmed-infinite-loop' | 'potential-issue' | 'safe-pattern';
  /** Stable error code for filtering and ignoring specific issue types */
  errorCode: ErrorCode;
  /** Issue category for grouping and filtering */
  category: IssueCategory;
  description: string;
  file: string;
  line: number;
  column?: number;
  hookType: string;
  functionName?: string;
  problematicDependency: string;
  stateVariable?: string;
  setterFunction?: string;
  severity: 'high' | 'medium' | 'low';
  confidence: 'high' | 'medium' | 'low';
  /** Detailed explanation of the problem */
  explanation: string;
  /** Actionable suggestion for how to fix the issue */
  suggestion?: string;
  actualStateModifications: string[];
  stateReads: string[];
  /** Debug information (only populated when debug mode is enabled) */
  debugInfo?: DebugInfo;
}

export interface HookNodeInfo {
  node: t.CallExpression;
  hookName: string;
  line: number;
}

export interface StateInteraction {
  reads: string[];
  modifications: string[];
  conditionalModifications: string[];
  functionalUpdates: string[];
  /** Modifications inside async callbacks (setInterval, onSnapshot, setTimeout, etc.) - these are deferred and don't cause immediate loops */
  deferredModifications: string[];
  // Enhanced: track guarded modifications with their guard info
  guardedModifications: GuardedModification[];
  // Track functions passed as references (not invoked) - e.g., addEventListener('click', handleClick)
  functionReferences: FunctionReference[];
  /** Track ref.current mutations - e.g., ref.current = value */
  refMutations: RefMutation[];
  /** Modifications inside cleanup functions (return () => setState()) - can cause loops when effect re-runs */
  cleanupModifications: string[];
}

export interface RefMutation {
  refName: string;
  /** The value being assigned (if it's an identifier) */
  assignedValue?: string;
  /** Whether the mutation uses a state variable */
  usesStateValue: boolean;
  /** Line number of the mutation */
  line: number;
}

export interface FunctionReference {
  functionName: string;
  context: 'event-listener' | 'callback-arg' | 'unknown';
  // The function that receives this reference (e.g., 'addEventListener', 'setTimeout')
  receivingFunction: string;
}

export interface GuardedModification {
  setter: string;
  stateVariable: string;
  guardType: 'toggle-guard' | 'equality-guard' | 'early-return' | 'object-spread-risk' | 'unknown';
  isSafe: boolean;
  /** Warning message for risky but not definitely unsafe patterns */
  warning?: string;
}

/** Options for intelligent hooks analysis */
export interface AnalyzerOptions {
  /** Hooks known to return stable references */
  stableHooks?: string[];
  /** Hooks known to return unstable references */
  unstableHooks?: string[];
  /** Regex patterns for hooks that return stable references (e.g., /^use\w+Store$/ for Zustand) */
  stableHookPatterns?: RegExp[];
  /** Regex patterns for hooks that return unstable references */
  unstableHookPatterns?: RegExp[];
  /** Custom function stability settings */
  customFunctions?: Record<
    string,
    {
      stable?: boolean;
      deferred?: boolean;
    }
  >;
  /** Enable debug mode to collect detailed decision information */
  debug?: boolean;
  /** Enable TypeScript strict mode for type-based stability detection */
  strictMode?: boolean;
  /** Custom path to tsconfig.json (for strict mode) */
  tsconfigPath?: string;
  /** Project root directory (required for strict mode) */
  projectRoot?: string;
  /**
   * Optional pre-existing TypeChecker instance for strict mode.
   * If provided, this will be used instead of creating a new one.
   * This enables persistent type checking in the VS Code extension.
   */
  typeChecker?: TypeChecker | null;
  /**
   * Optional pre-existing TypeCheckerPool instance for monorepo strict mode.
   * If provided, this will be used instead of a single TypeChecker.
   * The pool manages multiple TypeChecker instances (one per tsconfig).
   * Takes precedence over typeChecker if both are provided.
   */
  typeCheckerPool?: TypeCheckerPool | null;
}

/** Parameters for creating analysis results */
export interface CreateAnalysisParams {
  type: HookAnalysis['type'];
  errorCode: ErrorCode;
  category: IssueCategory;
  severity: HookAnalysis['severity'];
  confidence: HookAnalysis['confidence'];
  hookType: string;
  line: number;
  column?: number;
  file: string;
  problematicDependency: string;
  stateVariable?: string;
  setterFunction?: string;
  actualStateModifications: string[];
  stateReads: string[];
  explanation: string;
  /** Actionable suggestion for how to fix the issue */
  suggestion?: string;
  debugInfo?: DebugInfo;
}
