#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import chalk from 'chalk';
import chokidar from 'chokidar';
import gradient from 'gradient-string';
import figlet from 'figlet';
import { codeFrameColumns } from '@babel/code-frame';
import stripAnsi from 'strip-ansi';
import { detectCircularDependencies, DetectionResults, CircularDependency } from './detector';
import { CrossFileCycle } from './module-graph';
import { HookAnalysis } from './orchestrator';

// Read version from package.json
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const VERSION: string = packageJson.version;

// Custom gradients for different states
const successGradient = gradient(['#00ff88', '#00d4ff']);
const errorGradient = gradient(['#ff6b6b', '#ff8e53']);
const infoGradient = gradient(['#667eea', '#764ba2']);
const warningGradient = gradient(['#facc15', '#fb923c']);

type GradientFn = ((text: string) => string) & {
  multiline?: (text: string) => string;
};

function applyGradientSafe(grad: GradientFn, text: string, multiline = false): string {
  if (chalk.level === 0) return text;
  if (multiline && typeof grad.multiline === 'function') {
    return grad.multiline(text);
  }
  return grad(text);
}

function getTerminalWidth(maxWidth: number): number {
  const columns = process.stdout.columns ?? maxWidth;
  return Math.max(40, Math.min(maxWidth, columns - 2));
}

function centerPlain(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  const right = width - text.length - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function centerAnsi(text: string, width: number): string {
  const len = visibleLength(text);
  if (len >= width) {
    // Truncate safely by dropping ANSI when too long
    return stripAnsi(text).slice(0, width);
  }
  const left = Math.floor((width - len) / 2);
  const right = width - len - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

function printBanner(): void {
  if (!process.stdout.isTTY || chalk.level === 0) return;

  try {
    const title = figlet.textSync('rld', { font: 'Slant' });
    console.log(applyGradientSafe(infoGradient, title, true));
  } catch {
    console.log(applyGradientSafe(infoGradient, 'rld'));
  }

  console.log(chalk.white('React loop detector'));
  const rule = '─'.repeat(Math.min(process.stdout.columns ?? 60, 60));
  console.log(chalk.gray(rule));
  console.log(
    chalk.gray(
      'Static analysis for React Hooks: Detects infinite loops, circular imports, and unstable dependencies.\n'
    )
  );
}

interface CliOptions {
  pattern: string;
  ignore: string[];
  json?: boolean;
  sarif?: boolean;
  color?: boolean;
  compact?: boolean;
  debug?: boolean;
  parallel?: boolean;
  workers?: number;
  minSeverity?: 'high' | 'medium' | 'low';
  minConfidence?: 'high' | 'medium' | 'low';
  confirmedOnly?: boolean;
  cache?: boolean;
  strict?: boolean;
  tsconfigPath?: string;
  presets?: boolean; // Commander turns --no-presets into presets: false
  since?: string; // Git ref to compare against (e.g., 'main', 'HEAD~5')
  includeDependents?: boolean; // Include files that import changed files
  quiet?: boolean; // Suppress output unless there are issues
}

// SARIF output types
interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: {
        startLine: number;
        startColumn?: number;
      };
    };
  }>;
}

interface SarifReport {
  version: string;
  $schema: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version: string;
        informationUri: string;
        rules: Array<{
          id: string;
          name: string;
          shortDescription: { text: string };
          helpUri?: string;
          properties?: { category: string };
        }>;
      };
    };
    results: SarifResult[];
  }>;
}

