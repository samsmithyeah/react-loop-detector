import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  DidChangeConfigurationNotification,
  CodeActionParams,
  CodeAction,
  HoverParams,
  Hover,
  MarkupKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  detectCircularDependencies,
  loadConfig,
  parseFile,
  analyzeHooks,
  createPathResolver,
  getPersistentTypeChecker,
  getPersistentTypeCheckerPool,
  disposeAllPersistentTypeCheckers,
  disposeAllPersistentTypeCheckerPools,
  createTsconfigManager,
  type DetectionResults,
  type RcdConfig,
  type ParsedFile,
  type PathResolver,
  type TypeChecker,
  type TypeCheckerPool,
  type TsconfigManager,
} from 'react-loop-detector';
import {
  mapAnalysisToDiagnostics,
  filterDiagnostics,
  generateCodeActions,
} from './diagnostics-mapper.js';
import { IncrementalCache } from './incremental-cache.js';
import { fileUriToPath } from './utils.js';

// Create connection and document manager
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Server state
interface ServerSettings {
  enable: boolean;
  minSeverity: 'high' | 'medium' | 'low';
  minConfidence: 'high' | 'medium' | 'low';
  strictMode: boolean;
  debounceMs: number;
}

const defaultSettings: ServerSettings = {
  enable: true,
  minSeverity: 'low',
  minConfidence: 'medium', // Default to medium to reduce alert fatigue
  strictMode: false,
  debounceMs: 1000,
};

let globalSettings: ServerSettings = defaultSettings;
let hasConfigurationCapability = false;
let workspaceRoot: string | null = null;

// Analysis state
let cachedResults: DetectionResults | null = null;
let rldConfig: RcdConfig | null = null;
let fullAnalysisDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const singleFileDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
let isAnalyzing = false;
let pendingAnalysis = false;

// Incremental cache for fast updates
const incrementalCache = new IncrementalCache();

// Path resolver for resolving import paths
let pathResolver: PathResolver | null = null;

// Persistent type checker for strict mode (lazy-loaded, persists across analyses)
// For single-project workspaces
let persistentTypeChecker: TypeChecker | null = null;

// Persistent type checker pool for monorepo workspaces
// Manages multiple TypeChecker instances (one per tsconfig)
let persistentTypeCheckerPool: TypeCheckerPool | null = null;

// Tsconfig manager for monorepo detection
let tsconfigManager: TsconfigManager | null = null;

// Whether the workspace is a monorepo (detected once at startup)
let isMonorepoWorkspace = false;

// Initialize
connection.onInitialize((params: InitializeParams): InitializeResult => {
  const capabilities = params.capabilities;

  hasConfigurationCapability = !!(capabilities.workspace && capabilities.workspace.configuration);

  // Get workspace root
  if (params.workspaceFolders && params.workspaceFolders.length > 0) {
    workspaceRoot = fileUriToPath(params.workspaceFolders[0].uri);
  } else if (params.rootUri) {
    workspaceRoot = fileUriToPath(params.rootUri);
  }

  connection.console.log(`React Loop Detector server initialized. Workspace: ${workspaceRoot}`);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full, // Need full content for parsing
      codeActionProvider: true,
      hoverProvider: true,
      workspace: {
        workspaceFolders: {
          supported: true,
          changeNotifications: true,
        },
      },
    },
  };
});

connection.onInitialized(async () => {
  if (hasConfigurationCapability) {
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }

  // Initialize path resolver for the workspace
  if (workspaceRoot) {
    pathResolver = createPathResolver({ projectRoot: workspaceRoot });
    incrementalCache.setPathResolver(pathResolver);
    connection.console.log('Path resolver initialized for workspace');

    // Detect monorepo structure
    tsconfigManager = createTsconfigManager(workspaceRoot);
    const monorepoInfo = tsconfigManager.detectMonorepo();
    isMonorepoWorkspace = monorepoInfo.type !== null;

    if (isMonorepoWorkspace) {
      connection.console.log(`Monorepo detected: ${monorepoInfo.type}`);
    }
  }

  // Load rld config file
  await loadRldConfig();

  // Initial full analysis
  if (workspaceRoot && globalSettings.enable) {
    await runFullAnalysis();
  }
});

