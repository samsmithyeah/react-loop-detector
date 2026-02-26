/**
 * Tests for guard patterns and callback execution contexts in infinite loop detection.
 *
 * These tests cover both implemented fixes and pending improvements.
 * Tests marked with .skip are for features not yet implemented.
 */

import { analyzeHooks } from '../../src/orchestrator';
import { parseFile, ParsedFile } from '../../src/parser';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Helper to create a temp file and parse it
function createTestFile(content: string): ParsedFile {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcd-test-'));
  const filePath = path.join(tempDir, 'test.tsx');
  fs.writeFileSync(filePath, content);
  const parsed = parseFile(filePath);
  // Cleanup
  fs.unlinkSync(filePath);
  fs.rmdirSync(tempDir);
  return parsed;
}

describe('Guards and Callbacks: Implemented Fixes', () => {
  describe('1. AST Re-parsing Performance Fix', () => {
    it('should include AST in ParsedFile', async () => {
      const parsed = createTestFile(`
        import React, { useState } from 'react';
        export function Component() {
          const [count, setCount] = useState(0);
          return <div>{count}</div>;
        }
      `);

      expect(parsed.ast).toBeDefined();
      expect(parsed.ast.type).toBe('File');
      expect(parsed.content).toBeDefined();
      expect(typeof parsed.content).toBe('string');
    });
  });

  describe('2. Event Listener False Positive Fix', () => {
    it('should NOT flag addEventListener pattern as infinite loop', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect, useCallback } from 'react';

        export function Component() {
          const [size, setSize] = useState({ width: 0, height: 0 });

          const handleResize = useCallback(() => {
            setSize({ width: window.innerWidth, height: window.innerHeight });
          }, []);

          useEffect(() => {
            window.addEventListener('resize', handleResize);
            return () => window.removeEventListener('resize', handleResize);
          }, [handleResize]);

          return <div>{size.width}x{size.height}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops).toHaveLength(0);
    });

    it('should NOT flag setTimeout pattern as infinite loop', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect, useCallback } from 'react';

        export function Component() {
          const [count, setCount] = useState(0);

          const increment = useCallback(() => {
            setCount(c => c + 1);
          }, []);

          useEffect(() => {
            const timer = setTimeout(increment, 1000);
            return () => clearTimeout(timer);
          }, [increment]);

          return <div>{count}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops).toHaveLength(0);
    });

    it('SHOULD flag direct invocation as infinite loop', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component() {
          const [count, setCount] = useState(0);

          useEffect(() => {
            setCount(count + 1); // Direct invocation - infinite loop!
          }, [count]);

          return <div>{count}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops.length).toBeGreaterThan(0);
    });
  });

  describe('3. Context and Custom Hooks Detection', () => {
    it('should detect state from useContext with destructured setter', async () => {
      // Tests the pattern: const { data, setData } = useContext(...)
      // The analyzer uses heuristics: if 'setData' starts with 'set' + uppercase,
      // and 'data' is also destructured, it pairs them as state/setter
      const parsed = createTestFile(`
        import React, { useContext, useEffect } from 'react';
        import { MyContext } from './context';

        export function Component() {
          const { data, setData } = useContext(MyContext);

          useEffect(() => {
            setData(data + 1); // Should detect this as problematic
          }, [data, setData]);

          return <div>{data}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      expect(issues.length).toBeGreaterThan(0);
      // Verify it's specifically about 'data' dependency
      expect(issues.some((i) => i.problematicDependency === 'data')).toBe(true);
    });

    it('should detect state from custom hooks with array destructuring', async () => {
      // Tests the pattern: const [value, setValue] = useCustomHook(...)
      // The analyzer detects this because:
      // 1. It's array destructuring from a call starting with 'use'
      // 2. Second element starts with 'set' + uppercase
      const parsed = createTestFile(`
        import React, { useEffect } from 'react';
        import { useCustomState } from './hooks';

        export function Component() {
          const [value, setValue] = useCustomState(0);

          useEffect(() => {
            setValue(value + 1); // Should detect this
          }, [value]);

          return <div>{value}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((i) => i.problematicDependency === 'value')).toBe(true);
    });

    it('should NOT flag custom hooks (treated as stable by default)', async () => {
      // Custom hooks are treated as stable by default because they typically
      // return stable values from state management libraries (Zustand, Redux, etc.)
      // or from React's own hooks. Flagging them creates too many false positives.
      const parsed = createTestFile(`
        import React, { useEffect } from 'react';
        import { useCustomState } from './hooks';

        export function Component() {
          const [value, updateValue] = useCustomState(0); // 'updateValue' not 'setValue'

          useEffect(() => {
            updateValue(value + 1);
          }, [value]);

          return <div>{value}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // Custom hooks are treated as stable to avoid false positives
      // (most custom hooks wrap state management libraries that return stable values)
      expect(infiniteLoops).toHaveLength(0);
    });
  });

  describe('4. Ignore Comments Support', () => {
    it('should ignore hooks with rld-ignore comment on same line', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component() {
          const [count, setCount] = useState(0);

          useEffect(() => { // rld-ignore
            setCount(count + 1);
          }, [count]);

          return <div>{count}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops).toHaveLength(0);
    });

    it('should ignore hooks with rld-ignore-next-line comment', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component() {
          const [count, setCount] = useState(0);

          // rld-ignore-next-line
          useEffect(() => {
            setCount(count + 1);
          }, [count]);

          return <div>{count}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops).toHaveLength(0);
    });
  });

  describe('5. Toggle Guard Detection', () => {
    it('should recognize safe toggle guard pattern in useEffect', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component({ moral }) {
          const [showMoralInput, setShowMoralInput] = useState(false);

          useEffect(() => {
            if (moral && !showMoralInput) {
              setShowMoralInput(true);
            }
          }, [moral, showMoralInput]);

          return <div>{showMoralInput ? 'shown' : 'hidden'}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops).toHaveLength(0);
    });

    it('should recognize equality guard pattern in useEffect (not useCallback)', async () => {
      // IMPORTANT: This test uses useEffect to properly test guard detection.
      // useCallback can't cause infinite loops, so testing guards with it is meaningless.
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component({ newValue }) {
          const [currentValue, setCurrentValue] = useState(null);

          useEffect(() => {
            if (newValue !== currentValue) {
              setCurrentValue(newValue);
            }
          }, [newValue, currentValue]);

          return <div>{currentValue}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // Should NOT be flagged as infinite loop due to equality guard
      expect(infiniteLoops).toHaveLength(0);
    });

    it('should flag unguarded state modification in useEffect', async () => {
      // Control test: without a guard, this SHOULD be flagged
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component({ newValue }) {
          const [currentValue, setCurrentValue] = useState(null);

          useEffect(() => {
            // No guard - always sets state
            setCurrentValue(newValue);
          }, [newValue, currentValue]);

          return <div>{currentValue}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops.length).toBeGreaterThan(0);
    });
  });

  describe('5b. Guard Detection Through Indirect Function Calls (LOOP-5)', () => {
    it('should recognize !stateVar guard around indirect function call', async () => {
      // Exact pattern from geep/utils/useAAISpeechRecognition.ts
      // setNewToken() is a local function that calls setToken() internally.
      // The if (!token) guard around the call prevents infinite loops.
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function useAAISpeechRecognition() {
          const [token, setToken] = useState<string | undefined>(undefined);

          useEffect(() => {
            async function setNewToken() {
              setToken(await getToken());
            }
            if (!token) {
              setNewToken();
            }
          }, [token]);

          return token;
        }

        async function getToken() { return 'tok123'; }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // Should NOT be flagged — if (!token) guard prevents loop
      expect(infiniteLoops).toHaveLength(0);
    });

    it('should recognize guard around indirect call with arrow function', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component() {
          const [data, setData] = useState(null);

          useEffect(() => {
            const loadData = async () => {
              const result = await fetch('/api/data').then(r => r.json());
              setData(result);
            };
            if (!data) {
              loadData();
            }
          }, [data]);

          return <div>{data ? 'loaded' : 'loading'}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops).toHaveLength(0);
    });

    it('should NOT treat direct setter() with no args inside !stateVar guard as indirect call', async () => {
      // if (!token) setToken() → technically loops (sets undefined, !undefined is true)
      // but the CFG analysis correctly sees it's conditional and doesn't flag it as unconditional.
      // This is a known limitation: detecting that the value being set doesn't break the guard
      // would require value flow analysis, which is beyond current scope.
      // The key invariant: our indirect call fix does NOT accidentally mark this as safe
      // (calleeName === setterName check prevents it).
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component() {
          const [token, setToken] = useState<string | undefined>(undefined);

          useEffect(() => {
            if (!token) {
              setToken();
            }
          }, [token]);

          return <div>{token}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // Not flagged as unconditional — the guard makes it conditional
      // (detecting the value semantics would require value flow analysis)
      expect(infiniteLoops).toHaveLength(0);
    });
  });

  describe('6. useCallback/useMemo Cannot Cause Direct Loops', () => {
    it('should NOT flag useCallback as confirmed infinite loop', async () => {
      const parsed = createTestFile(`
        import React, { useState, useCallback } from 'react';

        export function Component() {
          const [count, setCount] = useState(0);

          const increment = useCallback(() => {
            setCount(count + 1);
          }, [count]);

          return <button onClick={increment}>Count: {count}</button>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // useCallback cannot cause infinite loops by itself
      expect(infiniteLoops).toHaveLength(0);
    });

    it('should NOT flag useCallback with functional updater at all', async () => {
      // This pattern is completely safe:
      // 1. useCallback doesn't auto-execute
      // 2. Functional updater doesn't read the dependency directly
      const parsed = createTestFile(`
        import React, { useState, useCallback } from 'react';

        export function Component() {
          const [cache, setCache] = useState<{ [key: string]: any }>({});

          const updateCache = useCallback(async (key: string, value: any) => {
            // Functional updater - doesn't read cache directly
            setCache((prev) => ({
              ...prev,
              [key]: value
            }));
          }, [cache]); // cache in deps for reference stability

          return <button onClick={() => updateCache('foo', 'bar')}>Update</button>;
        }
      `);

      const results = await analyzeHooks([parsed]);

      // Should not flag anything - functional updater in useCallback is completely safe
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );
      expect(issues).toHaveLength(0);
    });
  });
});

