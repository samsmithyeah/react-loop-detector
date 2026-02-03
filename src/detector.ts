import { glob, Path } from 'glob';
import * as path from 'path';
import * as fs from 'fs';
import { cpus } from 'os';
import micromatch from 'micromatch';
import Piscina from 'piscina';
import chalk from 'chalk';
import ora from 'ora';
import gradient from 'gradient-string';
import { parseFile, parseFileWithCache, HookInfo, ParsedFile } from './parser';
import { buildModuleGraph, detectAdvancedCrossFileCycles, CrossFileCycle } from './module-graph';
import { analyzeHooks, HookAnalysis } from './orchestrator';
import {
  loadConfigWithInfo,
  mergeConfig,
  RcdConfig,
  severityLevel,
  confidenceLevel,
} from './config';
import { AstCache } from './cache';
import type { ParseResult, ParseTask } from './parse-worker';
import { getChangedFilesSinceRef } from './git-utils';
import { createPathResolver } from './path-resolver';
import { createTsconfigManager, MonorepoInfo } from './tsconfig-manager';
import { TypeCheckerPool, getPersistentTypeCheckerPool } from './type-checker';
import { shouldLogToConsole } from './utils';

/**
 * Simple progress tracker interface
 */
interface ProgressTracker {
  update(value: number): void;
  stop(): void;
  succeed?(message?: string): void;
}

/**
 * Create a progress bar for file parsing.
 * Uses a visual progress bar in TTY environments, falls back to periodic text updates otherwise.
 */
function createProgressBar(total: number): ProgressTracker | null {
  if (!shouldLogToConsole() || total < 10) {
    return null; // Don't show progress for small projects or in quiet/json mode
  }

  const isTTY = process.stdout.isTTY;

  if (isTTY) {
    const useColor = chalk.level > 0;
    const startTime = performance.now();
    let lastRender = 0;
    let stopped = false;

    const spinner = ora({
      text: `Parsing 0/${total} files`,
      spinner: 'dots',
      color: 'cyan',
    }).start();

    const formatDurationShort = (ms: number): string => {
      if (ms < 1000) return `${Math.round(ms)}ms`;
      const s = ms / 1000;
      if (s < 60) return `${s.toFixed(1)}s`;
      const m = Math.floor(s / 60);
      const remS = Math.round(s % 60);
      return `${m}m ${remS}s`;
    };

    const render = (value: number) => {
      if (stopped) return;
      const now = performance.now();
      if (now - lastRender < 80 && value < total) return; // throttle updates
      lastRender = now;

      const ratio = total === 0 ? 1 : value / total;
      const pct = Math.min(100, Math.round(ratio * 100));
      const columns = process.stdout.columns ?? 80;

      const elapsedMs = now - startTime;
      const elapsedSec = elapsedMs / 1000;
      const speed = elapsedSec > 0 ? value / elapsedSec : 0;
      const etaMs = speed > 0 ? ((total - value) / speed) * 1000 : 0;

      const labelPlain = 'Parsing';
      const pctPlain = `${pct}%`;
      const countPlain = `(${value}/${total} files)`;
      const elapsedPlain = `elapsed ${formatDurationShort(elapsedMs)}`;
      const etaPlain = etaMs > 0 ? `ETA ${formatDurationShort(etaMs)}` : '';
      const speedPlain = speed > 0 ? `${speed.toFixed(1)} files/s` : '';

      const suffixParts = [pctPlain, countPlain, elapsedPlain, etaPlain, speedPlain].filter(
        Boolean
      );
      const suffixPlain = suffixParts.join(' • ');

      const reserved = labelPlain.length + 1 + suffixPlain.length + 2; // spaces around bar
      const barWidth = Math.max(10, Math.min(40, columns - reserved));

      const filled = Math.round(ratio * barWidth);
      const empty = Math.max(0, barWidth - filled);
      const filledStr = '█'.repeat(filled);
      const emptyStr = '░'.repeat(empty);

      const bar = useColor
        ? gradient(['#00d4ff', '#7b61ff', '#ff6ad5'])(filledStr) + chalk.gray(emptyStr)
        : filledStr + emptyStr;

      const label = useColor ? chalk.cyanBright(labelPlain) : labelPlain;
      const suffix = useColor ? chalk.gray(suffixPlain) : suffixPlain;

      spinner.text = `${label} ${bar} ${suffix}`;
    };

    render(0);

    return {
      update(value: number) {
        render(value);
      },
      stop() {
        if (stopped) return;
        stopped = true;
        spinner.stop();
      },
      succeed(message?: string) {
        if (stopped) return;
        stopped = true;
        spinner.succeed(message || `Parsed ${total} files`);
      },
    };
  } else {
    // Fallback for non-TTY: single status message at start
    console.log(`Analyzing ${total} files...`);
    return {
      update(_value: number) {
        // No incremental updates in non-TTY to keep output clean
      },
      stop() {
        // Progress implicitly ends when analysis completes
      },
    };
  }
}