function generateSarifReport(results: DetectionResults): SarifReport {
  const sarifResults: SarifResult[] = [];

  // Add circular dependencies
  results.circularDependencies.forEach((dep) => {
    sarifResults.push({
      ruleId: 'IMPORT-CYCLE',
      level: 'error',
      message: { text: `Import cycle detected: ${dep.cycle.join(' → ')}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: dep.file },
            region: { startLine: dep.line },
          },
        },
      ],
    });
  });

  // Add cross-file cycles
  results.crossFileCycles.forEach((cycle) => {
    sarifResults.push({
      ruleId: 'CROSS-FILE-CYCLE',
      level: 'error',
      message: {
        text: `Cross-file import cycle: ${cycle.files.map((f) => path.basename(f)).join(' → ')}`,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: cycle.files[0] },
            region: { startLine: 1 },
          },
        },
      ],
    });
  });

  // Add hooks issues
  results.intelligentHooksAnalysis.forEach((issue) => {
    const level =
      issue.category === 'critical' ? 'error' : issue.category === 'warning' ? 'warning' : 'note';
    // Include suggestion in message if available
    const messageText = issue.suggestion
      ? `${issue.explanation}\n\nFix: ${issue.suggestion}`
      : issue.explanation;
    sarifResults.push({
      ruleId: issue.errorCode,
      level,
      message: { text: messageText },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: issue.file },
            region: {
              startLine: issue.line,
              startColumn: issue.column,
            },
          },
        },
      ],
    });
  });

  // Define rules
  const rules = [
    {
      id: 'IMPORT-CYCLE',
      name: 'Import Cycle',
      shortDescription: { text: 'Circular import dependency detected' },
      properties: { category: 'critical' },
    },
    {
      id: 'CROSS-FILE-CYCLE',
      name: 'Cross-File Cycle',
      shortDescription: { text: 'Cross-file import cycle detected' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-100',
      name: 'Render Phase setState',
      shortDescription: { text: 'setState called during render' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-101',
      name: 'Render Phase setState (indirect)',
      shortDescription: { text: 'setState called during render via function call' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-200',
      name: 'Effect Loop',
      shortDescription: { text: 'useEffect unconditional setState loop' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-201',
      name: 'Missing Deps Loop',
      shortDescription: { text: 'useEffect missing deps with setState' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-202',
      name: 'Layout Effect Loop',
      shortDescription: { text: 'useLayoutEffect unconditional setState loop' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-300',
      name: 'Cross-File Loop',
      shortDescription: { text: 'Cross-file loop risk' },
      properties: { category: 'warning' },
    },
    {
      id: 'RLD-301',
      name: 'Cross-File Conditional',
      shortDescription: { text: 'Cross-file conditional modification' },
      properties: { category: 'warning' },
    },
    {
      id: 'RLD-400',
      name: 'Unstable Object',
      shortDescription: { text: 'Unstable object reference in deps' },
      properties: { category: 'performance' },
    },
    {
      id: 'RLD-401',
      name: 'Unstable Array',
      shortDescription: { text: 'Unstable array reference in deps' },
      properties: { category: 'performance' },
    },
    {
      id: 'RLD-402',
      name: 'Unstable Function',
      shortDescription: { text: 'Unstable function reference in deps' },
      properties: { category: 'performance' },
    },
    {
      id: 'RLD-403',
      name: 'Unstable Call Result',
      shortDescription: { text: 'Unstable function call result in deps' },
      properties: { category: 'performance' },
    },
    {
      id: 'RLD-404',
      name: 'Unstable Context Value',
      shortDescription: { text: 'Unstable context provider value' },
      properties: { category: 'performance' },
    },
    {
      id: 'RLD-405',
      name: 'Unstable JSX Prop',
      shortDescription: { text: 'Unstable JSX prop' },
      properties: { category: 'performance' },
    },
    {
      id: 'RLD-406',
      name: 'Unstable Callback Dep',
      shortDescription: { text: 'Unstable callback in useCallback deps' },
      properties: { category: 'performance' },
    },
    {
      id: 'RLD-407',
      name: 'useSyncExternalStore Unstable Snapshot',
      shortDescription: { text: 'Unstable getSnapshot in useSyncExternalStore' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-410',
      name: 'Object Spread Risk',
      shortDescription: { text: 'Object spread guard risk' },
      properties: { category: 'warning' },
    },
    {
      id: 'RLD-420',
      name: 'Callback Modifies Dep',
      shortDescription: { text: 'useCallback/useMemo modifies dependency' },
      properties: { category: 'warning' },
    },
    {
      id: 'RLD-500',
      name: 'Missing Deps Array',
      shortDescription: { text: 'useEffect missing dependency array' },
      properties: { category: 'critical' },
    },
    {
      id: 'RLD-501',
      name: 'Conditional Modification',
      shortDescription: { text: 'Conditional modification needs review' },
      properties: { category: 'warning' },
    },
    {
      id: 'RLD-600',
      name: 'Ref Mutation Risk',
      shortDescription: { text: 'Render-phase ref mutation with state value' },
      properties: { category: 'warning' },
    },
  ];

  return {
    version: '2.1.0',
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'react-loop-detector',
            version: VERSION,
            informationUri: 'https://github.com/samsmithyeah/react-loop-detector',
            rules,
          },
        },
        results: sarifResults,
      },
    ],
  };
}

// Cache for file contents to avoid re-reading
const fileContentCache = new Map<string, string>();

function getFileContent(filePath: string): string | null {
  if (fileContentCache.has(filePath)) {
    return fileContentCache.get(filePath)!;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    fileContentCache.set(filePath, content);
    return content;
  } catch {
    return null;
  }
}

function generateCodeFrame(filePath: string, line: number, column?: number): string | null {
  const content = getFileContent(filePath);
  if (!content) return null;

  try {
    const location = {
      start: { line, column: column ?? 0 },
    };
    return codeFrameColumns(content, location, {
      highlightCode: chalk.level > 0,
      linesAbove: 2,
      linesBelow: 2,
    });
  } catch {
    return null;
  }
}

const program = new Command();

program
  .name('react-loop-detector')
  .description(
    'Static analysis for React Hooks: Detects infinite loops, circular imports, and unstable dependencies.'
  )
  .version(VERSION)
  .argument('<path>', 'Path to React project or file to analyze')
  .option('-p, --pattern <pattern>', 'Glob pattern for files to analyze', '**/*.{js,jsx,ts,tsx}')
  .option('-i, --ignore <patterns...>', 'Patterns to ignore', [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.expo/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.cache/**',
  ])
  .option('--json', 'Output results as JSON')
  .option('--sarif', 'Output results in SARIF format (for GitHub Code Scanning)')
  .option('--no-color', 'Disable colored output')
  .option('--compact', 'Compact output format (one line per issue)')
  .option('--debug', 'Show internal decision logic for debugging false positives')
  .option('--parallel', 'Use parallel parsing with worker threads (faster for large projects)')
  .option('--workers <count>', 'Number of worker threads (default: CPU cores - 1)', parseInt)
  .option('--min-severity <level>', 'Minimum severity to report (high, medium, low)', 'low')
  .option(
    '--min-confidence <level>',
    'Minimum confidence to report (high, medium, low). Default: medium (hides uncertain detections)',
    'medium'
  )
  .option('--confirmed-only', 'Only report confirmed infinite loops (not potential issues)')
  .option('--cache', 'Enable caching for faster repeated runs')
  .option('--strict', 'Enable TypeScript strict mode (auto-enabled when tsconfig.json found)')
  .option('--no-strict', 'Disable strict mode (use heuristics only)')
  .option('--tsconfig <path>', 'Path to tsconfig.json (for strict mode)')
  .option('--no-presets', 'Disable auto-detection of library presets from package.json')
  .option(
    '--since <ref>',
    'Only analyze files changed since git ref (e.g., main, HEAD~5, abc123). Essential for CI in large repos.'
  )
  .option(
    '--include-dependents',
    'When using --since, also analyze files that import changed files (finds indirect issues)'
  )
  .option('--quiet', 'Suppress output when no issues are found (useful for CI)')
  .action(async (targetPath: string, options: CliOptions) => {
    try {
      // Disable colors if --no-color flag is used
      if (options.color === false) {
        chalk.level = 0;
        process.env.FORCE_COLOR = '0';
        process.env.NO_COLOR = '1';
      }

      const absolutePath = path.resolve(targetPath);

      if (!fs.existsSync(absolutePath)) {
        console.error(chalk.red(`Error: Path "${absolutePath}" does not exist`));
        process.exit(1);
      }

      const shouldLog = !options.json && !options.sarif && !options.quiet;
      if (shouldLog) {
        const isTTY = process.stdout.isTTY;
        if (isTTY) {
          printBanner();
          console.log(infoGradient('Target'));
          console.log(chalk.whiteBright(`  ${absolutePath}`));
          console.log(chalk.gray(`  Pattern: ${options.pattern}`));
          if (options.cache) {
            console.log(chalk.gray('  Cache: enabled'));
          }
          if (options.parallel) {
            console.log(chalk.gray(`  Parallel parsing: ${options.workers || 'auto'} workers`));
          }
          if (options.since) {
            console.log(
              chalk.yellow(
                `  Changed files mode: since '${options.since}'${options.includeDependents ? ' (+ dependents)' : ''}`
              )
            );
          }
          console.log();
        } else {
          // Preserve clean, stable output for non-TTY/CI
          console.log(chalk.blue(`Analyzing React hooks in: ${absolutePath}`));
          console.log(chalk.gray(`Pattern: ${options.pattern}`));
          if (options.since) {
            console.log(
              chalk.yellow(
                `Changed files mode: Only analyzing files changed since '${options.since}'`
              )
            );
            if (options.includeDependents) {
              console.log(chalk.gray(`  Including files that import changed files`));
            }
          }
        }
      }

      const results = await detectCircularDependencies(absolutePath, {
        pattern: options.pattern,
        ignore: options.ignore,
        cache: options.cache,
        debug: options.debug,
        parallel: options.parallel,
        workers: options.workers,
        strict: options.strict,
        tsconfigPath: options.tsconfigPath,
        since: options.since,
        includeDependents: options.includeDependents,
        config: {
          minSeverity: options.minSeverity,
          minConfidence: options.minConfidence,
          includePotentialIssues: !options.confirmedOnly,
          tsconfigPath: options.tsconfigPath,
          noPresets: options.presets === false, // --no-presets becomes presets: false
        },
      });

      // Show strict mode status (only for non-JSON/SARIF/quiet output)
      if (shouldLog) {
        const { strictModeDetection } = results;
        if (strictModeDetection.enabled) {
          if (strictModeDetection.reason === 'auto-detected') {
            console.log(
              chalk.cyan(`Strict mode enabled: TypeScript project detected (tsconfig.json found)`)
            );
            console.log(chalk.gray(`  Use --no-strict to disable type-based analysis`));
          } else {
            console.log(
              chalk.yellow(`Strict mode enabled: Using TypeScript compiler for type-based analysis`)
            );
          }
        } else if (strictModeDetection.reason === 'disabled') {
          console.log(chalk.gray('Strict mode disabled by flag or configuration.'));
        }
        // Note: 'no-tsconfig' case is silent - no message needed for the common JS-only case
      }

      // Determine if there are any issues (for quiet mode)
      const criticalIssues = results.circularDependencies.length + results.crossFileCycles.length;
      const confirmedLoops = results.intelligentHooksAnalysis.filter(
        (issue) => issue.type === 'confirmed-infinite-loop'
      ).length;
      const hasIssues =
        criticalIssues > 0 || confirmedLoops > 0 || results.intelligentHooksAnalysis.length > 0;

      if (options.json) {
        // Enhanced JSON output with metadata
        const jsonOutput = {
          meta: {
            version: VERSION,
            durationMs: results.summary.durationMs,
            timestamp: new Date().toISOString(),
          },
          ...results,
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
      } else if (options.sarif) {
        const sarifReport = generateSarifReport(results);
        console.log(JSON.stringify(sarifReport, null, 2));
      } else if (!options.quiet || hasIssues) {
        // Show output if not quiet mode, OR if there are issues to report
        formatResults(results, options.compact, options.debug);
      }

      // Exit with error for critical issues
      if (criticalIssues > 0 || confirmedLoops > 0) {
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

function displayCompactIssue(issue: HookAnalysis) {
  const relPath = path.relative(process.cwd(), issue.file);
  const col = issue.column ?? 0;
  const level =
    issue.category === 'critical' ? 'error' : issue.category === 'warning' ? 'warning' : 'info';

  // Format: file:line:col - level CODE: description
  const color =
    issue.category === 'critical'
      ? chalk.red
      : issue.category === 'warning'
        ? chalk.yellow
        : chalk.cyan;
  console.log(
    color(
      `${relPath}:${issue.line}:${col} - ${level} ${issue.errorCode}: ${issue.explanation.split('.')[0]}`
    )
  );
}

function displayDebugInfo(issue: HookAnalysis) {
  if (!issue.debugInfo) return;

  const debug = issue.debugInfo;
  console.log(chalk.magenta(`    🔧 Debug Info:`));
  console.log(chalk.magenta(`       Reason: ${debug.reason}`));

  if (debug.stateTracking) {
    const st = debug.stateTracking;
    if (st.declaredStateVars.length > 0) {
      console.log(chalk.gray(`       State variables: ${st.declaredStateVars.join(', ')}`));
    }
    if (st.setterFunctions.length > 0) {
      console.log(chalk.gray(`       Setter functions: ${st.setterFunctions.join(', ')}`));
    }
    if (st.unstableVariables.length > 0) {
      console.log(chalk.gray(`       Unstable variables: ${st.unstableVariables.join(', ')}`));
    }
  }

  if (debug.dependencyAnalysis) {
    const da = debug.dependencyAnalysis;
    console.log(chalk.gray(`       Dependencies analyzed: [${da.rawDependencies.join(', ')}]`));
    if (da.problematicDeps.length > 0) {
      console.log(chalk.gray(`       Problematic: [${da.problematicDeps.join(', ')}]`));
    }
    if (da.safeDeps.length > 0) {
      console.log(chalk.gray(`       Safe: [${da.safeDeps.join(', ')}]`));
    }
  }

  if (debug.guardInfo) {
    const gi = debug.guardInfo;
    console.log(
      chalk.gray(
        `       Guard detected: ${gi.hasGuard ? 'yes' : 'no'}${gi.guardType ? ` (${gi.guardType})` : ''}`
      )
    );
  }

  if (debug.deferredInfo) {
    const di = debug.deferredInfo;
    if (di.isDeferred) {
      console.log(
        chalk.gray(`       Deferred: yes${di.deferredContext ? ` (${di.deferredContext})` : ''}`)
      );
    }
  }

  console.log();
}

function displayIssue(issue: HookAnalysis, showDebug?: boolean) {
  // Show location
  console.log(chalk.blue(`    📍 Location:`));
  console.log(chalk.gray(`       ${path.relative(process.cwd(), issue.file)}:${issue.line}`));
  console.log(
    chalk.gray(`       ${issue.hookType}${issue.functionName ? ` in ${issue.functionName}()` : ''}`)
  );
  console.log();

  // Show code frame
  const codeFrame = generateCodeFrame(issue.file, issue.line, issue.column);
  if (codeFrame) {
    console.log(chalk.blue(`    📝 Code:`));
    // Indent each line of the code frame
    const indentedFrame = codeFrame
      .split('\n')
      .map((line) => `       ${line}`)
      .join('\n');
    console.log(indentedFrame);
    console.log();
  }

  // Show the problem in simple terms
  console.log(chalk.blue(`    ❌ Problem:`));

  // Use the explanation field if available - it contains the most accurate description
  if (issue.explanation) {
    // Split long explanations into multiple lines for readability
    // Use lookbehind to split on whitespace following a period (preserves periods in names/versions)
    const lines = issue.explanation.split(/(?<=\.)\s+/).filter((l) => l.trim());
    for (const line of lines) {
      const trimmedLine = line.trim();
      console.log(chalk.gray(`       ${trimmedLine}${trimmedLine.endsWith('.') ? '' : '.'}`));
    }
  } else if (issue.type === 'confirmed-infinite-loop' && issue.setterFunction) {
    console.log(
      chalk.gray(
        `       This hook depends on '${issue.problematicDependency}' and modifies it, creating an infinite loop:`
      )
    );
    console.log(
      chalk.gray(
        `       ${issue.problematicDependency} changes → hook runs → calls ${issue.setterFunction}() → ${issue.problematicDependency} changes → repeats forever`
      )
    );
  } else if (issue.type === 'potential-issue') {
    console.log(
      chalk.gray(
        `       This hook depends on '${issue.problematicDependency}' and conditionally modifies it.`
      )
    );
    console.log(
      chalk.gray(`       If the condition doesn't prevent updates, this creates an infinite loop.`)
    );
  } else {
    console.log(
      chalk.gray(
        `       Issue with dependency '${issue.problematicDependency}' in ${issue.hookType}.`
      )
    );
  }
  console.log();

  // Show actionable suggestion if available
  if (issue.suggestion) {
    console.log(chalk.blue(`    💡 How to fix:`));
    console.log(chalk.green(`       ${issue.suggestion}`));
    console.log();
  }

  // Show what the code is doing (only if it adds clarity)
  if (issue.actualStateModifications.length > 1 || issue.stateReads.length > 1) {
    console.log(chalk.blue(`    🔍 Details:`));
    if (issue.stateReads.length > 1) {
      console.log(chalk.gray(`       Reads: ${issue.stateReads.join(', ')}`));
    }
    if (issue.actualStateModifications.length > 1) {
      console.log(chalk.gray(`       Modifies: ${issue.actualStateModifications.join(', ')}`));
    }
    console.log();
  }

  // Show debug info if enabled
  if (showDebug && issue.debugInfo) {
    displayDebugInfo(issue);
  }

  console.log();
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Create a visually appealing success message
 */
function createSuccessBox(files: number, hooks: number, duration: string): string {
  const isTTY = process.stdout.isTTY;

  if (!isTTY) {
    return `✓ All clear! No issues found\n  ${files} files • ${hooks} hooks • ${duration}`;
  }

  const innerWidth = getTerminalWidth(68);
  const border = chalk.greenBright;

  const top = border(`╭${'─'.repeat(innerWidth)}╮`);
  const bottom = border(`╰${'─'.repeat(innerWidth)}╯`);
  const empty = border(`│${' '.repeat(innerWidth)}│`);

  const headerPlain = '✓ All clear! No issues found';
  const statsPlain = `${files} files • ${hooks} hooks • ${duration}`;

  const headerCentered = centerPlain(headerPlain, innerWidth);
  const statsCentered = centerPlain(statsPlain, innerWidth);

  const header = applyGradientSafe(successGradient, headerCentered);
  const stats = chalk.gray(statsCentered);

  const headerLine = border('│') + header + border('│');
  const statsLine = border('│') + stats + border('│');

  return [top, empty, headerLine, statsLine, empty, bottom].join('\n');
}

/**
 * Create a visually appealing error summary
 */
function createErrorSummary(
  criticalCount: number,
  warningCount: number,
  perfCount: number,
  files: number,
  hooks: number,
  duration: string
): string {
  const isTTY = process.stdout.isTTY;

  const total = criticalCount + warningCount + perfCount;
  const parts: string[] = [];

  if (criticalCount > 0) {
    parts.push(chalk.red.bold(`${criticalCount} critical`));
  }
  if (warningCount > 0) {
    parts.push(chalk.yellow(`${warningCount} warning${warningCount > 1 ? 's' : ''}`));
  }
  if (perfCount > 0) {
    parts.push(chalk.cyan(`${perfCount} perf`));
  }

  if (!isTTY) {
    const symbol = criticalCount > 0 ? '✗' : '!';
    return `${symbol} ${total} issue(s) found\n  ${parts.join(' • ')}\n  ${files} files • ${hooks} hooks • ${duration}`;
  }

  const innerWidth = getTerminalWidth(74);
  const borderColor = criticalCount > 0 ? chalk.redBright : chalk.yellowBright;

  const top = borderColor(`╭${'─'.repeat(innerWidth)}╮`);
  const bottom = borderColor(`╰${'─'.repeat(innerWidth)}╯`);
  const empty = borderColor(`│${' '.repeat(innerWidth)}│`);

  const titlePlain =
    criticalCount > 0
      ? `✗ ${total} issue${total > 1 ? 's' : ''} found`
      : `! ${total} issue${total > 1 ? 's' : ''} found`;

  const statsPlain = `${files} files • ${hooks} hooks • ${duration}`;

  const titleCentered = centerPlain(titlePlain, innerWidth);
  const statsCentered = centerPlain(statsPlain, innerWidth);

  const title =
    criticalCount > 0
      ? applyGradientSafe(errorGradient, titleCentered)
      : applyGradientSafe(warningGradient, titleCentered);

  const partsColored = parts.join(chalk.gray(' • '));
  const partsCenteredAnsi = centerAnsi(partsColored, innerWidth);
  const partsLine = partsCenteredAnsi;
  const statsLine = chalk.gray(statsCentered);

  const titleLine = borderColor('│') + title + borderColor('│');
  const partsLineBox = borderColor('│') + partsLine + borderColor('│');
  const statsLineBox = borderColor('│') + statsLine + borderColor('│');

  return [top, empty, titleLine, partsLineBox, statsLineBox, empty, bottom].join('\n');
}

function formatResults(results: DetectionResults, compact?: boolean, debug?: boolean) {
  const { circularDependencies, crossFileCycles, intelligentHooksAnalysis, summary } = results;

  // Separate by severity type (exclude safe-pattern from counts)
  const confirmedIssues = intelligentHooksAnalysis.filter(
    (issue) => issue.type === 'confirmed-infinite-loop'
  );
  const potentialIssues = intelligentHooksAnalysis.filter(
    (issue) => issue.type === 'potential-issue'
  );
  const warningIssues = potentialIssues.filter((issue) => issue.category === 'warning');
  const performanceIssues = potentialIssues.filter((issue) => issue.category === 'performance');

  // Only count actual issues, not safe-pattern entries
  const hooksIssueCount = confirmedIssues.length + potentialIssues.length;
  const importCyclesCount = circularDependencies.length + crossFileCycles.length;
  const totalIssues = importCyclesCount + hooksIssueCount;
  const hasIssues = totalIssues > 0;

  // COMPACT MODE: Show Unix-style one-line-per-issue output
  if (compact) {
    // Import cycles
    circularDependencies.forEach((dep: CircularDependency) => {
      const relPath = path.relative(process.cwd(), dep.file);
      console.log(
        chalk.red(`${relPath}:${dep.line}:0 - error IMPORT-CYCLE: ${dep.cycle.join(' → ')}`)
      );
    });

    // Cross-file cycles
    crossFileCycles.forEach((cycle: CrossFileCycle) => {
      const relPath = path.relative(process.cwd(), cycle.files[0]);
      console.log(
        chalk.red(
          `${relPath}:1:0 - error CROSS-FILE-CYCLE: ${cycle.files.map((f) => path.basename(f)).join(' → ')}`
        )
      );
    });

    // Hooks issues (skip safe-pattern)
    intelligentHooksAnalysis
      .filter((issue) => issue.type !== 'safe-pattern')
      .forEach((issue) => {
        displayCompactIssue(issue);
      });

    // Brief summary with timing
    if (totalIssues > 0) {
      console.log(
        chalk.gray(`\n${totalIssues} issue(s) found in ${formatDuration(summary.durationMs)}`)
      );
    } else {
      console.log(chalk.green(`\n✓ No issues found in ${formatDuration(summary.durationMs)}`));
    }
    return;
  }

  // VERBOSE MODE (default): Summary-first format
  console.log();

  const duration = formatDuration(summary.durationMs);
  const criticalCount = confirmedIssues.length + importCyclesCount;

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY HEADER (shown first - the verdict)
  // ═══════════════════════════════════════════════════════════════
  if (!hasIssues) {
    // 🎉 Success celebration with visual box
    console.log(createSuccessBox(summary.filesAnalyzed, summary.hooksAnalyzed, duration));

    // Show filtered count if any were hidden
    if (summary.filteredCount > 0) {
      console.log(chalk.gray(`  ${summary.filteredCount} low-priority issue(s) hidden by filters`));
    }

    console.log();
    return;
  }

  // There are issues - show error summary box
  console.log(
    createErrorSummary(
      criticalCount,
      warningIssues.length,
      performanceIssues.length,
      summary.filesAnalyzed,
      summary.hooksAnalyzed,
      duration
    )
  );

  // Show filtered count if any were hidden
  if (summary.filteredCount > 0) {
    console.log(
      chalk.gray(
        `  ${summary.filteredCount} additional issue(s) hidden by severity/confidence filters`
      )
    );
  }

  console.log();

  // ═══════════════════════════════════════════════════════════════
  // DETAILED ISSUES (shown after summary)
  // ═══════════════════════════════════════════════════════════════

  const isTTY = process.stdout.isTTY;

  // Show import/file-level circular dependencies
  if (circularDependencies.length > 0) {
    const headerText = `━━━ Import Cycles (${circularDependencies.length}) ━━━`;
    const header = isTTY
      ? chalk.red.bold(applyGradientSafe(errorGradient, headerText))
      : 'Import circular dependencies:';
    console.log(header + '\n');

    circularDependencies.forEach((dep: CircularDependency, index: number) => {
      console.log(
        chalk.yellow(`${index + 1}. ${path.relative(process.cwd(), dep.file)}:${dep.line}`)
      );
      console.log(chalk.gray(`   Hook: ${dep.hookName}`));
      console.log(chalk.gray(`   Cycle: ${dep.cycle.join(' → ')}`));
      console.log();
    });
  }

  // Show cross-file cycles
  if (crossFileCycles.length > 0) {
    const headerText = `━━━ Cross-File Cycles (${crossFileCycles.length}) ━━━`;
    const header = isTTY
      ? chalk.red.bold(applyGradientSafe(errorGradient, headerText))
      : 'Cross-file import cycles:';
    console.log(header + '\n');

    crossFileCycles.forEach((cycle: CrossFileCycle, index: number) => {
      console.log(chalk.yellow(`${index + 1}. Import cycle between files:`));

      const relativeFiles = cycle.files.map((file: string) => path.relative(process.cwd(), file));
      console.log(chalk.gray(`   ${relativeFiles.join(' → ')}`));

      if (cycle.dependencies.length > 0) {
        console.log(
          chalk.cyan(
            `   Fix: Remove one of these imports or refactor shared code into a separate file`
          )
        );
      }
      console.log();
    });
  }

  // Show confirmed infinite loops (critical issues)
  if (confirmedIssues.length > 0) {
    const headerText = `━━━ 🔥 Infinite Loops (${confirmedIssues.length}) ━━━`;
    const header = isTTY
      ? chalk.red.bold(applyGradientSafe(errorGradient, headerText))
      : 'Confirmed infinite loops:';
    console.log(header + '\n');

    confirmedIssues.forEach((issue, index: number) => {
      const fileRef = `${path.relative(process.cwd(), issue.file)}:${issue.line}`;
      console.log(
        chalk.redBright(`${index + 1}. `) +
          chalk.red(`[${issue.errorCode}]`) +
          chalk.white(` ${fileRef}`)
      );
      console.log();
      displayIssue(issue, debug);
    });
  }

  // Show warning issues
  if (warningIssues.length > 0) {
    const headerText = `━━━ ⚠️  Warnings (${warningIssues.length}) ━━━`;
    const header = isTTY
      ? chalk.yellow.bold(applyGradientSafe(warningGradient, headerText))
      : 'Warnings to review:';
    console.log(header + '\n');

    warningIssues.forEach((issue, index: number) => {
      const fileRef = `${path.relative(process.cwd(), issue.file)}:${issue.line}`;
      console.log(
        chalk.yellow(`${index + 1}. `) +
          chalk.yellow(`[${issue.errorCode}]`) +
          chalk.white(` ${fileRef}`)
      );
      console.log(chalk.gray(`   ${issue.description}`));
      console.log();
      displayIssue(issue, debug);
    });
  }

  // Show performance issues
  if (performanceIssues.length > 0) {
    const headerText = `━━━ ⚡ Performance (${performanceIssues.length}) ━━━`;
    const header = isTTY
      ? chalk.cyan.bold(applyGradientSafe(infoGradient, headerText))
      : 'Performance issues:';
    console.log(header + '\n');

    performanceIssues.forEach((issue, index: number) => {
      const fileRef = `${path.relative(process.cwd(), issue.file)}:${issue.line}`;
      console.log(
        chalk.cyan(`${index + 1}. `) +
          chalk.cyan(`[${issue.errorCode}]`) +
          chalk.white(` ${fileRef}`)
      );
      console.log(chalk.gray(`   ${issue.description}`));
      console.log();
      displayIssue(issue, debug);
    });
  }
}

// Watch command for continuous monitoring
program
  .command('watch <path>')
  .description('Watch for file changes and re-analyze automatically')
  .option('-p, --pattern <pattern>', 'Glob pattern for files to analyze', '**/*.{js,jsx,ts,tsx}')
  .option('-i, --ignore <patterns...>', 'Patterns to ignore', [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
  ])
  .option('--min-severity <level>', 'Minimum severity to report (high, medium, low)', 'low')
  .option(
    '--min-confidence <level>',
    'Minimum confidence to report (high, medium, low). Default: medium (hides uncertain detections)',
    'medium'
  )
  .option('--confirmed-only', 'Only report confirmed infinite loops')
  .option('--compact', 'Compact output format')
  .action(async (targetPath: string, watchOptions: Partial<CliOptions>) => {
    const absolutePath = path.resolve(targetPath);

    if (!fs.existsSync(absolutePath)) {
      console.error(chalk.red(`Error: Path "${absolutePath}" does not exist`));
      process.exit(1);
    }

    console.log(chalk.blue(`\n👀 Watching for changes in: ${absolutePath}`));
    console.log(chalk.gray(`Pattern: ${watchOptions.pattern}`));
    console.log(chalk.gray('Press Ctrl+C to stop\n'));

    // Run initial analysis
    let isAnalyzing = false;
    let pendingAnalysis = false;

    const runAnalysis = async () => {
      if (isAnalyzing) {
        pendingAnalysis = true;
        return;
      }

      isAnalyzing = true;
      console.log(chalk.gray(`\n[${new Date().toLocaleTimeString()}] Analyzing...`));

      try {
        const results = await detectCircularDependencies(absolutePath, {
          pattern: watchOptions.pattern || '**/*.{js,jsx,ts,tsx}',
          ignore: watchOptions.ignore || [],
          config: {
            minSeverity: watchOptions.minSeverity as 'high' | 'medium' | 'low',
            minConfidence: watchOptions.minConfidence as 'high' | 'medium' | 'low',
            includePotentialIssues: !watchOptions.confirmedOnly,
          },
        });

        // Clear terminal for fresh output
        console.clear();
        console.log(chalk.blue(`👀 Watching: ${absolutePath}`));
        console.log(chalk.gray(`[${new Date().toLocaleTimeString()}] Last analysis\n`));

        formatResults(results, watchOptions.compact);
      } catch (error) {
        console.error(chalk.red('Error during analysis:'), error);
      }

      isAnalyzing = false;

      if (pendingAnalysis) {
        pendingAnalysis = false;
        runAnalysis();
      }
    };

    // Run initial analysis
    await runAnalysis();

    // Watch for changes
    const watcher = chokidar.watch(
      path.join(absolutePath, watchOptions.pattern || '**/*.{js,jsx,ts,tsx}'),
      {
        ignored: watchOptions.ignore || ['**/node_modules/**', '**/.git/**'],
        persistent: true,
        ignoreInitial: true,
      }
    );

    // Debounce file changes
    let debounceTimer: NodeJS.Timeout | null = null;

    watcher.on('change', (changedPath) => {
      console.log(chalk.yellow(`\n📝 Changed: ${path.relative(absolutePath, changedPath)}`));

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        runAnalysis();
      }, 300);
    });

    watcher.on('add', (addedPath) => {
      console.log(chalk.green(`\n➕ Added: ${path.relative(absolutePath, addedPath)}`));

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        runAnalysis();
      }, 300);
    });

    watcher.on('unlink', (removedPath) => {
      console.log(chalk.red(`\n➖ Removed: ${path.relative(absolutePath, removedPath)}`));

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        runAnalysis();
      }, 300);
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log(chalk.blue('\n\n👋 Stopping watch mode...'));
      watcher.close();
      process.exit(0);
    });
  });

