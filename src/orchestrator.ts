/**
 * Orchestrator
 *
 * Main entry point for intelligent hook analysis. Coordinates the various
 * detection modules to identify infinite loop patterns in React hooks.
 *
 * Detection modules:
 * - state-extractor.ts: State/ref/unstable variable extraction + stability heuristics
 * - render-phase-detector.ts: Render-phase setState detection
 * - guard-analyzer.ts: Guard/condition analysis for safe patterns
 * - effect-analyzer.ts: useEffect/useLayoutEffect specific logic
 * - hook-analyzer.ts: Core hook node analysis
 * - unstable-refs-detector.ts: Unstable reference detection in dependency arrays
 */

import * as fs from 'fs';
import * as path from 'path';
import { ParsedFile, parseFile } from './parser';
import { analyzeCrossFileRelations, CrossFileAnalysis } from './cross-file-analyzer';
import { createPathResolver } from './path-resolver';
import { TypeChecker, TypeCheckerPool, createTypeChecker } from './type-checker';

// Import types
import { HookAnalysis, AnalyzerOptions } from './types';

// Import modules
import {
  extractStateInfo,
  extractUnstableVariables,
  isConfiguredStableHook as _isConfiguredStableHook,
  isConfiguredUnstableHook as _isConfiguredUnstableHook,
  isConfiguredStableFunction as _isConfiguredStableFunction,
  isConfiguredDeferredFunction as _isConfiguredDeferredFunction,
  StabilityConfig,
} from './state-extractor';
import { detectSetStateDuringRender, detectRefMutationDuringRender } from './render-phase-detector';
import { detectUseEffectWithoutDeps, buildLocalFunctionSetterMap } from './effect-analyzer';
import { findHookNodes, analyzeHookNode } from './hook-analyzer';
import { checkUnstableReferences } from './unstable-refs-detector';
import { analyzeJsxProps } from './jsx-prop-analyzer';
import { detectUnstableSyncExternalStore } from './sync-external-store-detector';
import { analyzeKeyProps } from './key-analyzer';
import { setCurrentOptions, shouldLogToConsole } from './utils';

// Re-export types for backward compatibility
export type { HookAnalysis, AnalyzerOptions, ErrorCode, IssueCategory, DebugInfo } from './types';

/**
 * Module-level type checker instance (only created when strict mode is enabled).
 * For single-project setups, this holds a single TypeChecker.
 */
let typeChecker: TypeChecker | null = null;

/**
 * Module-level type checker pool for monorepo setups.
 * When set, typeChecker should be null - the pool manages multiple TypeChecker instances.
 */
let typeCheckerPool: TypeCheckerPool | null = null;

/**
 * Module-level options for the stability config functions
 */
let currentOptions: AnalyzerOptions = {};

/**
 * Check if a hook is configured as stable via options
 */
export function isConfiguredStableHook(hookName: string): boolean {
  return _isConfiguredStableHook(hookName, currentOptions);
}

/**
 * Check if a hook is configured as unstable via options
 */
export function isConfiguredUnstableHook(hookName: string): boolean {
  return _isConfiguredUnstableHook(hookName, currentOptions);
}

/**
 * Check if a function is configured as stable via options
 */
export function isConfiguredStableFunction(functionName: string): boolean {
  return _isConfiguredStableFunction(functionName, currentOptions);
}

/**
 * Check if a function is configured as deferred (async) via options
 */
export function isConfiguredDeferredFunction(functionName: string): boolean {
  return _isConfiguredDeferredFunction(functionName, currentOptions);
}

/** Yield to event loop to allow spinner animation */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Main entry point for intelligent hooks analysis.
 * Analyzes parsed React files for potential infinite loop patterns.
 */
