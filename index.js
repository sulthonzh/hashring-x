'use strict';

/**
 * hashring-x — Zero-dependency consistent hashing.
 *
 * Consistent hashing minimizes key redistribution when nodes are
 * added or removed. Uses virtual nodes (vnodes) for even distribution
 * and an efficient sorted-array + binary search ring.
 *
 * @module hashring-x
 */

const crypto = require('crypto');

/* ------------------------------------------------------------------ *
 * Hash function — uses SHA-1 truncated to 32 bits.
 * SHA-1 is fine for ring hashing (no security requirement).
 * ------------------------------------------------------------------ */
function hash32(input) {
  const buf = crypto.createHash('sha1').update(String(input)).digest();
  return buf.readUInt32BE(0);
}

/**
 * Compute the hash for a key (exposed for testing/inspection).
 * @param {string} key
 * @returns {number} 32-bit unsigned hash
 */
function hash(key) {
  return hash32(key);
}

/* ------------------------------------------------------------------ *
 * Binary search helpers on the ring.
 * ------------------------------------------------------------------ */
function bisectLeft(arr, val) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].h < val) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function bisectRight(arr, val) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].h <= val) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ------------------------------------------------------------------ *
 * HashRing class
 * ------------------------------------------------------------------ */

class HashRing {
  /**
   * Create a consistent hash ring.
   * @param {Object} [opts]
   * @param {number} [opts.vnodes=150] — Virtual nodes per physical node.
   * @param {function(string):number} [opts.hashFn] — Custom hash function.
   */
  constructor(opts = {}) {
    this.vnodes = opts.vnodes ?? 150;
    this.hashFn = opts.hashFn || hash32;
    /** @type {{h:number,node:string}[]} */
    this.ring = []; // sorted by hash
    this.nodes = new Set();
  }

  /**
   * Add a node to the ring.
   * @param {string} node — Node identifier.
   * @returns {this}
   */
  add(node) {
    if (this.nodes.has(node)) return this;
    this.nodes.add(node);
    for (let i = 0; i < this.vnodes; i++) {
      const h = this.hashFn(`${node}:${i}`);
      this._insert({ h, node });
    }
    return this;
  }

  /**
   * Add multiple nodes.
   * @param {string[]} nodes
   * @returns {this}
   */
  addAll(nodes) {
    for (const n of nodes) this.add(n);
    return this;
  }

  /**
   * Remove a node from the ring.
   * @param {string} node
   * @returns {this}
   */
  remove(node) {
    if (!this.nodes.has(node)) return this;
    this.nodes.delete(node);
    this.ring = this.ring.filter(e => e.node !== node);
    return this;
  }

  /**
   * Get the node responsible for a key.
   * Walks forward (wrapping) until it finds a vnode.
   * @param {string} key
   * @returns {string|null} — Node name, or null if ring is empty.
   */
  get(key) {
    if (this.ring.length === 0) return null;
    const h = this.hashFn(key);
    let pos = bisectLeft(this.ring, h);
    if (pos >= this.ring.length) pos = 0;
    return this.ring[pos].node;
  }

  /**
   * Get the top N distinct nodes for a key (for replication).
   * Walks the ring collecting unique nodes.
   * @param {string} key
   * @param {number} count
   * @returns {string[]}
   */
  getReplicas(key, count) {
    if (this.ring.length === 0 || count <= 0) return [];
    const h = this.hashFn(key);
    let pos = bisectLeft(this.ring, h);
    if (pos >= this.ring.length) pos = 0;

    const result = [];
    const seen = new Set();
    const max = Math.min(count, this.nodes.size);
    let steps = 0;
    while (result.length < max && steps < this.ring.length) {
      const entry = this.ring[(pos + steps) % this.ring.length];
      if (!seen.has(entry.node)) {
        seen.add(entry.node);
        result.push(entry.node);
      }
      steps++;
    }
    return result;
  }

  /**
   * List all nodes on the ring.
   * @returns {string[]}
   */
  list() {
    return [...this.nodes];
  }

  /**
   * Number of physical nodes.
   * @returns {number}
   */
  get size() {
    return this.nodes.size;
  }

  /**
   * Compute distribution statistics.
   * Returns the percentage of keys mapped to each node.
   * @param {number} [samples=10000]
   * @returns {{node:string,percent:number,keys:number}[]}
   */
  distribution(samples = 10000) {
    const counts = {};
    for (const n of this.nodes) counts[n] = 0;
    for (let i = 0; i < samples; i++) {
      const node = this.get(`key-${i}`);
      if (node) counts[node]++;
    }
    return Object.entries(counts)
      .map(([node, keys]) => ({ node, keys, percent: +(keys / samples * 100).toFixed(2) }))
      .sort((a, b) => b.keys - a.keys);
  }

  /**
   * Calculate standard deviation of distribution (lower = more even).
   * @param {number} [samples=10000]
   * @returns {number}
   */
  stddev(samples = 10000) {
    const dist = this.distribution(samples);
    if (dist.length === 0) return 0;
    const mean = dist.reduce((s, d) => s + d.keys, 0) / dist.length;
    const variance = dist.reduce((s, d) => s + (d.keys - mean) ** 2, 0) / dist.length;
    return Math.sqrt(variance);
  }

  /**
   * Find which keys would move when a node is added.
   * Useful for data migration planning.
   * @param {string} newNode
   * @param {string[]} keys
   * @returns {{key:string,from:string|null,to:string}[]}
   */
  moves(newNode, keys) {
    const before = keys.map(k => ({ k, node: this.get(k) }));
    // Clone, add new node, check
    const clone = new HashRing({
      vnodes: this.vnodes,
      hashFn: this.hashFn,
    });
    clone.addAll(this.nodes);
    clone.add(newNode);
    return before
      .map(({ k, node }) => {
        const after = clone.get(k);
        return (after !== node) ? { key: k, from: node, to: after } : null;
      })
      .filter(Boolean);
  }

  /** @private — insert maintaining sorted order */
  _insert(entry) {
    let lo = 0, hi = this.ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid].h < entry.h) lo = mid + 1;
      else hi = mid;
    }
    this.ring.splice(lo, 0, entry);
  }
}

/* ------------------------------------------------------------------ *
 * Standalone helpers
 * ------------------------------------------------------------------ */

/**
 * Create a hash ring with nodes pre-added.
 * @param {string[]} nodes
 * @param {Object} [opts]
 * @returns {HashRing}
 */
function createRing(nodes, opts) {
  const ring = new HashRing(opts);
  ring.addAll(nodes);
  return ring;
}

/**
 * Estimate the number of vnodes needed for a target stddev.
 * Rough heuristic — actual results depend on hash function quality.
 * @param {number} nodeCount
 * @param {number} [targetStddevPercent=5]
 * @returns {number}
 */
function estimateVnodes(nodeCount, targetStddevPercent = 5) {
  // Empirical: stddev ≈ 100 / sqrt(vnodes * nodeCount / nodeCount)
  // i.e., stddev% ≈ 100 / sqrt(vnodes)
  const target = Math.max(1, Math.ceil(Math.pow(100 / targetStddevPercent, 2)));
  return Math.min(1000, target);
}

module.exports = {
  HashRing,
  createRing,
  hash,
  estimateVnodes,
};
