#!/usr/bin/env node
/**
 * dft-assemble.mjs
 *
 * Deterministic assembly for /understand-dft. Takes the per-stage JSON files that
 * the dft-stage-analyzer agent wrote (dft-stage-<id>.json, plus dft-stage-H.json for
 * the hierarchy / strategy pass) and produces the final knowledge-graph.json.
 *
 * What it guarantees (so the agent does not have to):
 *   - Command-step nodes are typed "concept" (the dashboard hides "function" nodes
 *     unless the Classes + Functions toggles are on), get ids, a `contains` edge from
 *     their dofile and `triggers` edges between consecutive steps.
 *   - Any leftover "function" node from the agent is converted to "concept".
 *   - One layer per stage: that stage's files, steps, concepts and generated artifacts.
 *     The hierarchy / strategy file becomes its own layer. Every node is in exactly one layer.
 *   - Dangling edges are dropped and reported; duplicate ids/edges are merged.
 *   - A deterministic tour (hierarchy first, then one step per stage).
 *   - A report of inferred nodes and partially-read files, so uncertainty is visible.
 *
 * Usage:
 *   node dft-assemble.mjs <projectRoot> [--name "<project name>"] [--inventory <dft-inventory.json>]
 *
 * Reads:  <uaDir>/intermediate/dft-stage-*.json
 * Writes: <uaDir>/knowledge-graph.json, <uaDir>/meta.json, <uaDir>/dft-assemble-report.json
 *         (an existing knowledge-graph.json is first copied to knowledge-graph.prev.json)
 *
 * Exit code 0 on success (even with warnings); 1 on unrecoverable input problems.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { addTsdbStructure } from './tsdb-structure.mjs';

const argv = process.argv.slice(2);
const pos = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i++; } else pos.push(argv[i]);
}
if (pos.length < 1) {
  console.error('Usage: node dft-assemble.mjs <projectRoot> [--name N] [--inventory path]');
  process.exit(2);
}
const ROOT = pos[0].replace(/[\\/]+$/, '');
const UA_DIR = existsSync(join(ROOT, '.understand-anything')) ? join(ROOT, '.understand-anything') : join(ROOT, '.ua');
const INTER = join(UA_DIR, 'intermediate');

const VALID_TYPES = new Set(['file', 'function', 'class', 'module', 'concept', 'config', 'document', 'service', 'table', 'endpoint', 'pipeline', 'schema', 'resource']);
const COMPLEXITIES = new Set(['simple', 'moderate', 'complex']);
const report = { stages: [], droppedEdges: [], convertedFunctions: 0, duplicateNodes: [], inferred: [], partialReads: [], warnings: [] };

if (!existsSync(INTER)) { console.error(`dft-assemble: ${INTER} not found`); process.exit(1); }
const stageFiles = readdirSync(INTER).filter((f) => /^dft-stage-.+\.json$/.test(f));
if (stageFiles.length === 0) { console.error('dft-assemble: no dft-stage-*.json files found'); process.exit(1); }

function stageOrder(id) { return id === 'H' ? -1 : Number(id) || 1e6; }
const stages = stageFiles.map((f) => {
  let data;
  try { data = JSON.parse(readFileSync(join(INTER, f), 'utf8')); } catch (e) { console.error(`dft-assemble: ${f} is not valid JSON: ${e.message}`); process.exit(1); }
  const id = String(data.stage ?? f.match(/^dft-stage-(.+)\.json$/)[1]);
  return { id, file: f, name: data.stageName || (id === 'H' ? 'Hierarchy and Test Strategy' : `Stage ${id}`), summary: data.stageSummary || '', nodes: data.nodes || [], edges: data.edges || [], tourNodeIds: data.tourNodeIds || [] };
}).sort((a, b) => stageOrder(a.id) - stageOrder(b.id));

const nodesById = new Map();
const layerOf = new Map();
const edges = [];
const stepsByParent = new Map();

for (const st of stages) {
  for (const raw of st.nodes) {
    const n = { ...raw };
    if (n.kind === 'step') {
      if (!n.parentFile || !n.key) { report.warnings.push(`step without parentFile/key in ${st.file}: ${n.name || '?'}`); continue; }
      n.id = n.id || `concept:step:${n.parentFile}:${n.key}`;
      n.type = 'concept';
      n.filePath = n.filePath || n.parentFile;
      n.tags = [...new Set([...(n.tags || []), 'command-step'])];
      if (!stepsByParent.has(n.parentFile)) stepsByParent.set(n.parentFile, []);
      stepsByParent.get(n.parentFile).push(n);
    }
    if (!n.id) { report.warnings.push(`node without id in ${st.file}: ${n.name || '?'}`); continue; }
    if (n.type === 'function') { n.type = 'concept'; report.convertedFunctions++; }
    if (!VALID_TYPES.has(n.type)) { report.warnings.push(`unknown type "${n.type}" on ${n.id}; set to concept`); n.type = 'concept'; }
    if (!n.name) n.name = n.id.split(/[:/]/).pop();
    if (!n.summary) { n.summary = 'No summary available'; report.warnings.push(`no summary: ${n.id}`); }
    if (!Array.isArray(n.tags) || n.tags.length === 0) n.tags = ['untagged'];
    if (!COMPLEXITIES.has(n.complexity)) n.complexity = n.kind === 'step' ? 'moderate' : 'complex';
    if (n.inferred) { report.inferred.push(n.id); if (!n.tags.includes('inferred')) n.tags.push('inferred'); }
    if (n.readCoverage && n.readCoverage !== 'full') { report.partialReads.push({ id: n.id, readCoverage: n.readCoverage }); if (!n.tags.includes('partial-read')) n.tags.push('partial-read'); }
    // strip agent-only bookkeeping fields before they reach the dashboard schema
    for (const k of ['kind', 'parentFile', 'order', 'key', 'inferred', 'readCoverage']) delete n[k];
    if (nodesById.has(n.id)) { report.duplicateNodes.push(n.id); nodesById.set(n.id, { ...nodesById.get(n.id), ...n }); }
    else { nodesById.set(n.id, n); layerOf.set(n.id, st.id); }
  }
  for (const e of st.edges) edges.push({ ...e });
}

// automatic structure edges for command steps
// (re-scan raw nodes to keep `order`, which was stripped above)
for (const st of stages) {
  const byParent = new Map();
  for (const raw of st.nodes) {
    if (raw.kind !== 'step' || !raw.parentFile || !raw.key) continue;
    if (!byParent.has(raw.parentFile)) byParent.set(raw.parentFile, []);
    byParent.get(raw.parentFile).push(raw);
  }
  for (const [parent, list] of byParent) {
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const parentId = parent.startsWith('file:') ? parent : `file:${parent}`;
    let prev = null;
    for (const s of list) {
      const id = s.id || `concept:step:${s.parentFile}:${s.key}`;
      edges.push({ source: parentId, target: id, type: 'contains', direction: 'forward', weight: 1, description: 'command step in this dofile' });
      if (prev) edges.push({ source: prev, target: id, type: 'triggers', direction: 'forward', weight: 0.4, description: 'runs after previous step' });
      prev = id;
    }
  }
}

// edge cleanup
const seen = new Set();
const finalEdges = [];
for (const e of edges) {
  if (!e.source || !e.target || !e.type) { report.droppedEdges.push({ ...e, reason: 'missing field' }); continue; }
  if (!nodesById.has(e.source) || !nodesById.has(e.target)) { report.droppedEdges.push({ source: e.source, target: e.target, type: e.type, reason: 'dangling' }); continue; }
  const key = `${e.source}|${e.target}|${e.type}`;
  if (seen.has(key)) continue;
  seen.add(key);
  finalEdges.push({ source: e.source, target: e.target, type: e.type, direction: e.direction || 'forward', weight: typeof e.weight === 'number' ? e.weight : 0.6, ...(e.description ? { description: e.description } : {}) });
}

// layers (exclusive, one per stage file)
const layers = stages.map((st) => ({
  id: st.id === 'H' ? 'layer:hierarchy-strategy' : `layer:stage-${st.id}`,
  name: st.name,
  description: st.summary || st.name,
  nodeIds: [...nodesById.keys()].filter((id) => layerOf.get(id) === st.id),
})).filter((l) => l.nodeIds.length > 0);

// make the Tessent TSDB folder hierarchy visible (tsdb_outdir/<category>/<object>/...) as module nodes + contains edges
{
  const tmp = { nodes: [...nodesById.values()], edges: finalEdges, layers };
  const { added } = addTsdbStructure(tmp);
  for (const n of tmp.nodes) if (!nodesById.has(n.id)) nodesById.set(n.id, n);
  report.tsdbFolders = added.folders;
}

// tour: hierarchy first, then one step per stage
const tour = [];
let order = 1;
for (const st of stages) {
  const layer = layers.find((l) => l.id === (st.id === 'H' ? 'layer:hierarchy-strategy' : `layer:stage-${st.id}`));
  if (!layer) continue;
  let ids = (st.tourNodeIds || []).filter((id) => nodesById.has(id));
  if (ids.length === 0) {
    const files = layer.nodeIds.filter((id) => nodesById.get(id).type === 'file').slice(0, 3);
    const concepts = layer.nodeIds.filter((id) => nodesById.get(id).type !== 'file' && !(nodesById.get(id).tags || []).some((t) => t === 'command-step' || t === 'tsdb-folder')).slice(0, 6);
    ids = [...files, ...concepts];
  }
  tour.push({ order: order++, title: st.name, description: st.summary || st.name, nodeIds: ids });
}

// validation
const issues = [];
const assigned = new Map();
for (const l of layers) for (const id of l.nodeIds) { if (assigned.has(id)) issues.push(`node in two layers: ${id}`); assigned.set(id, l.id); }
for (const id of nodesById.keys()) if (!assigned.has(id)) issues.push(`unassigned node: ${id}`);
for (const t of tour) for (const id of t.nodeIds) if (!nodesById.has(id)) issues.push(`tour references missing node ${id}`);

// project block
let inventory = null;
if (flags.inventory && existsSync(flags.inventory)) { try { inventory = JSON.parse(readFileSync(flags.inventory, 'utf8')); } catch { /* ignore */ } }
let commit = 'none';
try { commit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'none'; } catch { /* not a repo */ }
const graph = {
  version: '1.0.0',
  project: {
    name: flags.name || basename(ROOT),
    languages: ['tcl', 'verilog', 'shell'],
    frameworks: ['Siemens Tessent', 'Synopsys Design Compiler'],
    description: `DFT flow graph: ${inventory ? inventory.stages.length + ' stages, ' : ''}${nodesById.size} nodes. Built by /understand-dft.`,
    analyzedAt: new Date().toISOString(),
    gitCommitHash: commit,
  },
  nodes: [...nodesById.values()],
  edges: finalEdges,
  layers,
  tour,
};