export async function analyzeHooks(
  parsedFiles: ParsedFile[],
  options: AnalyzerOptions = {}
): Promise<HookAnalysis[]> {
  const results: HookAnalysis[] = [];

  // Store options for helper functions
  currentOptions = options;
  setCurrentOptions(options);

  // Initialize type checker if strict mode is enabled
  // Priority: provided typeCheckerPool > provided typeChecker > create new
  const hasProvidedPool =
    options.strictMode && options.typeCheckerPool !== undefined && options.typeCheckerPool !== null;
  const hasProvidedTypeChecker =
    options.strictMode &&
    options.typeChecker !== undefined &&
    options.typeChecker !== null &&
    !hasProvidedPool;
  const shouldCreateTypeChecker =
    options.strictMode &&
    options.projectRoot &&
    options.typeChecker === undefined &&
    options.typeCheckerPool === undefined;

  if (hasProvidedPool) {
    // Use the provided persistent type checker pool (monorepo support)
    typeCheckerPool = options.typeCheckerPool!;
    typeChecker = null;
    if (shouldLogToConsole()) {
      const isMonorepo = typeCheckerPool.isMonorepo();
      console.log(
        `Using persistent TypeScript type checker pool for strict mode analysis${isMonorepo ? ' (monorepo detected)' : ''}.`
      );
    }
  } else if (hasProvidedTypeChecker) {
    // Use the provided persistent type checker (single project, backwards compatible)
    typeChecker = options.typeChecker!;
    typeCheckerPool = null;
    if (shouldLogToConsole()) {
      console.log('Using persistent TypeScript type checker for strict mode analysis.');
    }
  } else if (shouldCreateTypeChecker) {
    // Create a new type checker (single project mode for backwards compatibility)
    typeChecker = createTypeChecker({
      projectRoot: options.projectRoot!,
      tsconfigPath: options.tsconfigPath,
      cacheTypes: true,
    });
    typeCheckerPool = null;

    const initialized = typeChecker.initialize();
    if (!initialized) {
      const error = typeChecker.getInitError();
      if (shouldLogToConsole()) {
        console.warn(`Warning: Could not initialize TypeScript type checker: ${error?.message}`);
        console.warn('Falling back to heuristic-based stability detection.');
      }
      typeChecker = null;
    } else if (shouldLogToConsole()) {
      console.log('TypeScript type checker initialized for strict mode analysis.');
    }
  } else {
    typeChecker = null;
    typeCheckerPool = null;
  }

  // First, build cross-file analysis including imported utilities
  const allFiles = expandToIncludeImportedFiles(parsedFiles);
  const crossFileAnalysis = analyzeCrossFileRelations(allFiles);

  for (const file of parsedFiles) {
    try {
      const fileResults = analyzeFileIntelligently(file, crossFileAnalysis, options, allFiles);
      results.push(...fileResults);
    } catch (error) {
      console.warn(`Could not analyze hooks intelligently in ${file.file}:`, error);
    }
    // Yield to event loop periodically to allow spinner animation
    await yieldToEventLoop();
  }

  // Cleanup type checker ONLY if we created it (not if it was provided/persistent)
  if (typeChecker && !hasProvidedTypeChecker) {
    typeChecker.dispose();
    typeChecker = null;
  } else {
    // Clear the module-level reference but don't dispose (caller owns the instance)
    typeChecker = null;
  }

  // Clear the pool reference (we never create pools here, only accept provided ones)
  typeCheckerPool = null;

  return results;
}

/**
 * Analyze a single file for hook issues.
 */