// Configuration change handler
connection.onDidChangeConfiguration(async (change) => {
  const previousStrictMode = globalSettings.strictMode;

  if (hasConfigurationCapability) {
    const settings = await connection.workspace.getConfiguration({
      section: 'reactLoopDetector',
    });
    globalSettings = {
      enable: settings?.enable ?? defaultSettings.enable,
      minSeverity: settings?.minSeverity ?? defaultSettings.minSeverity,
      minConfidence: settings?.minConfidence ?? defaultSettings.minConfidence,
      strictMode: settings?.strictMode ?? defaultSettings.strictMode,
      debounceMs: settings?.debounceMs ?? defaultSettings.debounceMs,
    };
  } else {
    globalSettings = (change.settings?.reactLoopDetector as ServerSettings) || defaultSettings;
  }

  // Dispose TypeChecker if strict mode was disabled
  if (previousStrictMode && !globalSettings.strictMode) {
    disposeTypeChecker();
  }

  // Re-analyze with new settings
  if (globalSettings.enable) {
    scheduleFullAnalysis();
  } else {
    clearAllDiagnostics();
  }
});

// Server shutdown - clean up resources
connection.onShutdown(() => {
  connection.console.log('Server shutting down, disposing resources...');
  disposeTypeChecker();
  disposeAllPersistentTypeCheckers();
  disposeAllPersistentTypeCheckerPools();
  incrementalCache.clear();
});

// Track files that have changed and need re-analysis
const pendingChangedFiles = new Set<string>();

// Document change handlers - Two-tier analysis strategy
documents.onDidChangeContent((change) => {
  if (!globalSettings.enable) return;
  if (!isReactFile(change.document.uri)) return;

  const filePath = fileUriToPath(change.document.uri);
  const content = change.document.getText();

  // Check if content actually changed
  if (!incrementalCache.hasFileChanged(filePath, content)) {
    return;
  }

  // Track this file as changed for incremental analysis
  pendingChangedFiles.add(filePath);

  // Also track affected files (files that import the changed file)
  const affectedFiles = incrementalCache.getFilesToReanalyze(filePath);
  for (const affected of affectedFiles) {
    pendingChangedFiles.add(affected);
  }

  // Tier 1: Fast single-file analysis (immediate feedback, ~50ms)
  scheduleSingleFileAnalysis(change.document.uri, content);

  // Tier 2: Full cross-file analysis (debounced, for accurate cross-file detection)
  scheduleFullAnalysis();
});

documents.onDidOpen((event) => {
  if (!globalSettings.enable) return;
  if (!isReactFile(event.document.uri)) return;

  // If we have cached results, send diagnostics for this file
  if (cachedResults) {
    sendDiagnosticsForFile(event.document.uri);
  }
});

documents.onDidClose((event) => {
  // Clear diagnostics for closed files
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });

  // Clear any pending single-file analysis
  const timer = singleFileDebounceTimers.get(event.document.uri);
  if (timer) {
    clearTimeout(timer);
    singleFileDebounceTimers.delete(event.document.uri);
  }
});

// Code actions (quick fixes)
connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const actions: CodeAction[] = [];

  for (const diagnostic of params.context.diagnostics) {
    if (diagnostic.source !== 'react-loop-detector') continue;

    const codeActions = generateCodeActions(
      diagnostic,
      params.textDocument.uri,
      document.getText()
    );
    actions.push(...codeActions);
  }

  return actions;
});

// Custom commands
connection.onRequest('reactLoopDetector/analyzeWorkspace', async () => {
  if (!workspaceRoot) {
    return { success: false, error: 'No workspace folder open' };
  }

  // Clear cache and run fresh analysis
  incrementalCache.clear();
  await runFullAnalysis();
  return { success: true };
});