// Init command to generate default config file
program
  .command('init')
  .description('Generate a default rld.config.json configuration file')
  .action(() => {
    const configPath = path.join(process.cwd(), 'rld.config.json');

    if (fs.existsSync(configPath)) {
      console.log(chalk.yellow(`Config file already exists: ${configPath}`));
      console.log(chalk.gray('Delete it first if you want to regenerate.'));
      process.exit(1);
    }

    const defaultConfig = {
      stableHooks: ['useQuery', 'useSelector', 'useTranslation'],
      unstableHooks: [],
      customFunctions: {
        // Example: "useApi": { "stable": true },
        // Example: "makeRequest": { "deferred": true }
      },
      ignore: [],
      minSeverity: 'low',
      minConfidence: 'low',
      includePotentialIssues: true,
    };

    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + '\n');
    console.log(chalk.green(`Created ${configPath}`));
    console.log(chalk.gray('\nConfiguration options:'));
    console.log(chalk.gray('  stableHooks: Hooks that return stable references (e.g., useQuery)'));
    console.log(chalk.gray('  unstableHooks: Hooks that return unstable references'));
    console.log(chalk.gray('  customFunctions: Custom function stability settings'));
    console.log(chalk.gray('  ignore: Additional patterns to ignore'));
    console.log(chalk.gray('  minSeverity: Minimum severity to report (high, medium, low)'));
    console.log(chalk.gray('  minConfidence: Minimum confidence to report (high, medium, low)'));
    console.log(chalk.gray('  includePotentialIssues: Include potential issues in results'));
  });

program.parse();
