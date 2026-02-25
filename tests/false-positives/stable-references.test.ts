/**
 * Tests for stable reference false positive prevention
 *
 * These tests ensure the detector doesn't flag legitimate patterns as issues:
 * 1. Variables wrapped in useCallback/useMemo
 * 2. Primitive values (strings from .join(), numbers from Math.round())
 * 3. Zustand's getState() pattern for stable actions
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

describe('Stable Reference False Positives', () => {
  describe('useCallback-wrapped functions should be stable', () => {
    it('should NOT flag functions wrapped in useCallback as unstable', async () => {
      // From IllustrationSelection.tsx - loadStyles is wrapped in useCallback
      const parsed = createTestFile(`
        import React, { useCallback, useEffect, useState } from 'react';

        export function IllustrationSelection() {
          const [styles, setStyles] = useState([]);
          const [loading, setLoading] = useState(false);

          const loadStyles = useCallback(async () => {
            setLoading(true);
            try {
              const loadedStyles = await fetchStyles();
              setStyles(loadedStyles);
            } finally {
              setLoading(false);
            }
          }, []);

          // Load styles on mount
          useEffect(() => {
            loadStyles();
          }, [loadStyles]);

          return <div>{styles.length} styles</div>;
        }

        async function fetchStyles() { return []; }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // loadStyles is wrapped in useCallback with [] deps, so it's stable
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag useMemo-wrapped values as unstable', async () => {
      const parsed = createTestFile(`
        import React, { useMemo, useEffect, useState } from 'react';

        export function Component() {
          const [items, setItems] = useState([]);

          const sortedItems = useMemo(() => {
            return [...items].sort((a, b) => a.name.localeCompare(b.name));
          }, [items]);

          useEffect(() => {
            console.log('Sorted items changed:', sortedItems.length);
          }, [sortedItems]);

          return <div>{sortedItems.length}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // sortedItems is wrapped in useMemo, so it's stable when items is stable
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag React.useCallback-wrapped functions as unstable', async () => {
      // From IllustrationSelection.tsx - loadStyles is wrapped in React.useCallback
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';

        export function IllustrationSelection() {
          const [styles, setStyles] = useState([]);
          const [loading, setLoading] = useState(false);

          const loadStyles = React.useCallback(async () => {
            setLoading(true);
            try {
              const loadedStyles = await fetchStyles();
              setStyles(loadedStyles);
            } finally {
              setLoading(false);
            }
          }, []);

          // Load styles on mount
          useEffect(() => {
            loadStyles();
          }, [loadStyles]);

          return <div>{styles.length} styles</div>;
        }

        async function fetchStyles() { return []; }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // loadStyles is wrapped in React.useCallback with [] deps, so it's stable
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag React.useMemo-wrapped values as unstable', async () => {
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';

        export function Component() {
          const [items, setItems] = useState([]);

          const sortedItems = React.useMemo(() => {
            return [...items].sort((a, b) => a.name.localeCompare(b.name));
          }, [items]);

          useEffect(() => {
            console.log('Sorted items changed:', sortedItems.length);
          }, [sortedItems]);

          return <div>{sortedItems.length}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // sortedItems is wrapped in React.useMemo, so it's stable
      expect(issues).toHaveLength(0);
    });
  });

  describe('Primitive values should be stable', () => {
    it('should NOT flag string from .join() as unstable', async () => {
      // From CharacterSelection.tsx - childrenTimestampKey is a string
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';

        interface Child {
          id: string;
          updatedAt?: Date;
          createdAt?: Date;
        }

        export function CharacterSelection({ savedChildren }: { savedChildren: Child[] }) {
          const [photoUrls, setPhotoUrls] = useState<string[]>([]);

          // Create stable key for detecting when photos need to be reloaded
          const childrenTimestampKey = savedChildren
            .map((c) => \`\${c.id}-\${c.updatedAt?.getTime() || c.createdAt?.getTime()}\`)
            .join(",");

          useEffect(() => {
            const loadPhotoUrls = async () => {
              const urls = await Promise.all(
                savedChildren.map(async (child) => {
                  return await getAuthenticatedUrl(child.id);
                })
              );
              setPhotoUrls(urls);
            };

            if (savedChildren.length > 0) {
              loadPhotoUrls();
            }
          }, [savedChildren, childrenTimestampKey]);

          return <div>{photoUrls.length} photos</div>;
        }

        async function getAuthenticatedUrl(id: string) { return ''; }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // childrenTimestampKey is a string (primitive), compared by value not reference
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag number from Math.round() as unstable', async () => {
      // From StoryViewer.tsx - textPanelMaxHeight is a number
      const parsed = createTestFile(`
        import React, { useCallback, useState } from 'react';

        export function StoryViewer() {
          const [pages, setPages] = useState([]);
          const availableHeight = 800;
          const textPanelMaxPct = 0.48;

          const textPanelMaxHeight = Math.round(availableHeight * textPanelMaxPct);

          const renderPage = useCallback(
            (page: any, index: number) => {
              return (
                <div key={index} style={{ maxHeight: textPanelMaxHeight }}>
                  {page.text}
                </div>
              );
            },
            [textPanelMaxHeight]
          );

          return <div>{pages.map(renderPage)}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // textPanelMaxHeight is a number (primitive), compared by value not reference
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag boolean expressions as unstable', async () => {
      const parsed = createTestFile(`
        import React, { useCallback, useState } from 'react';

        export function Component({ items }: { items: any[] }) {
          const hasItems = items.length > 0;
          const isEmpty = !hasItems;

          const handleClick = useCallback(() => {
            if (hasItems) {
              console.log('Has items');
            }
          }, [hasItems]);

          return <button onClick={handleClick}>{isEmpty ? 'Empty' : 'Has items'}</button>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // hasItems is a boolean (primitive)
      expect(issues).toHaveLength(0);
    });
  });

  describe('URLSearchParams.get() and .has() should be stable', () => {
    it('should NOT flag searchParams.get() as unstable (returns string|null primitive)', async () => {
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';

        export function VerifyEmailPage({ searchParams }: { searchParams: URLSearchParams }) {
          const [status, setStatus] = useState('loading');
          const oobCode = searchParams.get('oobCode');

          useEffect(() => {
            if (!oobCode) {
              setStatus('fallback');
              return;
            }
            verifyEmail(oobCode).then(() => setStatus('success'));
          }, [oobCode]);

          return <div>{status}</div>;
        }

        async function verifyEmail(code: string) {}
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // searchParams.get() returns string|null (primitive), compared by value
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag searchParams.has() as unstable (returns boolean primitive)', async () => {
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';

        export function Component({ searchParams }: { searchParams: URLSearchParams }) {
          const [message, setMessage] = useState('');
          const hasToken = searchParams.has('token');

          useEffect(() => {
            if (hasToken) {
              setMessage('Token found');
            }
          }, [hasToken]);

          return <div>{message}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // searchParams.has() returns boolean (primitive), compared by value
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag headers.get() as unstable (returns string|null primitive)', async () => {
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';

        export function Component({ headers }: { headers: Headers }) {
          const [auth, setAuth] = useState('');
          const contentType = headers.get('content-type');

          useEffect(() => {
            if (contentType) {
              setAuth(contentType);
            }
          }, [contentType]);

          return <div>{auth}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // headers.get() returns string|null (primitive), compared by value
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag Map.get() with dynamic key as unstable (returns stored reference)', async () => {
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';

        export function Component({ configMap, activeKey }: { configMap: Map<string, object>; activeKey: string }) {
          const [label, setLabel] = useState('');
          const config = configMap.get(activeKey);

          useEffect(() => {
            if (config) {
              setLabel(String(config));
            }
          }, [config]);

          return <div>{label}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // Map.get(key) returns a stored reference — stable as long as the Map is stable
      expect(issues).toHaveLength(0);
    });

    it('should flag multi-argument .get() as potentially unstable (e.g., HTTP client pattern)', async () => {
      const parsed = createTestFile(`
        import React, { useEffect } from 'react';

        export function Component({ apiClient }: { apiClient: any }) {
          const response = apiClient.get('/users', { params: { page: 1 } });

          useEffect(() => {
            console.log(response);
          }, [response]);

          return <div />;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // Multi-arg .get() is not a key-value lookup — could return new objects
      expect(issues.length).toBeGreaterThan(0);
    });
  });

  describe('Zustand getState() pattern should be stable', () => {
    it('should NOT flag actions from useStore.getState() as unstable', async () => {
      // From index.tsx - setStories comes from useLibraryStore.getState()
      const parsed = createTestFile(`
        import React, { useCallback, useEffect, useState } from 'react';
        import { useLibraryStore } from './store';

        export function LibraryScreen() {
          const stories = useLibraryStore((state) => state.stories);
          const [refreshing, setRefreshing] = useState(false);

          // Actions are stable and won't cause re-renders
          const { setStories, setShouldPreserveState } = useLibraryStore.getState();

          const handleRefresh = useCallback(async () => {
            setRefreshing(true);
            try {
              const newStories = await getStories();
              setStories(newStories);
            } finally {
              setRefreshing(false);
            }
          }, [setStories]);

          const openStory = useCallback(
            (storyId: string) => {
              setShouldPreserveState(true);
              navigate(storyId);
            },
            [setShouldPreserveState]
          );

          return <div>{stories.length} stories</div>;
        }

        async function getStories() { return []; }
        function navigate(id: string) {}
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // setStories and setShouldPreserveState come from getState(), which returns stable refs
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag actions from any store.getState() pattern', async () => {
      const parsed = createTestFile(`
        import React, { useCallback } from 'react';
        import { useAuthStore } from './authStore';
        import { useCartStore } from './cartStore';

        export function Component() {
          const { login, logout } = useAuthStore.getState();
          const { addItem, removeItem, clearCart } = useCartStore.getState();

          const handleLogin = useCallback(() => {
            login('user@example.com');
          }, [login]);

          const handleAddToCart = useCallback((item: any) => {
            addItem(item);
          }, [addItem]);

          return <button onClick={handleLogin}>Login</button>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // All actions from getState() should be stable
      expect(issues).toHaveLength(0);
    });
  });

  describe('Array filter/sort without memoization', () => {
    it('should flag as potential-issue (not infinite loop) when setState is conditional', async () => {
      // From credits.tsx - subscriptions array is recreated each render
      // This is flagged as potential-issue (not confirmed-infinite-loop) because:
      // 1. subscriptions is recreated every render (new array from .filter().sort())
      // 2. This WILL cause the useEffect to run on every render
      // 3. BUT setState is conditional, so it won't cause infinite re-renders
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';

        interface Package {
          product: { price: number; identifier: string };
        }

        export function CreditsScreen({ offerings }: { offerings: { availablePackages: Package[] } | null }) {
          const [selectedPackage, setSelectedPackage] = useState<Package | null>(null);

          // These arrays are recreated on every render - performance issue
          const subscriptions = (
            offerings?.availablePackages.filter((pkg) =>
              pkg.product.identifier.includes('subscription')
            ) || []
          ).sort((a, b) => a.product.price - b.product.price);

          useEffect(() => {
            if (!offerings?.availablePackages) return;

            // Only auto-select if nothing is currently selected (CONDITIONAL)
            if (!selectedPackage) {
              const popular = subscriptions.find((pkg) => pkg.product.price > 0);
              if (popular) {
                setSelectedPackage(popular);
              }
            }
          }, [offerings, subscriptions, selectedPackage]);

          return <div>{subscriptions.length} subscriptions</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');
      const potentialIssues = results.filter((r) => r.type === 'potential-issue');

      // Should NOT be flagged as infinite loop (setState is conditional)
      expect(infiniteLoops).toHaveLength(0);

      // SHOULD be flagged as potential issue (performance concern)
      expect(potentialIssues.length).toBeGreaterThan(0);
      expect(potentialIssues[0].problematicDependency).toBe('subscriptions');
      // Performance issues (unstable references) now have low severity
      expect(potentialIssues[0].severity).toBe('low');
      expect(potentialIssues[0].category).toBe('performance');
    });

    it('SHOULD flag as confirmed-infinite-loop when setState is unconditional', async () => {
      // This is a TRUE infinite loop - setState is called unconditionally
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';

        export function BrokenComponent({ items }: { items: number[] }) {
          const [count, setCount] = useState(0);

          // Unstable array - recreated every render
          const doubled = items.map(x => x * 2);

          useEffect(() => {
            // UNCONDITIONAL setState - this WILL cause infinite loop
            setCount(doubled.length);
          }, [doubled]);

          return <div>{count}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // SHOULD be flagged as confirmed infinite loop
      expect(infiniteLoops.length).toBeGreaterThan(0);
      expect(infiniteLoops[0].problematicDependency).toBe('doubled');
      expect(infiniteLoops[0].severity).toBe('high');
    });
  });

  describe('Control tests - patterns that SHOULD be flagged', () => {
    it('SHOULD flag unstable object literals in dependencies', async () => {
      const parsed = createTestFile(`
        import React, { useEffect } from 'react';

        export function Component() {
          const config = { timeout: 5000 }; // New object every render

          useEffect(() => {
            fetch('/api', config);
          }, [config]); // config changes every render!

          return <div>Loading...</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // config is an object literal, recreated every render
      expect(issues.length).toBeGreaterThan(0);
    });

    it('SHOULD flag unstable array literals in dependencies', async () => {
      const parsed = createTestFile(`
        import React, { useEffect } from 'react';

        export function Component({ a, b }: { a: number; b: number }) {
          const items = [a, b]; // New array every render

          useEffect(() => {
            console.log('Items:', items);
          }, [items]); // items changes every render!

          return <div>{items.length}</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // items is an array literal, recreated every render
      expect(issues.length).toBeGreaterThan(0);
    });

    it('SHOULD flag inline functions in dependencies', async () => {
      const parsed = createTestFile(`
        import React, { useEffect } from 'react';

        export function Component() {
          const handleClick = () => console.log('clicked'); // New function every render

          useEffect(() => {
            document.addEventListener('click', handleClick);
            return () => document.removeEventListener('click', handleClick);
          }, [handleClick]); // handleClick changes every render!

          return <div>Click me</div>;
        }
      `);

      const results = await analyzeHooks([parsed]);
      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // handleClick is an inline function, recreated every render
      expect(issues.length).toBeGreaterThan(0);
    });
  });

  describe('Zustand store hooks via pattern matching (useXxxStore)', () => {
    // These tests verify that Zustand store hooks matching the /^use\w+Store$/ pattern
    // are correctly identified as stable when using presets

    it('should NOT flag useAuthStore selector as unstable', async () => {
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';
        import { useAuthStore } from './store';

        export function ProfileScreen() {
          const [loading, setLoading] = useState(false);
          // Zustand selector - returns stable reference
          const user = useAuthStore((state) => state.user);
          const setUser = useAuthStore((state) => state.setUser);

          useEffect(() => {
            if (!user) {
              setLoading(true);
              fetchUser().then((u) => {
                setUser(u);
                setLoading(false);
              });
            }
          }, [user, setUser]);

          return <div>{user?.name}</div>;
        }

        async function fetchUser() { return { name: 'Test' }; }
      `);

      // Pass Zustand preset config with pattern
      const results = await analyzeHooks([parsed], {
        stableHooks: ['useStore', 'useShallow'],
        stableHookPatterns: [/^use\w+Store$/],
      });

      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // user and setUser from useAuthStore should be treated as stable
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag useLibraryStore selector as unstable', async () => {
      const parsed = createTestFile(`
        import React, { useMemo } from 'react';
        import { useLibraryStore } from './store';

        export function ShareModal({ storyId }: { storyId: string }) {
          // Zustand selector with .find() - the selector function is called by Zustand
          // and the returned object reference is stable (memoized internally)
          const story = useLibraryStore((state) => state.stories.find((s) => s.id === storyId));

          const shareMessage = useMemo(() => {
            if (!story) return "";
            return \`Check out "\${story.title}"!\`;
          }, [story]);

          return <div>{shareMessage}</div>;
        }
      `);

      const results = await analyzeHooks([parsed], {
        stableHooks: ['useStore'],
        stableHookPatterns: [/^use\w+Store$/],
      });

      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // story from useLibraryStore should be treated as stable
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag useWizardPrefillStore selector as unstable', async () => {
      const parsed = createTestFile(`
        import React, { useEffect } from 'react';
        import { useWizardPrefillStore } from './store';

        export function StoryWizard() {
          const prefillConfig = useWizardPrefillStore((state) => state.prefillConfig);
          const clearPrefill = useWizardPrefillStore((state) => state.clearPrefill);

          useEffect(() => {
            if (!prefillConfig) return;
            // Apply prefill config
            console.log('Applying prefill:', prefillConfig);
            clearPrefill();
          }, [prefillConfig, clearPrefill]);

          return <div>Wizard</div>;
        }
      `);

      const results = await analyzeHooks([parsed], {
        stableHookPatterns: [/^use\w+Store$/],
      });

      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // prefillConfig and clearPrefill from Zustand should be stable
      expect(issues).toHaveLength(0);
    });

    it('should respect unstableHooks configuration', async () => {
      // Test that explicitly configured unstable hooks are flagged
      const parsed = createTestFile(`
        import React, { useEffect } from 'react';
        import { useWindowSize } from 'react-use'; // Known unstable hook

        export function Component() {
          // useWindowSize returns { width, height } - new object each render
          const size = useWindowSize();

          useEffect(() => {
            console.log('Size changed:', size);
          }, [size]);

          return <div>{size.width}x{size.height}</div>;
        }
      `);

      const results = await analyzeHooks([parsed], {
        stableHookPatterns: [/^use\w+Store$/],
        unstableHooks: ['useWindowSize'], // Explicitly marked as unstable
      });

      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // useWindowSize is explicitly marked as unstable, so size should be flagged
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].problematicDependency).toBe('size');
    });
  });

  describe('expo-router hooks via preset', () => {
    // These tests verify that expo-router hooks are correctly identified as stable

    it('should NOT flag useRouter as unstable', async () => {
      const parsed = createTestFile(`
        import React, { useEffect } from 'react';
        import { useRouter } from 'expo-router';

        export function TabLayout() {
          const router = useRouter();
          const user = null; // Simulated auth state

          useEffect(() => {
            if (!user) {
              router.replace('/(auth)/login');
            }
          }, [user, router]);

          return <div>Tab Layout</div>;
        }
      `);

      const results = await analyzeHooks([parsed], {
        stableHooks: ['useRouter', 'useNavigation', 'useLocalSearchParams'],
      });

      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // router from useRouter should be stable (expo-router preset)
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag useLocalSearchParams as unstable', async () => {
      const parsed = createTestFile(`
        import React, { useEffect, useState } from 'react';
        import { useLocalSearchParams } from 'expo-router';

        export function StoryScreen() {
          const { storyId } = useLocalSearchParams();
          const [story, setStory] = useState(null);

          useEffect(() => {
            if (storyId) {
              fetchStory(storyId).then(setStory);
            }
          }, [storyId]);

          return <div>{story?.title}</div>;
        }

        async function fetchStory(id: string) { return { title: 'Test' }; }
      `);

      const results = await analyzeHooks([parsed], {
        stableHooks: ['useLocalSearchParams', 'useGlobalSearchParams'],
      });

      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // storyId from useLocalSearchParams destructuring should be stable
      expect(issues).toHaveLength(0);
    });

    it('should NOT flag useSegments as unstable', async () => {
      const parsed = createTestFile(`
        import React, { useEffect } from 'react';
        import { useSegments, useRouter } from 'expo-router';

        export function AuthLayout() {
          const segments = useSegments();
          const router = useRouter();
          const isLoggedIn = false;

          useEffect(() => {
            const inAuthGroup = segments[0] === '(auth)';
            if (!isLoggedIn && !inAuthGroup) {
              router.replace('/(auth)/login');
            }
          }, [segments, router, isLoggedIn]);

          return <div>Auth Layout</div>;
        }
      `);

      const results = await analyzeHooks([parsed], {
        stableHooks: ['useSegments', 'useRouter', 'usePathname'],
      });

      const issues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' || r.type === 'potential-issue'
      );

      // segments from useSegments should be stable
      expect(issues).toHaveLength(0);
    });
  });
});