connection.onRequest('reactLoopDetector/clearCache', () => {
  cachedResults = null;
  incrementalCache.clear();
  clearAllDiagnostics();
  return { success: true };
});

connection.onRequest('reactLoopDetector/getStats', () => {
  const cacheStats = incrementalCache.getStats();
  return {
    cachedFiles: cacheStats.filesCount,
    dependencyEdges: cacheStats.dependencyEdges,
    totalIssues: cachedResults?.intelligentHooksAnalysis.length ?? 0,
    crossFileCycles: cachedResults?.crossFileCycles.length ?? 0,
  };
});

// Hover provider for error code documentation
connection.onHover((params: HoverParams): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  // Check if we're hovering over an rld-ignore comment
  const line = document.getText({
    start: { line: params.position.line, character: 0 },
    end: { line: params.position.line, character: 1000 },
  });

  // Check for rld-ignore comments with error codes
  const ignoreMatch = line.match(/rld-ignore(?:-next-line)?\s+(RLD-\d+)/);
  if (ignoreMatch) {
    const errorCode = ignoreMatch[1];
    const doc = getErrorCodeDocumentation(errorCode);
    if (doc) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: doc,
        },
      };
    }
  }

  return null;
});

// Watch for config file changes
connection.onDidChangeWatchedFiles((params) => {
  for (const change of params.changes) {
    const fileName = change.uri.split('/').pop() || '';
    if (
      fileName === 'rld.config.js' ||
      fileName === 'rld.config.json' ||
      fileName === '.rldrc' ||
      fileName === '.rldrc.json'
    ) {
      connection.console.log('RLD config file changed, reloading...');
      loadRldConfig().then(() => {
        incrementalCache.clear();
        scheduleFullAnalysis();
      });
    }
  }
});

// Helper functions
async function loadRldConfig(): Promise<void> {
  if (!workspaceRoot) return;

  try {
    rldConfig = loadConfig(workspaceRoot);
    connection.console.log('Loaded rld config');
  } catch {
    rldConfig = null;
    connection.console.log('No rld config found, using defaults');
  }
}

/**
 * Get the TypeCheckerPool for monorepo workspaces.
 * Each file will get its own TypeChecker based on its governing tsconfig.
 */
function getTypeCheckerPool(): TypeCheckerPool | null {
  if (!globalSettings.strictMode || !workspaceRoot || !isMonorepoWorkspace) {
    return null;
  }

  if (!persistentTypeCheckerPool) {
    persistentTypeCheckerPool = getPersistentTypeCheckerPool(workspaceRoot);
    connection.console.log(
      'TypeScript type checker pool ready for monorepo (will initialize checkers on demand)'
    );
  }

  return persistentTypeCheckerPool;
}

/**
 * Get or create the persistent TypeChecker for strict mode analysis.
 * For single-project workspaces only.
 * The TypeChecker uses true lazy loading - it only initializes the TypeScript
 * Language Service when a type query is actually made, not when constructed.
 */
function getTypeChecker(): TypeChecker | null {
  if (!globalSettings.strictMode || !workspaceRoot) {
    return null;
  }

  // For monorepos, return null here - use getTypeCheckerPool() instead
  if (isMonorepoWorkspace) {
    return null;
  }

  if (!persistentTypeChecker) {
    persistentTypeChecker = getPersistentTypeChecker({
      projectRoot: workspaceRoot,
      tsconfigPath: rldConfig?.tsconfigPath,
      cacheTypes: true,
    });

    // Validate config (but don't fully initialize yet - that's lazy)
    const initialized = persistentTypeChecker.initialize();
    if (!initialized) {
      const error = persistentTypeChecker.getInitError();
      connection.console.warn(
        `TypeScript type checker validation failed: ${error?.message}. Falling back to heuristic-based detection.`
      );
      persistentTypeChecker = null;
      return null;
    }

    connection.console.log('TypeScript type checker ready (will initialize on first type query)');
  }

  return persistentTypeChecker;
}