type StageSpinner = ReturnType<typeof ora> | null;

function createStageSpinner(
  text: string,
  color: 'cyan' | 'magenta' | 'yellow' = 'cyan'
): StageSpinner {
  if (!shouldLogToConsole() || !process.stdout.isTTY) {
    return null;
  }
  return ora({ text, spinner: 'dots', color }).start();
}

export interface CircularDependency {
  file: string;
  line: number;
  hookName: string;
  cycle: string[];
}

export interface DetectionResults {
  circularDependencies: CircularDependency[];
  crossFileCycles: CrossFileCycle[];
  intelligentHooksAnalysis: HookAnalysis[];
  /** Information about how strict mode was resolved */
  strictModeDetection: StrictModeDetection;
  summary: {
    filesAnalyzed: number;
    hooksAnalyzed: number;
    circularDependencies: number;
    crossFileCycles: number;
    intelligentAnalysisCount: number;
    /** Number of issues filtered out by config (severity/confidence filters) */
    filteredCount: number;
    /** Analysis duration in milliseconds */
    durationMs: number;
  };
}

export interface DetectorOptions {
  pattern: string;
  ignore: string[];
  /** Optional configuration override (if not provided, will load from config file) */
  config?: RcdConfig;
  /** Enable caching for improved performance on repeated runs */
  cache?: boolean;
  /** Enable debug mode to collect detailed decision information */
  debug?: boolean;
  /** Enable parallel parsing using worker threads (improves performance for large codebases) */
  parallel?: boolean;
  /** Number of worker threads (default: number of CPU cores) */
  workers?: number;
  /**
   * Enable TypeScript strict mode for type-based stability detection.
   * - true: Enable strict mode
   * - false: Disable strict mode (use heuristics only)
   * - undefined: Auto-detect based on tsconfig.json presence
   */
  strict?: boolean;
  /** Custom path to tsconfig.json (for strict mode) */
  tsconfigPath?: string;
  /** Only analyze files changed since this git ref (e.g., 'main', 'HEAD~5') */
  since?: string;
  /** When using --since, also include files that import the changed files */
  includeDependents?: boolean;
}

/**
 * Result of strict mode auto-detection
 */
export interface StrictModeDetection {
  enabled: boolean;
  reason: 'explicit' | 'auto-detected' | 'disabled' | 'no-tsconfig';
  tsconfigPath?: string;
  /** Whether a monorepo structure was detected */
  isMonorepo?: boolean;
  /** Type of monorepo (yarn, pnpm, lerna, etc.) */
  monorepoType?: MonorepoInfo['type'];
}

/**
 * Find tsconfig.json in the project directory or parent directories
 */
function findTsConfig(targetPath: string): string | null {
  let currentDir = path.resolve(targetPath);
  const root = path.parse(currentDir).root;

  while (currentDir !== root) {
    const tsconfigPath = path.join(currentDir, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      return tsconfigPath;
    }
    currentDir = path.dirname(currentDir);
  }

  return null;
}

/**
 * Determine if strict mode should be enabled based on options and auto-detection.
 * Also detects monorepo structure for multi-tsconfig support.
 */
