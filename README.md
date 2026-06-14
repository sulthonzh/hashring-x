# hashring-x

Zero-dependency consistent hashing for Node.js. Distribute keys across nodes with minimal redistribution when nodes join or leave.

## Why?

When you're sharding a cache, load-balancing across workers, or partitioning a database, you need to map keys to servers. A naive `key % N` approach remaps nearly **all** keys when a node joins or leaves. Consistent hashing remaps only **~1/N** — a dramatic improvement.

```
key % N approach:     Add 1 node → ~100% of keys remapped
consistent hashing:   Add 1 node → ~1/N of keys remapped
```

## Install

```bash
npm install hashring-x
```

## Quick start

```js
const { createRing } = require('hashring-x');

// Create a ring with 3 cache servers
const ring = createRing(['cache-1', 'cache-2', 'cache-3']);

// Route keys
ring.get('user:42');     // → 'cache-2'
ring.get('user:99');     // → 'cache-1'

// Add a new server — most keys stay put
ring.add('cache-4');
ring.get('user:42');     // still 'cache-2' (probably)
```

## Replication

Get the top N nodes for a key — useful for multi-replica writes:

```js
ring.getReplicas('user:42', 3);
// → ['cache-2', 'cache-1', 'cache-3']
```

## Migration planning

Predict which keys will move before you add a node:

```js
const keys = ['user:1', 'user:2', 'user:3'];
const moves = ring.moves('cache-4', keys);
// → [{ key: 'user:2', from: 'cache-1', to: 'cache-4' }]
```

## Distribution analysis

Check how evenly keys are spread:

```js
ring.distribution(10000);
// → [
//   { node: 'cache-1', keys: 3345, percent: 33.45 },
//   { node: 'cache-2', keys: 3320, percent: 33.20 },
//   { node: 'cache-3', keys: 3335, percent: 33.35 }
// ]

ring.stddev(10000);  // → 12.4 (lower = more even)
```

## API

### `new HashRing(opts?)`
- `opts.vnodes` (default `150`) — virtual nodes per physical node. More = better distribution, slightly more memory.
- `opts.hashFn` — custom hash function `(string) => number`. Defaults to SHA-1 truncated to 32 bits.

### `ring.add(node)` / `ring.addAll(nodes)` / `ring.remove(node)`
Mutate the ring. Chainable.

### `ring.get(key)` → `string | null`
Primary node for a key.

### `ring.getReplicas(key, count)` → `string[]`
Up to `count` distinct nodes, in ring-walk order.

### `ring.moves(newNode, keys)` → `{ key, from, to }[]`
Keys that would move if `newNode` were added.

### `ring.distribution(samples?)` → `{ node, keys, percent }[]`
### `ring.stddev(samples?)` → `number`

### `createRing(nodes, opts?)` → `HashRing`
Shorthand constructor + addAll.

### `hash(key)` → `number`
Expose the default hash function.

### `estimateVnodes(nodeCount, targetStddevPercent?)` → `number`
Heuristic for choosing vnode count.

## How it works

1. Each node is placed on the ring at `vnodes` positions (e.g., `cache-1:0`, `cache-1:1`, ..., `cache-1:149`).
2. To find a key's node, hash the key and walk clockwise to the next position on the ring.
3. Binary search keeps lookups at O(log N) where N = total vnodes.

Virtual nodes prevent clustering when hash values aren't perfectly uniform. The default 150 vnodes gives ~8% standard deviation across 5 nodes. Bump to 300-500 for very large clusters.

## License

MIT