/**
 * Update a file in the persistent TypeChecker/Pool (for incremental updates)
 */
function updateTypeCheckerFile(filePath: string, content: string): void {
  if (isMonorepoWorkspace && persistentTypeCheckerPool) {
    persistentTypeCheckerPool.updateFile(filePath, content);
  } else if (persistentTypeChecker) {
    persistentTypeChecker.updateFile(filePath, content);
  }
}

/**
 * Dispose the persistent TypeChecker/Pool (e.g., when strict mode is disabled)
 */
function disposeTypeChecker(): void {
  if (persistentTypeChecker) {
    persistentTypeChecker.dispose();
    persistentTypeChecker = null;
    connection.console.log('TypeScript type checker disposed');
  }
  if (persistentTypeCheckerPool) {
    persistentTypeCheckerPool.dispose();
    persistentTypeCheckerPool = null;
    connection.console.log('TypeScript type checker pool disposed');
  }
}

/**
 * Tier 1: Fast single-file analysis
 * Provides immediate feedback for obvious issues within a single file.
 * Runs with minimal debounce (~100ms) for responsive typing experience.
 */
function scheduleSingleFileAnalysis(uri: string, content: string): void {
  // Clear existing timer for this file
  const existingTimer = singleFileDebounceTimers.get(uri);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Short debounce for single-file analysis (100ms)
  const timer = setTimeout(() => {
    runSingleFileAnalysis(uri, content);
    singleFileDebounceTimers.delete(uri);
  }, 100);

  singleFileDebounceTimers.set(uri, timer);
}