function resolveStrictMode(
  targetPath: string,
  options: DetectorOptions,
  config: RcdConfig
): StrictModeDetection {
  // Detect monorepo structure
  const tsconfigManager = createTsconfigManager(targetPath);
  const monorepoInfo = tsconfigManager.detectMonorepo();
  const isMonorepo = monorepoInfo.type !== null;

  // 1. Explicit CLI flag takes precedence
  if (options.strict === true) {
    return {
      enabled: true,
      reason: 'explicit',
      tsconfigPath: options.tsconfigPath,
      isMonorepo,
      monorepoType: monorepoInfo.type,
    };
  }

  if (options.strict === false) {
    return {
      enabled: false,
      reason: 'disabled',
      isMonorepo,
      monorepoType: monorepoInfo.type,
    };
  }

  // 2. Config file setting takes precedence over auto-detection
  if (config.strictMode === true) {
    return {
      enabled: true,
      reason: 'explicit',
      tsconfigPath: config.tsconfigPath,
      isMonorepo,
      monorepoType: monorepoInfo.type,
    };
  }

  if (config.strictMode === false) {
    return {
      enabled: false,
      reason: 'disabled',
      isMonorepo,
      monorepoType: monorepoInfo.type,
    };
  }

  // 3. Auto-detect based on tsconfig.json presence
  const detectedTsconfig = options.tsconfigPath || config.tsconfigPath || findTsConfig(targetPath);
  if (detectedTsconfig) {
    return {
      enabled: true,
      reason: 'auto-detected',
      tsconfigPath: detectedTsconfig,
      isMonorepo,
      monorepoType: monorepoInfo.type,
    };
  }

  // 4. No tsconfig found, use heuristics
  return {
    enabled: false,
    reason: 'no-tsconfig',
    isMonorepo,
    monorepoType: monorepoInfo.type,
  };
}

// Minimum file count to benefit from parallel processing
const PARALLEL_THRESHOLD = 20;

