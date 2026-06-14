'use strict';

const { HashRing, createRing, hash, estimateVnodes } = require('./index');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error(`FAIL: ${name} - ${e.message}`); }
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || ''} expected ${b}, got ${a}`);
}

/* ---- Basic functionality ---- */

test('empty ring returns null', () => {
  const r = new HashRing();
  assertEqual(r.get('key1'), null);
});

test('single node gets all keys', () => {
  const r = createRing(['node-A']);
  assertEqual(r.get('anything'), 'node-A');
  assertEqual(r.get('whatever'), 'node-A');
});

test('multiple nodes distribute keys', () => {
  const r = createRing(['A', 'B', 'C', 'D']);
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (let i = 0; i < 1000; i++) {
    const node = r.get(`key-${i}`);
    counts[node]++;
  }
  for (const [, count] of Object.entries(counts)) {
    if (count > 400) throw new Error(`node got ${count}/1000, too much`);
  }
});

test('add node after creation', () => {
  const r = new HashRing();
  r.add('X');
  assertEqual(r.size, 1);
  r.add('Y');
  assertEqual(r.size, 2);
});

test('remove node', () => {
  const r = createRing(['A', 'B', 'C']);
  r.remove('B');
  assertEqual(r.size, 2);
  assertEqual(r.list().includes('B'), false);
  for (let i = 0; i < 100; i++) {
    const n = r.get(`k${i}`);
    if (n !== 'A' && n !== 'C') throw new Error(`got ${n}`);
  }
});

test('add duplicate node is no-op', () => {
  const r = createRing(['A']);
  r.add('A');
  assertEqual(r.size, 1);
});

test('remove non-existent node is no-op', () => {
  const r = createRing(['A']);
  r.remove('Z');
  assertEqual(r.size, 1);
});

/* ---- Consistency ---- */

test('same key always maps to same node', () => {
  const r = createRing(['A', 'B', 'C', 'D', 'E']);
  const first = r.get('test-key');
  for (let i = 0; i < 100; i++) {
    assertEqual(r.get('test-key'), first, 'inconsistent');
  }
});

test('removing a node only moves keys from that node', () => {
  const r = createRing(['A', 'B', 'C', 'D']);
  const keys = Array.from({ length: 500 }, (_, i) => `key-${i}`);
  const before = keys.map(k => ({ k, node: r.get(k) }));
  r.remove('B');
  let movedFromB = 0;
  let movedFromOther = 0;
  before.forEach(({ k, node }) => {
    const after = r.get(k);
    if (after !== node) {
      if (node === 'B') movedFromB++;
      else movedFromOther++;
    }
  });
  if (movedFromOther > movedFromB * 0.1 + 5) {
    throw new Error(`too many non-B keys moved: ${movedFromOther}`);
  }
});

test('adding a node moves approximately 1/N of keys', () => {
  const r = createRing(['A', 'B', 'C']);
  const keys = Array.from({ length: 3000 }, (_, i) => `key-${i}`);
  const before = keys.map(k => r.get(k));
  r.add('D');
  let moved = 0;
  keys.forEach((k, i) => {
    if (r.get(k) !== before[i]) moved++;
  });
  const pct = moved / keys.length;
  if (pct < 0.15 || pct > 0.35) {
    throw new Error(`moved ${(pct * 100).toFixed(1)}%, expected ~25%`);
  }
});

/* ---- Replicas ---- */

test('getReplicas returns distinct nodes', () => {
  const r = createRing(['A', 'B', 'C', 'D', 'E']);
  const replicas = r.getReplicas('my-key', 3);
  assertEqual(replicas.length, 3);
  assertEqual(new Set(replicas).size, 3);
});

test('getReplicas handles count > nodes', () => {
  const r = createRing(['A', 'B']);
  assertEqual(r.getReplicas('x', 5).length, 2);
});

test('getReplicas with count 0', () => {
  const r = createRing(['A', 'B']);
  assertEqual(r.getReplicas('x', 0).length, 0);
});

/* ---- Distribution quality ---- */

test('distribution is reasonably even', () => {
  const r = createRing(['A', 'B', 'C', 'D', 'E'], { vnodes: 150 });
  const dist = r.distribution(20000);
  for (const d of dist) {
    if (d.percent < 10 || d.percent > 30) {
      throw new Error(`${d.node}: ${d.percent}% outside 10-30%`);
    }
  }
});

test('stddev is low for balanced ring', () => {
  const r = createRing(['A', 'B', 'C', 'D'], { vnodes: 200 });
  const sd = r.stddev(20000);
  if (sd > 500) throw new Error(`stddev ${sd} too high`);
});

test('more vnodes = better distribution', () => {
  const low = createRing(['A', 'B', 'C', 'D'], { vnodes: 10 });
  const high = createRing(['A', 'B', 'C', 'D'], { vnodes: 500 });
  if (low.stddev(20000) <= high.stddev(20000)) {
    throw new Error('low vnodes should have higher stddev');
  }
});

/* ---- Moves prediction ---- */

test('moves returns expected structure', () => {
  const r = createRing(['A', 'B', 'C']);
  const keys = ['k1', 'k2', 'k3', 'k4', 'k5'];
  const moves = r.moves('D', keys);
  for (const m of moves) {
    assertEqual(typeof m.key, 'string');
    assertEqual(m.to, 'D');
  }
});

test('moves only shows keys going to new node', () => {
  const r = createRing(['A', 'B', 'C', 'D']);
  const keys = Array.from({ length: 500 }, (_, i) => `key-${i}`);
  const moves = r.moves('E', keys);
  for (const m of moves) assertEqual(m.to, 'E');
});

/* ---- Custom hash function ---- */

test('custom hash function works', () => {
  let callCount = 0;
  const customFn = (str) => {
    callCount++;
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  };
  const r = new HashRing({ hashFn: customFn, vnodes: 50 });
  r.addAll(['X', 'Y']);
  const node = r.get('test');
  assertEqual(callCount > 0, true);
  assertEqual(node === 'X' || node === 'Y', true);
});

/* ---- hash() utility ---- */

test('hash returns consistent 32-bit value', () => {
  const h1 = hash('hello');
  const h2 = hash('hello');
  assertEqual(h1, h2);
  assertEqual(h1 >= 0, true);
  assertEqual(h1 <= 0xFFFFFFFF, true);
});

test('different keys produce different hashes', () => {
  assertEqual(hash('foo') !== hash('bar'), true);
});

/* ---- estimateVnodes ---- */

test('estimateVnodes returns reasonable value', () => {
  const v = estimateVnodes(5, 5);
  assertEqual(v >= 100, true);
  assertEqual(v <= 1000, true);
});

test('estimateVnodes lower tolerance = more vnodes', () => {
  assertEqual(estimateVnodes(5, 2) > estimateVnodes(5, 10), true);
});

/* ---- Edge cases ---- */

test('empty key', () => {
  const r = createRing(['A', 'B']);
  const node = r.get('');
  assertEqual(node === 'A' || node === 'B', true);
});

test('single char keys', () => {
  const r = createRing(['A', 'B', 'C']);
  for (let i = 32; i < 127; i++) {
    const n = r.get(String.fromCharCode(i));
    assertEqual(typeof n, 'string');
  }
});

test('list returns all nodes', () => {
  const r = createRing(['X', 'Y', 'Z']);
  assertEqual(r.list().sort().join(','), 'X,Y,Z');
});

test('remove all nodes', () => {
  const r = createRing(['A', 'B']);
  r.remove('A');
  r.remove('B');
  assertEqual(r.size, 0);
  assertEqual(r.get('key'), null);
});

test('re-add removed node restores mapping', () => {
  const r = createRing(['A', 'B', 'C']);
  const before = r.get('test-key');
  r.remove('A');
  r.add('A');
  assertEqual(r.get('test-key'), before);
});

/* ---- Scale ---- */

test('handles 100 nodes', () => {
  const nodes = Array.from({ length: 100 }, (_, i) => `node-${i}`);
  const r = createRing(nodes);
  assertEqual(r.size, 100);
  assertEqual(nodes.includes(r.get('some-key')), true);
});

test('10000 lookups complete', () => {
  const r = createRing(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  for (let i = 0; i < 10000; i++) r.get(`lookup-${i}`);
});

/* ---- Report ---- */

console.log(`\n${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed > 0) process.exit(1);
