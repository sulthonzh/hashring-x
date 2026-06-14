#!/usr/bin/env node
'use strict';

const { HashRing, createRing, hash, estimateVnodes } = require('./index');

function usage() {
  console.log(`Usage: hashring-x <command> [options]

Commands:
  get <key> [--nodes a,b,c]      Which node owns this key?
  replicas <key> <n> [--nodes]   Top N nodes for replication
  dist [--nodes a,b,c] [--samples N]  Distribution analysis
  moves <newNode> [--nodes a,b,c] [--keys k1,k2]
                                  Which keys move when adding newNode?
  vnodes <nodeCount> [--target P]  Estimate ideal vnode count
  hash <key>                     Show hash value

Options:
  --nodes <csv>    Comma-separated node list (default: A,B,C,D)
  --vnodes <n>     Virtual nodes per physical node (default: 150)
  --samples <n>    Sample size for distribution (default: 10000)
  --target <pct>   Target stddev percent for vnodes estimate (default: 5)
  --json           Output as JSON
  --keys <csv>     Comma-separated keys for moves command

Examples:
  hashring-x get "user:42" --nodes cache-1,cache-2,cache-3
  hashring-x dist --nodes A,B,C,D,E --json
  hashring-x replicas "post:99" 2 --nodes N1,N2,N3,N4
`);
}

function parseArgs(argv) {
  const args = { _: [], opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) {
        args.opts[key] = val;
        i++;
      } else {
        args.opts[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (!cmd || cmd === 'help' || cmd === '--help') {
  usage();
  process.exit(0);
}

const nodes = (args.opts.nodes || 'A,B,C,D').split(',');
const vnodes = parseInt(args.opts.vnodes) || 150;
const asJson = !!args.opts.json;

function out(data) {
  if (asJson) console.log(JSON.stringify(data, null, 2));
  else if (typeof data === 'string') console.log(data);
  else console.log(data);
}

switch (cmd) {
  case 'get': {
    const key = args._[1];
    if (!key) { console.error('Error: key required'); process.exit(1); }
    const ring = createRing(nodes, { vnodes });
    const node = ring.get(key);
    out(asJson ? { key, node } : node);
    break;
  }
  case 'replicas': {
    const key = args._[1];
    const count = parseInt(args._[2]);
    if (!key || !count) { console.error('Usage: replicas <key> <count>'); process.exit(1); }
    const ring = createRing(nodes, { vnodes });
    const replicas = ring.getReplicas(key, count);
    out(asJson ? { key, count, replicas } : replicas.join(','));
    break;
  }
  case 'dist': {
    const samples = parseInt(args.opts.samples) || 10000;
    const ring = createRing(nodes, { vnodes });
    const dist = ring.distribution(samples);
    const sd = ring.stddev(samples);
    if (asJson) {
      out({ nodes: nodes.length, vnodes, samples, distribution: dist, stddev: +sd.toFixed(2) });
    } else {
      console.log(`Nodes: ${nodes.length} | VNodes: ${vnodes} | Samples: ${samples}`);
      console.log(`StdDev: ${sd.toFixed(2)}\n`);
      const bar = (pct) => '█'.repeat(Math.round(pct / 2));
      for (const d of dist) {
        console.log(`  ${d.node.padEnd(20)} ${bar(d.percent).padEnd(25)} ${d.percent.toFixed(2)}% (${d.keys})`);
      }
    }
    break;
  }
  case 'moves': {
    const newNode = args._[1];
    if (!newNode) { console.error('Error: newNode required'); process.exit(1); }
    const keyList = (args.opts.keys || '').split(',').filter(Boolean);
    if (keyList.length === 0) {
      console.error('Error: provide --keys k1,k2,...');
      process.exit(1);
    }
    const ring = createRing(nodes, { vnodes });
    const moves = ring.moves(newNode, keyList);
    if (asJson) {
      out({ newNode, totalKeys: keyList.length, movedKeys: moves.length, moves });
    } else {
      console.log(`Adding "${newNode}" would move ${moves.length}/${keyList.length} keys:`);
      for (const m of moves) {
        console.log(`  ${m.key}: ${m.from} → ${m.to}`);
      }
    }
    break;
  }
  case 'vnodes': {
    const nodeCount = parseInt(args._[1]);
    if (!nodeCount) { console.error('Usage: vnodes <nodeCount>'); process.exit(1); }
    const target = parseFloat(args.opts.target) || 5;
    const result = estimateVnodes(nodeCount, target);
    out(asJson ? { nodeCount, targetStddev: target, recommendedVnodes: result } : `Recommended vnodes: ${result}`);
    break;
  }
  case 'hash': {
    const key = args._[1];
    if (!key) { console.error('Error: key required'); process.exit(1); }
    const h = hash(key);
    out(asJson ? { key, hash: h } : h.toString());
    break;
  }
  default:
    console.error(`Unknown command: ${cmd}`);
    usage();
    process.exit(1);
}