export async function detectCircularDependencies(
  targetPath: string,
  options: DetectorOptions
): Promise<DetectionResults> {
  const startTime = performance.now();

  // Load configuration with preset detection
  // Merge order: defaults < presets < config file < options.config
  const configResult = loadConfigWithInfo(targetPath, {
    noPresets: options.config?.noPresets,
  });
  const config = options.config
    ? mergeConfig(configResult.config, options.config)
    : configResult.config;

  // Merge config ignore patterns with CLI ignore patterns
  const mergedIgnore = [...options.ignore, ...(config.ignore || [])];
  const mergedOptions = { ...options, ignore: mergedIgnore };

  // Get all files matching the pattern
  const scanSpinner = createStageSpinner(`Scanning files (${options.pattern})…`, 'cyan');
  const allFiles = await findFiles(targetPath, mergedOptions);

  // Filter to React files first
  const allReactFiles = allFiles.filter((file) => isLikelyReactFile(file));
  scanSpinner?.succeed(`Found ${allReactFiles.length} React files`);

  // Apply git-based filtering if --since is specified
  let reactFiles: string[];
  if (options.since) {
    const gitResult = getChangedFilesSinceRef({
      since: options.since,
      cwd: targetPath,
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
    });

    if (!gitResult.isGitRepo) {
      throw new Error(`Cannot use --since: "${targetPath}" is not inside a git repository`);
    }

    // Create a set of changed files for fast lookup
    const changedFilesSet = new Set(gitResult.changedFiles);

    // Filter to only files that are both React files AND changed
    reactFiles = allReactFiles.filter((file) => changedFilesSet.has(file));

    // If --include-dependents is specified, find files that import changed files
    if (options.includeDependents && reactFiles.length > 0) {
      const dependentsSpinner = createStageSpinner(`Resolving dependents…`, 'cyan');
      // Scan all React files to find which ones import the changed files
      const dependentFiles = await findFilesImportingChangedFiles(
        allReactFiles,
        changedFilesSet,
        targetPath
      );
      dependentsSpinner?.succeed(`Added ${dependentFiles.length} dependent files`);

      // Combine changed files and their dependents, ensuring uniqueness
      reactFiles = Array.from(new Set([...reactFiles, ...dependentFiles]));
    }
  } else {
    reactFiles = allReactFiles;
  }

  // Decide whether to use parallel processing
  // Use parallel if explicitly enabled OR if we have many files and it wasn't explicitly disabled
  const useParallel =
    options.parallel === true ||
    (options.parallel !== false && reactFiles.length >= PARALLEL_THRESHOLD && !options.cache);

  let parsedFiles: ParsedFile[];

  if (useParallel) {
    parsedFiles = await parseFilesParallel(reactFiles, options.workers);
  } else {
    parsedFiles = parseFilesSequential(
      reactFiles,
      options.cache ? new AstCache(targetPath) : undefined
    );
  }

  const circularDeps = findCircularDependencies(parsedFiles);

  // Build module graph and detect cross-file cycles
  const graphSpinner = createStageSpinner('Building import graph…', 'cyan');
  const moduleGraph = buildModuleGraph(parsedFiles);
  const allCrossFileCycles = [
    ...moduleGraph.crossFileCycles,
    ...detectAdvancedCrossFileCycles(parsedFiles),
  ];
  graphSpinner?.succeed('Import graph built');

  // Resolve strict mode based on explicit flags, config, or auto-detection
  const strictModeDetection = resolveStrictMode(targetPath, options, config);

  // Create TypeCheckerPool if in monorepo mode with strict enabled
  let typeCheckerPool: TypeCheckerPool | null = null;
  if (strictModeDetection.enabled && strictModeDetection.isMonorepo) {
    typeCheckerPool = getPersistentTypeCheckerPool(targetPath);
    if (shouldLogToConsole()) {
      console.log(
        `Monorepo detected (${strictModeDetection.monorepoType}). Using multi-tsconfig type checking.`
      );
    }
  }

  // Run intelligent hooks analysis (consolidated single analyzer)
  const hooksSpinner = createStageSpinner('Analyzing hooks & stability…', 'magenta');
  const rawAnalysis = await analyzeHooks(parsedFiles, {
    stableHooks: config.stableHooks,
    unstableHooks: config.unstableHooks,
    stableHookPatterns: config.stableHookPatterns,
    unstableHookPatterns: config.unstableHookPatterns,
    customFunctions: config.customFunctions,
    debug: options.debug,
    strictMode: strictModeDetection.enabled,
    tsconfigPath: strictModeDetection.tsconfigPath || config.tsconfigPath,
    projectRoot: targetPath,
    // Pass the pool for monorepos, or null for single-project mode
    typeCheckerPool,
  });

  // Filter results based on config
  const intelligentHooksAnalysis = rawAnalysis.filter((issue) => {
    // Filter by type
    if (!config.includePotentialIssues && issue.type === 'potential-issue') {
      return false;
    }

    // Filter by severity
    if (severityLevel(issue.severity) < severityLevel(config.minSeverity)) {
      return false;
    }

    // Filter by confidence
    if (confidenceLevel(issue.confidence) < confidenceLevel(config.minConfidence)) {
      return false;
    }

    return true;
  });
  hooksSpinner?.succeed(
    `Hooks analysis complete (${rawAnalysis.length} finding${rawAnalysis.length === 1 ? '' : 's'})`
  );

  const totalHooks = parsedFiles.reduce((sum, file) => sum + file.hooks.length, 0);
  const filteredCount = rawAnalysis.length - intelligentHooksAnalysis.length;
  const durationMs = Math.round(performance.now() - startTime);

  return {
    circularDependencies: circularDeps,
    crossFileCycles: allCrossFileCycles,
    intelligentHooksAnalysis: intelligentHooksAnalysis,
    strictModeDetection,
    summary: {
      filesAnalyzed: parsedFiles.length,
      hooksAnalyzed: totalHooks,
      circularDependencies: circularDeps.length,
      crossFileCycles: allCrossFileCycles.length,
      intelligentAnalysisCount: intelligentHooksAnalysis.length,
      filteredCount,
      durationMs,
    },
  };
}

/**
 * Parse files sequentially (used when caching is enabled or for small file counts)
 */
function parseFilesSequential(files: string[], astCache?: AstCache): ParsedFile[] {
  const parsedFiles: ParsedFile[] = [];
  const progressBar = createProgressBar(files.length);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const parsed = astCache ? parseFileWithCache(file, astCache) : parseFile(file);
      parsedFiles.push(parsed);
    } catch (error) {
      if (shouldLogToConsole() && !progressBar) {
        console.warn(`Warning: Could not parse ${file}:`, error);
      }
    }
    progressBar?.update(i + 1);
  }

  if (progressBar?.succeed) {
    progressBar.succeed();
  } else {
    progressBar?.stop();
  }

  // Save cache at the end if caching is enabled
  if (astCache) {
    astCache.save();
  }

  return parsedFiles;
}

/**
 * Parse files in parallel using worker threads (faster for large codebases)
 */