function analyzeFileIntelligently(
  file: ParsedFile,
  crossFileAnalysis: CrossFileAnalysis,
  options: AnalyzerOptions,
  allParsedFiles: ParsedFile[]
): HookAnalysis[] {
  const results: HookAnalysis[] = [];

  try {
    // Use the cached AST from ParsedFile instead of re-parsing
    const ast = file.ast;

    // Extract state variables, their setters, and ref variables
    const { stateVariables: stateInfo, refVariables: refVars } = extractStateInfo(ast);

    // Get the appropriate type checker for this file
    // If we have a pool (monorepo), get the checker for this specific file's tsconfig
    // Otherwise, use the single type checker (single project mode)
    const fileTypeChecker = typeCheckerPool?.getCheckerForFile(file.file) ?? typeChecker;

    // Extract unstable local variables (objects, arrays, functions created in component body)
    // Pass file path for type-aware stability checking in strict mode
    const stabilityConfig: StabilityConfig = {
      stableHooks: options.stableHooks,
      unstableHooks: options.unstableHooks,
      stableHookPatterns: options.stableHookPatterns,
      unstableHookPatterns: options.unstableHookPatterns,
      customFunctions: options.customFunctions,
    };
    const unstableVars = extractUnstableVariables(ast, file.file, fileTypeChecker, stabilityConfig);

    // Check for setState during render (outside hooks/event handlers)
    const renderStateIssues = detectSetStateDuringRender(ast, stateInfo, file.file, file.content);
    results.push(...renderStateIssues);

    // Check for ref.current mutations during render (outside hooks/event handlers)
    const renderRefIssues = detectRefMutationDuringRender(ast, file.file, file.content);
    results.push(...renderRefIssues);

    // Check for useEffect without dependency array
    const noDepsIssues = detectUseEffectWithoutDeps(ast, stateInfo, file.file, file.content);
    results.push(...noDepsIssues);

    // Check for unstable props passed to JSX elements (including Context.Provider)
    // Pass localMemoizedComponents, imports and all parsed files for cross-file memoization detection
    const jsxPropIssues = analyzeJsxProps(
      ast,
      unstableVars,
      file.file,
      file.localMemoizedComponents,
      file.imports,
      allParsedFiles
    );
    results.push(...jsxPropIssues);

    // Check for unstable getSnapshot in useSyncExternalStore calls
    const syncExternalStoreIssues = detectUnstableSyncExternalStore(
      ast,
      unstableVars,
      file.file,
      file.content
    );
    results.push(...syncExternalStoreIssues);

    // Check for unstable key props in JSX elements
    const keyPropIssues = analyzeKeyProps(ast, unstableVars, file.file, file.content);
    results.push(...keyPropIssues);

    // Build map of local functions to the setters they call (for indirect modification detection)
    const localFunctionSetters = buildLocalFunctionSetterMap(ast, stateInfo);

    // Analyze each hook
    const hookNodes = findHookNodes(ast);

    for (const hookNode of hookNodes) {
      // First check for unstable reference issues
      const unstableRefIssue = checkUnstableReferences(
        hookNode,
        unstableVars,
        stateInfo,
        file.file,
        file.content
      );
      if (unstableRefIssue) {
        results.push(unstableRefIssue);
        continue; // Don't double-report the same hook
      }

      const analysis = analyzeHookNode(
        hookNode,
        stateInfo,
        file.file,
        crossFileAnalysis,
        file.content,
        refVars,
        localFunctionSetters
      );
      if (analysis) {
        results.push(analysis);
      }
    }
  } catch (error) {
    console.warn(`Could not parse ${file.file} for intelligent analysis:`, error);
  }

  return results;
}

/**
 * Expand the list of files to include imported utilities.
 * Uses a queue-based traversal to recursively include all transitive imports.
 */
function expandToIncludeImportedFiles(parsedFiles: ParsedFile[]): ParsedFile[] {
  const allFilesMap = new Map<string, ParsedFile>(parsedFiles.map((f) => [f.file, f]));
  const queue = [...parsedFiles];

  // Find project root for path resolution
  const projectRoot = findProjectRoot(parsedFiles);
  const pathResolver = projectRoot ? createPathResolver({ projectRoot }) : null;

  let fileToProcess: ParsedFile | undefined;
  while ((fileToProcess = queue.shift())) {
    // Use the already-parsed imports from ParsedFile
    for (const importInfo of fileToProcess.imports) {
      // Try to resolve the import path
      const resolvedPath = pathResolver?.resolve(fileToProcess.file, importInfo.source);

      if (resolvedPath && !allFilesMap.has(resolvedPath)) {
        // Skip non-JS/TS files (CSS, JSON, images, etc.)
        const ext = path.extname(resolvedPath).toLowerCase();
        if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
          continue;
        }

        try {
          const newParsedFile = parseFile(resolvedPath);
          allFilesMap.set(resolvedPath, newParsedFile);
          queue.push(newParsedFile); // Process imports of the new file
        } catch {
          // Warn that file couldn't be parsed - analysis may be incomplete
          if (shouldLogToConsole()) {
            console.warn(
              `Warning: Could not parse imported file ${resolvedPath}. Analysis may be incomplete.`
            );
          }
        }
      }
    }
  }

  return Array.from(allFilesMap.values());
}

/**
 * Find project root by looking for tsconfig.json or package.json
 */
function findProjectRoot(parsedFiles: ParsedFile[]): string | null {
  if (parsedFiles.length === 0) return null;

  // Start from the first file's directory
  let dir = path.dirname(parsedFiles[0].file);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const tsconfigPath = path.join(dir, 'tsconfig.json');
    const jsconfigPath = path.join(dir, 'jsconfig.json');
    const packagePath = path.join(dir, 'package.json');

    if (fs.existsSync(tsconfigPath) || fs.existsSync(jsconfigPath) || fs.existsSync(packagePath)) {
      return dir;
    }

    dir = path.dirname(dir);
  }

  return null;
}