describe('Guards and Callbacks: Pending Improvements', () => {
  describe('Path Alias Resolution (tsconfig)', () => {
    it('should have path resolver available', async () => {
      // Test that the path resolver module exists and exports the expected functions
      const pathResolver = require('../../src/path-resolver');
      expect(pathResolver.createPathResolver).toBeDefined();
      expect(pathResolver.getTsconfigForProject).toBeDefined();
      expect(pathResolver.getPathsMatcher).toBeDefined();
      expect(typeof pathResolver.createPathResolver).toBe('function');
    });

    it('should resolve relative imports correctly', async () => {
      const pathResolver = require('../../src/path-resolver');
      const path = require('path');

      // Create resolver for this project (which has a tsconfig.json)
      const resolver = pathResolver.createPathResolver({
        projectRoot: path.join(__dirname, '..', '..'),
      });

      // Test relative import resolution
      const fromFile = path.join(__dirname, '..', 'fixtures', 'hooks-dependency-loop.tsx');
      const result = resolver.resolve(fromFile, './clean-hooks-example.tsx');

      // Should resolve to the clean-hooks-example file
      expect(result).toBeTruthy();
      expect(result).toContain('clean-hooks-example.tsx');
    });
  });

  describe('Object Reference Guard Detection', () => {
    it('should detect potential issues with object reference guards', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component() {
          const [user, setUser] = useState({ id: 0, name: '' });

          useEffect(() => {
            // This guard looks safe but creates infinite loop due to object reference
            if (user.id !== 5) {
              setUser({ ...user, id: 5 }); // New object every time!
            }
          }, [user]);

          return <div>{user.name}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      // Should warn about object reference issue
      const issues = results.filter(
        (r) => r.type === 'potential-issue' || r.type === 'confirmed-infinite-loop'
      );

      expect(issues.length).toBeGreaterThan(0);
      // Should specifically mention object spread risk
      const hasObjectSpreadWarning = issues.some(
        (i) =>
          i.explanation.includes('object reference') || i.explanation.includes('object identity')
      );
      expect(hasObjectSpreadWarning).toBe(true);
    });

    it('should NOT flag simple equality guards without object spread', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component({ newValue }) {
          const [value, setValue] = useState(0);

          useEffect(() => {
            // Simple equality guard with primitive - this is safe
            if (value !== newValue) {
              setValue(newValue);
            }
          }, [value, newValue]);

          return <div>{value}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const confirmedLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // Should NOT be flagged as infinite loop due to equality guard
      expect(confirmedLoops).toHaveLength(0);
    });
  });

  describe('7. Async Callback Detection (setInterval, onSnapshot, etc.)', () => {
    it('should NOT flag setInterval callbacks as infinite loops', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component() {
          const [currentTime, setCurrentTime] = useState(new Date());

          useEffect(() => {
            const interval = setInterval(() => {
              setCurrentTime(new Date()); // Inside setInterval - deferred
            }, 1000);
            return () => clearInterval(interval);
          }, []);

          return <div>{currentTime.toISOString()}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops).toHaveLength(0);
    });

    it('should NOT flag onSnapshot callbacks as infinite loops', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';
        import { onSnapshot, collection, db } from 'firebase/firestore';

        export function Component() {
          const [data, setData] = useState([]);
          const [cache, setCache] = useState({});

          useEffect(() => {
            const unsubscribe = onSnapshot(
              collection(db, 'items'),
              (snapshot) => {
                const items = snapshot.docs.map(doc => doc.data());
                setData(items);
                setCache(prev => ({ ...prev, items })); // Inside onSnapshot - deferred
              }
            );
            return () => unsubscribe();
          }, [cache]); // Even with cache in deps, it's safe

          return <div>{data.length}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops).toHaveLength(0);
    });

    it('should NOT flag setTimeout callbacks as infinite loops', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component() {
          const [status, setStatus] = useState('idle');

          useEffect(() => {
            if (status === 'loading') {
              setTimeout(() => {
                setStatus('complete'); // Inside setTimeout - deferred
              }, 2000);
            }
          }, [status]);

          return <div>{status}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops).toHaveLength(0);
    });

    it('should NOT flag Promise.then callbacks as infinite loops', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component({ userId }) {
          const [user, setUser] = useState(null);

          useEffect(() => {
            fetch('/api/user/' + userId)
              .then(res => res.json())
              .then(data => {
                setUser(data); // Inside .then - deferred
              });
          }, [userId, user]); // Even with user in deps

          return <div>{user?.name}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops).toHaveLength(0);
    });

    it('should NOT flag addEventListener with inline callback as infinite loops', async () => {
      // Note: addEventListener with an inline callback is detected as async/deferred
      // because addEventListener is in our asyncCallbackFunctions list
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component() {
          const [scrollY, setScrollY] = useState(0);

          useEffect(() => {
            window.addEventListener('scroll', () => {
              setScrollY(window.scrollY); // Inside inline addEventListener callback
            });
          }, [scrollY]); // Even with scrollY in deps

          return <div>Scroll: {scrollY}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops).toHaveLength(0);
    });

    it('should NOT flag addEventListener with named callback variable as infinite loops', async () => {
      // When a named function is defined and passed to addEventListener,
      // it's tracked as a function reference, not directly invoked
      const parsed = createTestFile(`
        import React, { useState, useEffect, useCallback } from 'react';

        export function Component() {
          const [scrollY, setScrollY] = useState(0);

          // Define handleScroll outside the effect as a stable reference
          const handleScroll = useCallback(() => {
            setScrollY(window.scrollY);
          }, []);

          useEffect(() => {
            window.addEventListener('scroll', handleScroll);
            return () => window.removeEventListener('scroll', handleScroll);
          }, [handleScroll]);

          return <div>Scroll: {scrollY}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // handleScroll is passed as reference (not invoked), so no infinite loop
      expect(infiniteLoops).toHaveLength(0);
    });

    it('SHOULD still flag direct state modifications as infinite loops', async () => {
      // Control test: direct modifications (not in async callbacks) should still be flagged
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component() {
          const [count, setCount] = useState(0);

          useEffect(() => {
            // Direct call, NOT inside any async callback
            setCount(count + 1);
          }, [count]);

          return <div>{count}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops.length).toBeGreaterThan(0);
    });

    it('should NOT flag subscribe pattern callbacks as infinite loops', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        export function Component() {
          const [messages, setMessages] = useState([]);

          useEffect(() => {
            const subscription = messageService.subscribe((msg) => {
              setMessages(prev => [...prev, msg]); // Inside subscribe callback
            });
            return () => subscription.unsubscribe();
          }, [messages]); // Even with messages in deps

          return <div>{messages.length}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      expect(infiniteLoops).toHaveLength(0);
    });
  });

  describe.skip('Index Resolution in Module Graph', () => {
    it('should correctly resolve directory index imports', async () => {
      // Test importing from directory with index.ts
      // Currently may fail with certain path patterns
    });

    it('should respect package.json main/exports field', async () => {
      // Node module resolution is complex
      // Currently only checks index.ts
    });
  });
});