async function parseFilesParallel(files: string[], numWorkers?: number): Promise<ParsedFile[]> {
  const workerCount = numWorkers ?? Math.max(1, cpus().length - 1);

  // Create worker pool
  const piscina = new Piscina({
    filename: path.join(__dirname, 'parse-worker.js'),
    maxThreads: workerCount,
    idleTimeout: 5000,
  });

  const progressBar = createProgressBar(files.length);
  let completed = 0;

  // Submit all parsing tasks with progress tracking
  const tasks: Promise<{ result: ParseResult; index: number }>[] = files.map((filePath, index) =>
    piscina.run({ filePath } as ParseTask).then((result: ParseResult) => {
      completed++;
      progressBar?.update(completed);
      return { result, index };
    })
  );

  // Wait for all tasks to complete
  const taskResults = await Promise.all(tasks);
  if (progressBar?.succeed) {
    progressBar.succeed();
  } else {
    progressBar?.stop();
  }

  // Collect successful results (maintain order)
  const parsedFiles: ParsedFile[] = [];
  const errors: { file: string; error: string }[] = [];

  for (const { result, index } of taskResults) {
    if (result.success && result.data) {
      parsedFiles.push(result.data);
    } else {
      errors.push({ file: files[index], error: result.error || 'Unknown error' });
    }
  }

  // Show errors after progress bar is done (if any)
  if (shouldLogToConsole() && errors.length > 0 && errors.length <= 5) {
    for (const { file, error } of errors) {
      console.warn(`Warning: Could not parse ${file}: ${error}`);
    }
  } else if (shouldLogToConsole() && errors.length > 5) {
    console.warn(`Warning: Could not parse ${errors.length} files`);
  }

  // Destroy the worker pool
  await piscina.destroy();

  return parsedFiles;
}