async function runSingleFileAnalysis(uri: string, content: string): Promise<void> {
  const filePath = fileUriToPath(uri);
  notifyAnalysisStarted('single');

  try {
    // Parse the single file
    let parsed: ParsedFile;
    try {
      parsed = parseFile(filePath);
    } catch (error) {
      // Parse error - log and clear diagnostics for this file
      connection.console.error(
        `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
      connection.sendDiagnostics({ uri, diagnostics: [] });
      return;
    }

    // Update the cache
    incrementalCache.updateFile(filePath, content, parsed);

    // Update the persistent TypeChecker with the new file content (for incremental updates)
    updateTypeCheckerFile(filePath, content);

    // Run single-file analysis (no cross-file detection)
    // Pass the persistent TypeChecker/Pool if strict mode is enabled
    const analysis = await analyzeHooks([parsed], {
      stableHooks: rldConfig?.stableHooks,
      unstableHooks: rldConfig?.unstableHooks,
      customFunctions: rldConfig?.customFunctions,
      strictMode: globalSettings.strictMode,
      projectRoot: workspaceRoot || undefined,
      // Use pool for monorepos, single checker for single-project workspaces
      typeChecker: isMonorepoWorkspace ? undefined : getTypeChecker(),
      typeCheckerPool: isMonorepoWorkspace ? getTypeCheckerPool() : undefined,
    });

    // Update analysis cache
    incrementalCache.updateAnalysis(filePath, analysis);

    // Map to diagnostics - single file only, no cross-file cycles
    let diagnostics = mapAnalysisToDiagnostics(analysis, [], uri);

    diagnostics = filterDiagnostics(
      diagnostics,
      globalSettings.minSeverity,
      globalSettings.minConfidence
    );

    connection.sendDiagnostics({ uri, diagnostics });
    notifyAnalysisComplete('single', diagnostics.length, 1);
  } catch (error) {
    connection.console.error(
      `Single-file analysis failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    notifyAnalysisComplete('single', 0, 0);
  }
}

/**
 * Tier 2: Full cross-file analysis
 * Runs with longer debounce to catch cross-file issues.
 */
function scheduleFullAnalysis(): void {
  if (fullAnalysisDebounceTimer) {
    clearTimeout(fullAnalysisDebounceTimer);
  }

  fullAnalysisDebounceTimer = setTimeout(() => {
    runFullAnalysis();
  }, globalSettings.debounceMs);
}

async function runFullAnalysis(): Promise<void> {
  if (!workspaceRoot) return;

  if (isAnalyzing) {
    pendingAnalysis = true;
    return;
  }

  isAnalyzing = true;

  // Log incremental analysis info (future optimization: use this for true incremental analysis)
  if (pendingChangedFiles.size > 0) {
    connection.console.log(
      `Starting cross-file analysis (${pendingChangedFiles.size} files changed/affected)...`
    );
  } else {
    connection.console.log('Starting full cross-file analysis...');
  }
  notifyAnalysisStarted('full');

  try {
    // Note: Currently runs full analysis. Future optimization could use pendingChangedFiles
    // to only re-analyze affected files and merge with cached results.
    const results = await detectCircularDependencies(workspaceRoot, {
      pattern: '**/*.{ts,tsx,js,jsx}',
      ignore: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/*.test.*',
        '**/*.spec.*',
        ...(rldConfig?.ignore || []),
      ],
      strict: globalSettings.strictMode,
      cache: true, // Use the core library's caching
      config: {
        ...rldConfig,
        minSeverity: globalSettings.minSeverity,
        minConfidence: globalSettings.minConfidence,
      },
    });

    cachedResults = results;

    // Clear pending changed files after successful analysis
    pendingChangedFiles.clear();

    connection.console.log(
      `Full analysis complete. Found ${results.intelligentHooksAnalysis.length} issues, ${results.crossFileCycles.length} cross-file cycles in ${results.summary.filesAnalyzed} files`
    );

    // Send diagnostics to all open documents
    sendDiagnosticsToAllDocuments();

    notifyAnalysisComplete(
      'full',
      results.intelligentHooksAnalysis.length + results.crossFileCycles.length,
      results.summary.filesAnalyzed
    );
  } catch (error) {
    connection.console.error(
      `Full analysis failed: ${error instanceof Error ? error.message : String(error)}`
    );
    notifyAnalysisComplete('full', 0, 0);
  } finally {
    isAnalyzing = false;

    if (pendingAnalysis) {
      pendingAnalysis = false;
      scheduleFullAnalysis();
    }
  }
}

function sendDiagnosticsToAllDocuments(): void {
  if (!cachedResults) return;

  // Send diagnostics for all open documents
  for (const document of documents.all()) {
    sendDiagnosticsForFile(document.uri);
  }
}

function sendDiagnosticsForFile(uri: string): void {
  if (!cachedResults) {
    connection.sendDiagnostics({ uri, diagnostics: [] });
    return;
  }

  let diagnostics = mapAnalysisToDiagnostics(
    cachedResults.intelligentHooksAnalysis,
    cachedResults.crossFileCycles,
    uri
  );

  diagnostics = filterDiagnostics(
    diagnostics,
    globalSettings.minSeverity,
    globalSettings.minConfidence
  );

  connection.sendDiagnostics({ uri, diagnostics });
}

function clearAllDiagnostics(): void {
  for (const document of documents.all()) {
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  }
}

function isReactFile(uri: string): boolean {
  const extensions = ['.ts', '.tsx', '.js', '.jsx'];
  return extensions.some((ext) => uri.endsWith(ext));
}

// Status notification helpers
function notifyAnalysisStarted(type: 'single' | 'full'): void {
  connection.sendNotification('reactLoopDetector/analysisStarted', { type });
}

function notifyAnalysisComplete(
  type: 'single' | 'full',
  issueCount: number,
  filesAnalyzed: number
): void {
  connection.sendNotification('reactLoopDetector/analysisComplete', {
    type,
    issueCount,
    filesAnalyzed,
  });
}

// Error code documentation
const errorCodeDocs: Record<string, { title: string; description: string; example?: string }> = {
  'RLD-100': {
    title: 'setState during render',
    description:
      'Calling setState synchronously during render causes an immediate re-render, creating an infinite loop.',
    example: `// Bad: setState called during render
function Component() {
  const [count, setCount] = useState(0);
  setCount(count + 1); // This runs every render!
  return <div>{count}</div>;
}`,
  },
  'RLD-101': {
    title: 'Render phase setState via function call',
    description:
      'A function called during render eventually calls setState, causing an infinite loop.',
  },
  'RLD-200': {
    title: 'useEffect unconditional setState loop',
    description:
      'useEffect modifies a state variable that is also in its dependency array, causing infinite re-renders.',
    example: `// Bad: count changes -> effect runs -> count changes -> ...
useEffect(() => {
  setCount(count + 1);
}, [count]);`,
  },
  'RLD-201': {
    title: 'useEffect missing deps with setState',
    description:
      'useEffect calls setState but has an empty or missing dependency array, which may cause stale closures or unexpected behavior.',
  },
  'RLD-202': {
    title: 'useLayoutEffect unconditional setState loop',
    description:
      'Same as RLD-200 but with useLayoutEffect, which runs synchronously and can cause more severe performance issues.',
  },
  'RLD-300': {
    title: 'Cross-file loop risk',
    description:
      'A circular dependency between files may cause infinite loops when state changes propagate across components.',
  },
  'RLD-301': {
    title: 'Cross-file conditional modification',
    description: 'Cross-file state modification with conditions that may not prevent all loops.',
  },
  'RLD-400': {
    title: 'Unstable object reference in deps',
    description:
      'Object literals in dependency arrays create new references every render, causing effects to run unnecessarily.',
    example: `// Bad: new object every render
useEffect(() => {}, [{ id: 1 }]);

// Good: stable reference
const config = useMemo(() => ({ id: 1 }), []);
useEffect(() => {}, [config]);`,
  },
  'RLD-401': {
    title: 'Unstable array reference in deps',
    description: 'Array literals in dependency arrays create new references every render.',
  },
  'RLD-402': {
    title: 'Unstable function reference in deps',
    description:
      'Inline functions in dependency arrays create new references every render. Use useCallback to stabilize.',
  },
  'RLD-403': {
    title: 'Unstable function call result in deps',
    description:
      'Function call results that return new objects/arrays each time cause unnecessary effect runs.',
  },
  'RLD-410': {
    title: 'Object spread guard risk',
    description:
      'Using object spread as a guard may not prevent loops if the spread creates a new object reference.',
  },
  'RLD-420': {
    title: 'useCallback/useMemo modifies dependency',
    description:
      'The memoized function modifies a value it depends on, which may cause loops when called in effects.',
  },
  'RLD-500': {
    title: 'useEffect missing dependency array',
    description:
      'useEffect without a dependency array runs after every render. If it calls setState, this causes infinite loops.',
  },
  'RLD-501': {
    title: 'Conditional modification needs review',
    description:
      'State modification is conditional but the guard may not prevent all infinite loop scenarios.',
  },
  'RLD-600': {
    title: 'Render-phase ref mutation with state value',
    description:
      'Mutating a ref with a state value during render can cause issues. Note: Effect-phase ref mutations (useEffect/useLayoutEffect) are safe - this is the standard usePrevious/useLatest pattern.',
  },
};

function getErrorCodeDocumentation(code: string): string | null {
  const doc = errorCodeDocs[code];
  if (!doc) return null;

  let markdown = `## ${code}: ${doc.title}\n\n${doc.description}`;

  if (doc.example) {
    markdown += `\n\n### Example\n\n\`\`\`typescript\n${doc.example}\n\`\`\``;
  }

  markdown += `\n\n[Documentation](https://github.com/samsmithyeah/react-loop-detector#${code.toLowerCase()})`;

  return markdown;
}

// Start listening
documents.listen(connection);
connection.listen();
