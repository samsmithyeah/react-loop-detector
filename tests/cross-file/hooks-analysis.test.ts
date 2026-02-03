import { analyzeHooks } from '../../src/orchestrator';
import { parseFile } from '../../src/parser';
import * as path from 'path';
import * as fs from 'fs';

describe('Cross-File React Hooks Analysis', () => {
  const testDir = path.join(__dirname, '..', 'fixtures', 'cross-file-hooks');

  beforeAll(() => {
    // Create test fixtures directory and files
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    // Create test component with cross-file dependency
    const componentContent = `import React, { useEffect, useState } from 'react';
import { updateUserData, processUserProfile } from './test-utils';

// Component with direct cross-file state modification
export function DirectCrossFileComponent() {
  const [user, setUser] = useState({ id: 1, name: 'John' });

  useEffect(() => {
    if (user.id) {
      updateUserData(user, setUser); // Calls imported function that modifies state
    }
  }, [user]); // This creates infinite loop through cross-file call

  return <div>User: {user.name}</div>;
}

// Component with nested cross-file state modification
export function NestedCrossFileComponent() {
  const [profile, setProfile] = useState({ id: 1, name: 'Jane' });

  useEffect(() => {
    if (profile.id) {
      processUserProfile(profile, setProfile); // Calls function that calls another function
    }
  }, [profile]); // This should also be caught via nested call chain

  return <div>Profile: {profile.name}</div>;
}

// Safe component - only reads state, doesn't modify through cross-file calls
export function SafeCrossFileComponent() {
  const [data, setData] = useState({ value: 42 });

  useEffect(() => {
    if (data.value > 0) {
      console.log('Data value:', data.value); // Only reads, no cross-file modifications
    }
  }, [data]); // This should be safe

  return <div>Data: {data.value}</div>;
}`;

    // Create test utility functions that modify state
    const utilsContent = `// Utility functions that modify state through parameters
export function updateUserData(user: any, setUser: (user: any) => void) {
  // This directly modifies the user state via the passed setter
  setUser({ ...user, lastUpdated: new Date() });
}

export function refreshUserProfile(userData: any, updateFunc: (data: any) => void) {
  // This also modifies state through the passed function
  updateFunc({ ...userData, refreshed: true });
}

// Nested function call chain that eventually modifies state
export function processUserProfile(profile: any, setProfile: (profile: any) => void) {
  setProfile({ ...profile, lastProcessed: new Date() });
}

// Function that calls other functions (testing call chain detection)
export function processUserUpdate(user: any, setUser: (user: any) => void) {
  updateUserData(user, setUser); // Calls updateUserData which modifies state
}

// Safe utility function that doesn't modify state
export function formatUserName(user: any): string {
  return \`\${user.name} (\${user.id})\`;
}`;

    // Create safe component for comparison
    const safeComponentContent = `import React, { useEffect, useState } from 'react';
import { formatUserName } from './test-utils';

// Component that uses cross-file functions but doesn't create infinite loops
export function SafeImportComponent() {
  const [user, setUser] = useState({ id: 1, name: 'Safe' });

  useEffect(() => {
    // This only calls a function that reads state, doesn't modify it
    const formatted = formatUserName(user);
    console.log('Formatted name:', formatted);
  }, [user]); // Safe because formatUserName doesn't modify state

  const handleClick = () => {
    setUser({ id: 2, name: 'Updated' }); // Manual update, not in dependency loop
  };

  return <div onClick={handleClick}>User: {user.name}</div>;
}`;

    fs.writeFileSync(path.join(testDir, 'cross-file-component.tsx'), componentContent);
    fs.writeFileSync(path.join(testDir, 'test-utils.ts'), utilsContent);
    fs.writeFileSync(path.join(testDir, 'safe-component.tsx'), safeComponentContent);
  });

  afterAll(() => {
    // Clean up test files
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Direct Cross-File State Modifications', () => {
    it('should detect infinite loops caused by direct cross-file state modifications', async () => {
      const componentFile = path.join(testDir, 'cross-file-component.tsx');
      const parsedFile = parseFile(componentFile);
      const results = await analyzeHooks([parsedFile]);

      // Should detect the direct cross-file infinite loop
      const crossFileLoops = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' && r.file.includes('cross-file-component.tsx')
      );

      expect(crossFileLoops.length).toBeGreaterThanOrEqual(1);

      // Check the direct modification case
      const directLoop = crossFileLoops.find(
        (r) => r.problematicDependency === 'user' && r.setterFunction === 'setUser'
      );

      expect(directLoop).toBeDefined();
      expect(directLoop!.severity).toBe('high');
      expect(directLoop!.confidence).toBe('high');
      expect(directLoop!.explanation).toContain('infinite loop');
    });

    it('should detect nested cross-file state modifications', async () => {
      const componentFile = path.join(testDir, 'cross-file-component.tsx');
      const parsedFile = parseFile(componentFile);
      const results = await analyzeHooks([parsedFile]);

      // Should detect the nested cross-file infinite loop
      const nestedLoop = results.find(
        (r) =>
          r.type === 'confirmed-infinite-loop' &&
          r.problematicDependency === 'profile' &&
          r.setterFunction === 'setProfile'
      );

      expect(nestedLoop).toBeDefined();
      expect(nestedLoop!.severity).toBe('high');
      expect(nestedLoop!.confidence).toBe('high');
      expect(nestedLoop!.explanation).toContain('infinite loop');
    });

    it('should provide detailed information about cross-file modifications', async () => {
      const componentFile = path.join(testDir, 'cross-file-component.tsx');
      const parsedFile = parseFile(componentFile);
      const results = await analyzeHooks([parsedFile]);

      const crossFileLoop = results.find(
        (r) => r.type === 'confirmed-infinite-loop' && r.problematicDependency === 'user'
      );

      expect(crossFileLoop).toBeDefined();
      expect(crossFileLoop!.file).toBe(componentFile);
      expect(crossFileLoop!.line).toBeGreaterThan(0);
      expect(crossFileLoop!.hookType).toBe('useEffect');
      expect(crossFileLoop!.actualStateModifications).toContain('setUser');
      expect(crossFileLoop!.stateReads).toContain('user');
    });
  });

  describe('Safe Cross-File Patterns', () => {
    it('should not flag safe cross-file function calls', async () => {
      const safeComponentFile = path.join(testDir, 'safe-component.tsx');
      const parsedFile = parseFile(safeComponentFile);
      const results = await analyzeHooks([parsedFile]);

      // Should not detect any infinite loops in safe component
      const infiniteLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');
      expect(infiniteLoops).toHaveLength(0);

      // Safe patterns are not output in CLI, so this might be empty
    });

    it('should handle cross-file imports that do not modify state', async () => {
      const componentFile = path.join(testDir, 'cross-file-component.tsx');
      const parsedFile = parseFile(componentFile);
      const results = await analyzeHooks([parsedFile]);

      // The safe component in the same file should not trigger false positives
      const safeComponentIssues = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' && r.problematicDependency === 'data' // from SafeCrossFileComponent
      );

      expect(safeComponentIssues).toHaveLength(0);
    });
  });

  describe('Cross-File Analysis Integration', () => {
    it('should expand file analysis to include imported utilities', async () => {
      const componentFile = path.join(testDir, 'cross-file-component.tsx');
      const parsedFile = parseFile(componentFile);

      // Should not throw and should analyze cross-file relationships
      expect(() => {
        analyzeHooks([parsedFile]);
      }).not.toThrow();

      const results = await analyzeHooks([parsedFile]);

      // Should have found cross-file modifications
      const hasIntelligentResults = results.length > 0;
      expect(hasIntelligentResults).toBe(true);
    });

    it('should trace function call chains across files', async () => {
      const componentFile = path.join(testDir, 'cross-file-component.tsx');
      const parsedFile = parseFile(componentFile);
      const results = await analyzeHooks([parsedFile]);

      // Should detect both direct and nested modifications
      const confirmedLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');
      expect(confirmedLoops.length).toBeGreaterThanOrEqual(2);

      // Should include both user and profile state modifications
      const dependencies = confirmedLoops.map((r) => r.problematicDependency);
      expect(dependencies).toContain('user');
      expect(dependencies).toContain('profile');
    });

    it('should handle multiple files with cross-file dependencies', async () => {
      const componentFile = path.join(testDir, 'cross-file-component.tsx');
      const safeComponentFile = path.join(testDir, 'safe-component.tsx');

      const parsedFiles = [parseFile(componentFile), parseFile(safeComponentFile)];

      const results = await analyzeHooks(parsedFiles);

      // Should detect issues in problematic file but not in safe file
      const componentIssues = results.filter(
        (r) => r.file === componentFile && r.type === 'confirmed-infinite-loop'
      );
      const safeFileIssues = results.filter(
        (r) => r.file === safeComponentFile && r.type === 'confirmed-infinite-loop'
      );

      expect(componentIssues.length).toBeGreaterThan(0);
      expect(safeFileIssues.length).toBe(0);
    });
  });

  describe('Function Parameter Analysis', () => {
    it('should detect state setters passed as function parameters', async () => {
      const componentFile = path.join(testDir, 'cross-file-component.tsx');
      const parsedFile = parseFile(componentFile);
      const results = await analyzeHooks([parsedFile]);

      const crossFileLoop = results.find(
        (r) => r.type === 'confirmed-infinite-loop' && r.problematicDependency === 'user'
      );

      expect(crossFileLoop).toBeDefined();

      // Should identify that setUser is being passed to external function
      expect(crossFileLoop!.actualStateModifications).toContain('setUser');
      expect(crossFileLoop!.explanation).toContain('infinite loop');
    });

    it('should distinguish between different setter functions', async () => {
      const componentFile = path.join(testDir, 'cross-file-component.tsx');
      const parsedFile = parseFile(componentFile);
      const results = await analyzeHooks([parsedFile]);

      const confirmedLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // Should have separate detections for setUser and setProfile
      const setterFunctions = confirmedLoops.map((r) => r.setterFunction);
      expect(setterFunctions).toContain('setUser');
      expect(setterFunctions).toContain('setProfile');
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle files with syntax errors gracefully', async () => {
      const invalidFile = path.join(testDir, 'invalid-syntax.tsx');
      fs.writeFileSync(invalidFile, 'import React from "react"; const broken = [;');

      expect(() => {
        const parsedFile = parseFile(invalidFile);
        analyzeHooks([parsedFile]);
      }).toThrow(); // parseFile should throw, but if it doesn't, analyzer should handle gracefully

      // Clean up
      fs.unlinkSync(invalidFile);
    });

    it('should handle missing import files gracefully', async () => {
      const componentWithMissingImport = path.join(testDir, 'missing-import.tsx');
      const content = `import React, { useEffect, useState } from 'react';
import { nonExistentFunction } from './non-existent-file';

export function ComponentWithMissingImport() {
  const [data, setData] = useState('test');
  
  useEffect(() => {
    console.log(data);
  }, [data]);
  
  return <div>{data}</div>;
}`;

      fs.writeFileSync(componentWithMissingImport, content);

      const parsedFile = parseFile(componentWithMissingImport);

      expect(() => {
        analyzeHooks([parsedFile]);
      }).not.toThrow();

      const results = await analyzeHooks([parsedFile]);

      // Should not crash and should return some analysis
      expect(Array.isArray(results)).toBe(true);

      // Clean up
      fs.unlinkSync(componentWithMissingImport);
    });

    it('should handle empty files gracefully', async () => {
      const emptyFile = path.join(testDir, 'empty.tsx');
      fs.writeFileSync(emptyFile, '');

      expect(() => {
        const parsedFile = parseFile(emptyFile);
        analyzeHooks([parsedFile]);
      }).not.toThrow();

      // Clean up
      fs.unlinkSync(emptyFile);
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle multiple cross-file dependencies efficiently', async () => {
      const componentFile = path.join(testDir, 'cross-file-component.tsx');
      const safeComponentFile = path.join(testDir, 'safe-component.tsx');

      const parsedFiles = [parseFile(componentFile), parseFile(safeComponentFile)];

      const startTime = Date.now();
      const results = await analyzeHooks(parsedFiles);
      const endTime = Date.now();

      // Should complete analysis in reasonable time (less than 5 seconds)
      expect(endTime - startTime).toBeLessThan(5000);
      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });

    it('should not create infinite recursion in function call tracing', async () => {
      // This test ensures our function call tracing doesn't get stuck in loops
      const componentFile = path.join(testDir, 'cross-file-component.tsx');
      const parsedFile = parseFile(componentFile);

      // Should complete without hanging
      const results = await analyzeHooks([parsedFile]);
      expect(results).toBeDefined();
    });
  });

  describe('Aliased Import Resolution', () => {
    const aliasTestDir = path.join(__dirname, '..', 'fixtures', 'aliased-imports');

    beforeAll(() => {
      if (!fs.existsSync(aliasTestDir)) {
        fs.mkdirSync(aliasTestDir, { recursive: true });
      }

      // Create component with aliased imports
      const aliasedComponentContent = `import React, { useEffect, useState } from 'react';
import { updateUserData as refreshData, processUserProfile as handleProfile } from './alias-utils';

// Component using aliased import - should still detect infinite loop
export function AliasedImportComponent() {
  const [user, setUser] = useState({ id: 1, name: 'John' });

  useEffect(() => {
    if (user.id) {
      // Calling the aliased function - should resolve to updateUserData
      refreshData(user, setUser);
    }
  }, [user]); // Infinite loop through aliased cross-file call

  return <div>User: {user.name}</div>;
}

// Component using another aliased import
export function AnotherAliasedComponent() {
  const [profile, setProfile] = useState({ id: 2, name: 'Jane' });

  useEffect(() => {
    if (profile.id) {
      handleProfile(profile, setProfile);
    }
  }, [profile]); // Infinite loop through aliased cross-file call

  return <div>Profile: {profile.name}</div>;
}`;

      // Create utility functions (same as the main test but for clarity)
      const aliasUtilsContent = `// Utility functions that modify state through parameters
export function updateUserData(user: any, setUser: (user: any) => void) {
  setUser({ ...user, lastUpdated: new Date() });
}

export function processUserProfile(profile: any, setProfile: (profile: any) => void) {
  setProfile({ ...profile, lastProcessed: new Date() });
}`;

      fs.writeFileSync(path.join(aliasTestDir, 'aliased-component.tsx'), aliasedComponentContent);
      fs.writeFileSync(path.join(aliasTestDir, 'alias-utils.ts'), aliasUtilsContent);
    });

    afterAll(() => {
      if (fs.existsSync(aliasTestDir)) {
        fs.rmSync(aliasTestDir, { recursive: true, force: true });
      }
    });

    it('should detect infinite loops when functions are imported with aliases', async () => {
      const componentFile = path.join(aliasTestDir, 'aliased-component.tsx');
      const parsedFile = parseFile(componentFile);
      const results = await analyzeHooks([parsedFile]);

      // Should detect the infinite loop despite the alias
      const aliasedLoops = results.filter(
        (r) => r.type === 'confirmed-infinite-loop' && r.file.includes('aliased-component.tsx')
      );

      expect(aliasedLoops.length).toBeGreaterThanOrEqual(1);

      // Check for the user state loop
      const userLoop = aliasedLoops.find(
        (r) => r.problematicDependency === 'user' && r.setterFunction === 'setUser'
      );

      expect(userLoop).toBeDefined();
      expect(userLoop!.severity).toBe('high');
      expect(userLoop!.confidence).toBe('high');
    });

    it('should resolve multiple aliased imports correctly', async () => {
      const componentFile = path.join(aliasTestDir, 'aliased-component.tsx');
      const parsedFile = parseFile(componentFile);
      const results = await analyzeHooks([parsedFile]);

      const confirmedLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // Should detect both aliased import loops
      const dependencies = confirmedLoops.map((r) => r.problematicDependency);
      expect(dependencies).toContain('user');
      expect(dependencies).toContain('profile');
    });

    it('should handle mix of aliased and non-aliased imports', async () => {
      const mixedComponentContent = `import React, { useEffect, useState } from 'react';
import { updateUserData as refreshData, processUserProfile } from './alias-utils';

export function MixedImportComponent() {
  const [user, setUser] = useState({ id: 1, name: 'Mixed' });
  const [profile, setProfile] = useState({ id: 2, name: 'Direct' });

  // Aliased import call
  useEffect(() => {
    if (user.id) {
      refreshData(user, setUser);
    }
  }, [user]);

  // Non-aliased import call
  useEffect(() => {
    if (profile.id) {
      processUserProfile(profile, setProfile);
    }
  }, [profile]);

  return <div>User: {user.name}, Profile: {profile.name}</div>;
}`;

      const mixedFile = path.join(aliasTestDir, 'mixed-component.tsx');
      fs.writeFileSync(mixedFile, mixedComponentContent);

      const parsedFile = parseFile(mixedFile);
      const results = await analyzeHooks([parsedFile]);

      const confirmedLoops = results.filter((r) => r.type === 'confirmed-infinite-loop');

      // Should detect both loops
      expect(confirmedLoops.length).toBeGreaterThanOrEqual(2);

      const dependencies = confirmedLoops.map((r) => r.problematicDependency);
      expect(dependencies).toContain('user');
      expect(dependencies).toContain('profile');

      // Clean up
      fs.unlinkSync(mixedFile);
    });
  });
});