mkdirSync(UA_DIR, { recursive: true });
const graphPath = join(UA_DIR, 'knowledge-graph.json');
if (existsSync(graphPath)) copyFileSync(graphPath, join(UA_DIR, 'knowledge-graph.prev.json'));
if (issues.length === 0) {
  writeFileSync(graphPath, JSON.stringify(graph, null, 2));
  writeFileSync(join(UA_DIR, 'meta.json'), JSON.stringify({ lastAnalyzedAt: graph.project.analyzedAt, gitCommitHash: commit, version: '1.0.0', analyzedFiles: [...nodesById.values()].filter((n) => n.type === 'file').length }, null, 2));
}
report.stages = stages.map((s) => ({ id: s.id, name: s.name, nodes: [...layerOf.values()].filter((v) => v === s.id).length }));
report.issues = issues;
writeFileSync(join(UA_DIR, 'dft-assemble-report.json'), JSON.stringify(report, null, 2));

const types = {};
for (const n of nodesById.values()) types[n.type] = (types[n.type] || 0) + 1;
console.log(`dft-assemble: ${issues.length ? 'FAILED (graph not written)' : 'ok'}  nodes=${nodesById.size} edges=${finalEdges.length} layers=${layers.length} tour=${tour.length}`);
console.log('  node types: ' + JSON.stringify(types));
console.log(`  inferred nodes: ${report.inferred.length}   partial reads: ${report.partialReads.length}   dropped edges: ${report.droppedEdges.length}   converted functions: ${report.convertedFunctions}   tsdb folder nodes: ${report.tsdbFolders ?? 0}`);
for (const w of report.warnings.slice(0, 10)) console.log('  warning: ' + w);
for (const i of issues.slice(0, 10)) console.log('  ISSUE: ' + i);
process.exit(issues.length ? 1 : 0);
