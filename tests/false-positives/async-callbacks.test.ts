/**
 * Tests for async callback false positive prevention
 *
 * These tests ensure the detector doesn't flag legitimate async callback patterns
 * as infinite loops. Each test case is based on actual code that was incorrectly
 * flagged as a "CONFIRMED infinite loop" before the async callback detection fix.
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

describe('Async Callback False Positives', () => {
  describe('setInterval pattern', () => {
    it('should NOT flag setCurrentTime inside setInterval as infinite loop', async () => {
      // This pattern was incorrectly flagged as "CONFIRMED infinite loop"
      // Timer callbacks are deferred and don't execute synchronously
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        interface Signal {
          createdAt: any;
          responses: any[];
          notificationsSent?: number;
        }

        const OutgoingSignalCard: React.FC<{ signal: Signal }> = ({ signal }) => {
          const [currentTime, setCurrentTime] = useState(new Date());

          useEffect(() => {
            const createdAt = signal.createdAt?.toDate
              ? signal.createdAt.toDate()
              : new Date();

            const notificationCount = signal.notificationsSent || 0;
            const hasResponses = signal.responses.length > 0;
            const timeElapsed = currentTime.getTime() - createdAt.getTime();
            const alreadyShowingNoNotifications = timeElapsed > 10000 && notificationCount === 0;

            // Stop the timer if we already have responses, notifications, or are showing the warning
            if (hasResponses || notificationCount > 0 || alreadyShowingNoNotifications) {
              return;
            }

            const interval = setInterval(() => {
              setCurrentTime(new Date()); // DEFERRED - inside setInterval callback
            }, 5000);

            return () => clearInterval(interval);
          }, [signal.responses.length, signal.notificationsSent, currentTime]);

          return <div>{currentTime.toISOString()}</div>;
        };

        export default OutgoingSignalCard;
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // Should NOT be flagged - setCurrentTime is inside setInterval (deferred)
      expect(infiniteLoops).toHaveLength(0);
    });
  });

  describe('Firebase onSnapshot pattern', () => {
    it('should NOT flag setCrewsCache inside onSnapshot as infinite loop', async () => {
      // This pattern was incorrectly flagged as "CONFIRMED infinite loop"
      // Real-time listener callbacks are deferred and event-driven
      const parsed = createTestFile(`
        import React, { useState, useEffect, useContext, createContext } from 'react';

        interface Crew {
          id: string;
          name: string;
        }

        const InvitationsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
          const [invitations, setInvitations] = useState<any[]>([]);
          const [loading, setLoading] = useState<boolean>(true);
          const [crewsCache, setCrewsCache] = useState<{ [key: string]: Crew }>({});
          const [usersCache, setUsersCache] = useState<{ [key: string]: any }>({});

          useEffect(() => {
            const user = { uid: 'test' };
            if (!user?.uid) {
              setInvitations([]);
              setLoading(false);
              return;
            }

            // Real-time listener using Firebase onSnapshot
            const unsubscribe = onSnapshot(
              query(collection(db, 'invitations')),
              async (snapshot) => {
                const invitationsList = snapshot.docs.map((docSnap) => ({
                  id: docSnap.id,
                  ...docSnap.data(),
                }));

                // Fetch crew details - updates cache inside onSnapshot callback
                const newCrewsCache = { ...crewsCache };
                // ... fetching logic
                setCrewsCache(newCrewsCache); // DEFERRED - inside onSnapshot callback

                // Fetch user details
                const newUsersCache = { ...usersCache };
                // ... fetching logic
                setUsersCache(newUsersCache); // DEFERRED - inside onSnapshot callback

                setInvitations(invitationsList);
                setLoading(false);
              }
            );

            return () => unsubscribe();
          }, [user?.uid, crewsCache, usersCache]); // crewsCache and usersCache in deps

          return <div>{invitations.length}</div>;
        };

        // Mock Firebase functions
        const onSnapshot = (q: any, cb: any) => { cb({ docs: [] }); return () => {}; };
        const query = (...args: any[]) => ({});
        const collection = (...args: any[]) => ({});
        const db = {};
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // Should NOT be flagged - setCrewsCache/setUsersCache are inside onSnapshot (deferred)
      expect(infiniteLoops).toHaveLength(0);
    });
  });

  describe('onSnapshot with functional updater pattern', () => {
    it('should NOT flag setAllContacts inside onSnapshot as infinite loop', async () => {
      // This pattern was incorrectly flagged as "CONFIRMED infinite loop"
      // Real-time listener callbacks with functional updaters are safe
      const parsed = createTestFile(`
        import React, { useState, useEffect, useRef } from 'react';

        interface User {
          uid: string;
          isOnline?: boolean;
        }

        const ContactsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
          const [allContacts, setAllContacts] = useState<User[]>([]);
          const userSubscriptionsRef = useRef<{ [uid: string]: () => void }>({});
          const user = { uid: 'current-user' };

          useEffect(() => {
            // Subscribe to changes for any contacts that aren't already subscribed.
            allContacts.forEach((contact) => {
              if (!user?.uid) return;
              if (!userSubscriptionsRef.current[contact.uid]) {
                const unsubscribe = onSnapshot(
                  doc(db, 'users', contact.uid),
                  (docSnap) => {
                    if (docSnap.exists()) {
                      const data = docSnap.data();
                      // DEFERRED - inside onSnapshot callback with functional updater
                      setAllContacts((prevContacts) =>
                        prevContacts.map((c) =>
                          c.uid === contact.uid ? { ...c, isOnline: data.isOnline } : c
                        )
                      );
                    }
                  }
                );
                userSubscriptionsRef.current[contact.uid] = unsubscribe;
              }
            });

            // Cleanup subscriptions for contacts no longer in the list
            const currentUids = new Set(allContacts.map((c) => c.uid));
            Object.keys(userSubscriptionsRef.current).forEach((uid) => {
              if (!currentUids.has(uid)) {
                userSubscriptionsRef.current[uid]();
                delete userSubscriptionsRef.current[uid];
              }
            });
          }, [allContacts, user?.uid]);

          return <div>{allContacts.length}</div>;
        };

        // Mock Firebase functions
        const onSnapshot = (ref: any, cb: any) => { cb({ exists: () => true, data: () => ({}) }); return () => {}; };
        const doc = (...args: any[]) => ({});
        const db = {};
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // Should NOT be flagged - setAllContacts is inside onSnapshot with functional updater
      expect(infiniteLoops).toHaveLength(0);
    });
  });

  describe('Combined patterns - multiple async callbacks', () => {
    it('should handle multiple different async callback types in same component', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        const MultiAsyncComponent: React.FC = () => {
          const [data, setData] = useState<any[]>([]);
          const [time, setTime] = useState(new Date());
          const [messages, setMessages] = useState<string[]>([]);

          // Pattern 1: setInterval
          useEffect(() => {
            const interval = setInterval(() => {
              setTime(new Date());
            }, 1000);
            return () => clearInterval(interval);
          }, [time]);

          // Pattern 2: Firebase onSnapshot
          useEffect(() => {
            const unsubscribe = onSnapshot(collection(db, 'items'), (snapshot) => {
              setData(snapshot.docs.map(d => d.data()));
            });
            return () => unsubscribe();
          }, [data]);

          // Pattern 3: Promise.then
          useEffect(() => {
            fetch('/api/messages')
              .then(res => res.json())
              .then(msgs => setMessages(msgs));
          }, [messages]);

          // Pattern 4: setTimeout
          useEffect(() => {
            const timer = setTimeout(() => {
              setData(prev => [...prev, { id: Date.now() }]);
            }, 5000);
            return () => clearTimeout(timer);
          }, [data]);

          return <div>{data.length} items</div>;
        };

        // Mocks
        const onSnapshot = (ref: any, cb: any) => { cb({ docs: [] }); return () => {}; };
        const collection = (...args: any[]) => ({});
        const db = {};
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // None should be flagged as infinite loops - all are deferred
      expect(infiniteLoops).toHaveLength(0);
    });
  });

  describe('Control tests - patterns that SHOULD be flagged', () => {
    it('SHOULD flag direct state modification without async callback', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        const BrokenComponent: React.FC = () => {
          const [count, setCount] = useState(0);

          useEffect(() => {
            // This is NOT inside any async callback - direct modification
            setCount(count + 1); // INFINITE LOOP!
          }, [count]);

          return <div>{count}</div>;
        };
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // SHOULD be flagged - direct modification in useEffect
      expect(infiniteLoops.length).toBeGreaterThan(0);
      expect(infiniteLoops[0].problematicDependency).toBe('count');
    });

    it('SHOULD flag state modification outside of async callback even when async exists', async () => {
      const parsed = createTestFile(`
        import React, { useState, useEffect } from 'react';

        const PartiallyBrokenComponent: React.FC = () => {
          const [count, setCount] = useState(0);
          const [time, setTime] = useState(new Date());

          useEffect(() => {
            // This direct call happens BEFORE the setInterval callback
            setCount(count + 1); // INFINITE LOOP! - direct modification

            // This is fine - inside setInterval
            const interval = setInterval(() => {
              setTime(new Date());
            }, 1000);

            return () => clearInterval(interval);
          }, [count, time]);

          return <div>{count} - {time.toISOString()}</div>;
        };
      `);

      const results = await analyzeHooks([parsed]);
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // SHOULD flag the direct setCount call
      expect(infiniteLoops.length).toBeGreaterThan(0);
      expect(infiniteLoops.some((r) => r.problematicDependency === 'count')).toBe(true);
    });
  });
});