function isLikelyReactFile(filePath: string): boolean {
  try {
    // Quick check of file size - skip very large files that are likely bundled/generated
    const stats = fs.statSync(filePath);
    if (stats.size > 1024 * 1024) {
      // Skip files larger than 1MB
      return false;
    }

    // Always include .tsx/.jsx files
    if (/\.(tsx|jsx)$/.test(filePath)) {
      return true;
    }

    // For .ts/.js files, check content
    const content = fs.readFileSync(filePath, 'utf-8');
    const firstKB = content.substring(0, 2048); // Check more content

    // Look for React-specific patterns
    const hasReactImport =
      /import.*from\s+['"]react['"]/.test(firstKB) ||
      /import.*React/.test(firstKB) ||
      /from\s+['"]react-native['"]/.test(firstKB);
    const hasHooks = /use[A-Z]/.test(firstKB);
    const hasJSX = /<[A-Z]/.test(firstKB);
    const hasReactFunction = /function.*Component|const.*=.*\(\).*=>/.test(firstKB);

    return hasReactImport || hasHooks || hasJSX || hasReactFunction;
  } catch {
    return true; // If we can't check, include it
  }
}

async function findFiles(targetPath: string, options: DetectorOptions): Promise<string[]> {
  const pattern = path.join(targetPath, options.pattern);

  // Build ignore function for glob v11+
  // Glob v11 uses a different ignore syntax - we need to use a function-based approach
  const ignorePatterns = options.ignore || [];

  const files = await glob(pattern, {
    ignore: {
      ignored: (p: Path) => {
        const fullPath = p.fullpath();
        // Use micromatch for robust glob pattern matching
        return micromatch.isMatch(fullPath, ignorePatterns);
      },
    },
    absolute: true,
  });

  // Filter out directories and files that are definitely not React files
  return files.filter((file) => {
    try {
      const stats = fs.statSync(file);
      return stats.isFile();
    } catch {
      return false;
    }
  });
}

function findCircularDependencies(parsedFiles: ParsedFile[]): CircularDependency[] {
  const circularDeps: CircularDependency[] = [];

  for (const file of parsedFiles) {
    for (const hook of file.hooks) {
      const cycles = detectCyclesInHook(hook, file.variables);

      for (const cycle of cycles) {
        circularDeps.push({
          file: file.file,
          line: hook.line,
          hookName: hook.name,
          cycle,
        });
      }
    }
  }

  return circularDeps;
}

function detectCyclesInHook(hook: HookInfo, variables: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const deps = hook.dependencies;

  // Only check for actual cycles where functions depend on each other
  // Skip simple variable name matches that don't represent actual dependencies
  for (const dep of deps) {
    const cycle = findRealCircularDependency(dep, variables, new Set(), [dep]);
    if (cycle.length > 2) {
      // Real cycle must have at least 3 elements
      cycles.push(cycle);
    }
  }

  return cycles;
}

function findRealCircularDependency(
  currentVar: string,
  variables: Map<string, Set<string>>,
  visited: Set<string>,
  path: string[]
): string[] {
  if (visited.has(currentVar)) {
    // Found a cycle - return the path from where the cycle starts
    const cycleStart = path.indexOf(currentVar);
    if (cycleStart !== -1) {
      return path.slice(cycleStart).concat([currentVar]);
    }
    return [];
  }

  const deps = variables.get(currentVar);
  if (!deps || deps.size === 0) {
    return [];
  }

  visited.add(currentVar);

  for (const dep of deps) {
    // Skip if this dependency looks like a primitive value or imported function
    if (isPrimitiveOrImported(dep)) {
      continue;
    }

    const cycle = findRealCircularDependency(dep, variables, visited, [...path, dep]);
    if (cycle.length > 0) {
      return cycle;
    }
  }

  visited.delete(currentVar);
  return [];
}

function isPrimitiveOrImported(varName: string): boolean {
  // Skip common React hooks, imported functions, and primitives
  const commonReactHooks = [
    'useState',
    'useEffect',
    'useCallback',
    'useMemo',
    'useRef',
    'useContext',
    'useReducer',
    'useLayoutEffect',
  ];
  const commonFirebaseFunctions = [
    'getDocs',
    'doc',
    'collection',
    'query',
    'orderBy',
    'limit',
    'where',
    'setDoc',
    'updateDoc',
    'deleteDoc',
  ];
  const commonUtilFunctions = [
    'console',
    'setTimeout',
    'clearTimeout',
    'Date',
    'Object',
    'Array',
    'JSON',
    'Math',
    'Number',
    'String',
    'Boolean',
  ];

  if (
    commonReactHooks.includes(varName) ||
    commonFirebaseFunctions.includes(varName) ||
    commonUtilFunctions.includes(varName)
  ) {
    return true;
  }

  // Skip only obvious primitives and constants, but be more conservative
  if (
    /^[A-Z_]{2,}$/.test(varName) || // CONSTANTS (at least 2 chars)
    varName.includes('.') || // property access like obj.prop
    /^(true|false|null|undefined)$/.test(varName) || // literal primitives
    /^\d+$/.test(varName)
  ) {
    // pure numbers
    return true;
  }

  // Only skip built-in React hooks, not custom hooks
  if (varName.startsWith('use') && commonReactHooks.includes(varName)) {
    return true;
  }

  return false;
}

/**
 * Find files that import any of the changed files.
 * Uses a lightweight regex-based approach to avoid full parsing overhead.
 * Reads files in parallel for better performance on large codebases.
 */
async function findFilesImportingChangedFiles(
  allFiles: string[],
  changedFiles: Set<string>,
  projectRoot: string
): Promise<string[]> {
  const pathResolver = createPathResolver({ projectRoot });

  // Regex pattern to match import, require, and dynamic import() statements
  // Group 1: static import path, Group 2: require path, Group 3: dynamic import path
  const importRequirePattern =
    /(?:import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"])|(?:require\s*\(\s*['"]([^'"]+)['"]\s*\))|(?:import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

  const filesToCheck = allFiles.filter((file) => !changedFiles.has(file));

  const checkFilePromises = filesToCheck.map(async (file) => {
    try {
      const content = await fs.promises.readFile(file, 'utf-8');

      // Create a new regex instance for each file (required for /g flag with exec)
      const regex = new RegExp(importRequirePattern.source, importRequirePattern.flags);
      let match;
      while ((match = regex.exec(content)) !== null) {
        // match[1] is for static imports, match[2] is for requires, match[3] is for dynamic imports
        const importPath = match[1] || match[2] || match[3];
        if (importPath) {
          // Try to resolve the import - pathResolver handles aliases and returns null for external packages
          const resolved = pathResolver.resolve(file, importPath);
          if (resolved && changedFiles.has(resolved)) {
            return file;
          }
        }
      }
    } catch (error) {
      // Skip files that can't be read, but warn the user
      console.warn(`Warning: Could not read file to check for dependents: ${file}`, error);
    }
    return null;
  });

  const results = await Promise.all(checkFilePromises);
  return results.filter((file): file is string => file !== null);
}
