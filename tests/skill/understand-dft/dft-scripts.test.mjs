import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(here, '../../../understand-anything-plugin/skills/understand-dft');
const SCAN = join(SKILL, 'dft-scan.mjs');
const ASSEMBLE = join(SKILL, 'dft-assemble.mjs');

let root;

function put(rel, text) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dft-lab-'));
  put('1.insert_mbist/core_rtl1.tcl', 'set_context dft -rtl -design_id rtl1\nset_current_design core\nopen_tsdb ../lower/tsdb_outdir\nread_design lower -design_id gate -view graybox\nprocess_dft_spec\n');
  put('1.insert_mbist/RUNME', 'tessent -shell -dofile core_rtl1.tcl -logfile log\n');
  put('2.scan/core_scan.tcl', 'set_context dft -scan -design_id gate -hier\nset_current_design core\ninsert_test_logic\n');
  put('2.scan/log', '//  command: set_context dft -scan\n');
  put('1.insert_mbist/stuff.qdb', 'binary');           // scratch: must be skipped
  put('1.insert_mbist/work/_lib.qdb', 'binary');        // scratch dir
  put('tsdb_outdir/dft_inserted_designs/core_rtl1.dft_spec', 'DftSpecification(core,rtl1) {}\n');
  put('tsdb_outdir/dft_inserted_designs/lower_gate.dft_inserted_design/lower.icl', 'Module lower {}\n');
  put('tsdb_outdir/dft_inserted_designs/core_gate.dft_inserted_design/core.icl', 'Module core {}\n');
  put('design/core.v', 'module core(); endmodule\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('dft-scan.mjs', () => {
  it('finds stages, ignores scratch, separates own design ids from read-only ones', () => {
    const out = join(root, 'inv.json');
    const r = run(SCAN, [root, out]);
    expect(r.status).toBe(0);
    const inv = JSON.parse(readFileSync(out, 'utf8'));
    expect(inv.stages.map((s) => s.id)).toEqual(['1', '2']);
    const s1 = inv.stages[0];
    expect(s1.core).toBe('core');
    expect(s1.designIds).toEqual(['rtl1']);
    expect(s1.readOnlyDesigns).toEqual(['lower:gate']);
    expect(s1.dofiles.map((d) => d.path)).toEqual(['1.insert_mbist/core_rtl1.tcl']);
    expect(s1.runme).toHaveLength(1);
    expect(inv.excluded.scratchFiles).toBeGreaterThanOrEqual(1);
    // own-design artifacts only: core_rtl1 spec yes, lower_gate no
    const paths = s1.tsdbArtifacts.map((a) => a.path).join('\n');
    expect(paths).toContain('core_rtl1.dft_spec');
    expect(paths).not.toContain('lower_gate');
    expect(inv.stages[1].log ?? inv.stages[1].logs).toHaveLength(1);
  });

  it('warns when there are no numbered stage folders', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dft-empty-'));
    const out = join(empty, 'inv.json');
    const r = run(SCAN, [empty, out]);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).warnings.join(' ')).toMatch(/numbered stage/);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('dft-assemble.mjs', () => {
  function writeStage(id, data) {
    mkdirSync(join(root, '.ua/intermediate'), { recursive: true });
    writeFileSync(join(root, `.ua/intermediate/dft-stage-${id}.json`), JSON.stringify({ stage: id, ...data }));
  }

  it('builds layers, step edges, tour; converts function nodes; drops dangling edges', () => {
    writeStage('1', {
      stageName: '1. MBIST',
      stageSummary: 'inserts MBIST',
      nodes: [
        { id: 'file:1.insert_mbist/core_rtl1.tcl', type: 'file', name: 'core_rtl1.tcl', summary: 'dofile', tags: ['tessent'], readCoverage: 'full' },
        { type: 'concept', kind: 'step', parentFile: '1.insert_mbist/core_rtl1.tcl', key: 'ctx', order: 0, name: 'Open session', summary: 'set_context ...', tags: ['session'] },
        { type: 'concept', kind: 'step', parentFile: '1.insert_mbist/core_rtl1.tcl', key: 'spec', order: 1, name: 'Process spec', summary: 'process_dft_spec ...', tags: ['mbist'] },
        { id: 'concept:mbist-ctrl', type: 'concept', kind: 'concept', name: 'MBIST controller', summary: 'c1 ... (inferred)', tags: ['mbist'], inferred: true },
        { id: 'function:legacy', type: 'function', name: 'legacy', summary: 'should become concept', tags: ['x'] },
      ],
      edges: [
        { source: 'file:1.insert_mbist/core_rtl1.tcl', target: 'concept:mbist-ctrl', type: 'configures' },
        { source: 'concept:mbist-ctrl', target: 'concept:does-not-exist', type: 'related' },
      ],
    });
    writeStage('H', {
      stageName: 'Hierarchy and Test Strategy',
      stageSummary: 'parent and child',
      nodes: [{ id: 'module:core', type: 'module', name: 'core', summary: 'parent', tags: ['hierarchy'] }],
      edges: [{ source: 'module:core', target: 'concept:mbist-ctrl', type: 'related' }],
    });
    const r = run(ASSEMBLE, [root, '--name', 'unit lab']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const g = JSON.parse(readFileSync(join(root, '.ua/knowledge-graph.json'), 'utf8'));

    // no function-typed nodes survive; steps are concepts with ids
    expect(g.nodes.filter((n) => n.type === 'function')).toHaveLength(0);
    const step = g.nodes.find((n) => n.id === 'concept:step:1.insert_mbist/core_rtl1.tcl:ctx');
    expect(step.type).toBe('concept');
    expect(step.tags).toContain('command-step');

    // structure edges
    const has = (s, t, ty) => g.edges.some((e) => e.source === s && e.target === t && e.type === ty);
    expect(has('file:1.insert_mbist/core_rtl1.tcl', 'concept:step:1.insert_mbist/core_rtl1.tcl:ctx', 'contains')).toBe(true);
    expect(has('concept:step:1.insert_mbist/core_rtl1.tcl:ctx', 'concept:step:1.insert_mbist/core_rtl1.tcl:spec', 'triggers')).toBe(true);

    // dangling edge dropped, valid cross-layer edge kept
    expect(g.edges.some((e) => e.target === 'concept:does-not-exist')).toBe(false);
    expect(has('module:core', 'concept:mbist-ctrl', 'related')).toBe(true);

    // exclusive layers, hierarchy first in the tour
    const all = g.layers.flatMap((l) => l.nodeIds);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(g.nodes.length);
    expect(g.tour[0].title).toBe('Hierarchy and Test Strategy');

    // honesty markers
    expect(g.nodes.find((n) => n.id === 'concept:mbist-ctrl').tags).toContain('inferred');
    const rep = JSON.parse(readFileSync(join(root, '.ua/dft-assemble-report.json'), 'utf8'));
    expect(rep.droppedEdges).toHaveLength(1);
    expect(rep.convertedFunctions).toBe(1);
    expect(rep.inferred).toContain('concept:mbist-ctrl');
  });

  it('mirrors the Tessent tsdb_outdir folder hierarchy as folder nodes and contains edges', () => {
    writeStage('1', {
      stageName: '1. MBIST',
      nodes: [
        { id: 'file:tsdb_outdir/instruments/core_rtl1_mbist.instrument/core_rtl1_mbist.icl', type: 'file', name: 'x.icl', filePath: 'tsdb_outdir/instruments/core_rtl1_mbist.instrument/core_rtl1_mbist.icl', summary: 's', tags: ['icl'] },
        { id: 'file:tsdb_outdir/dft_inserted_designs/core_rtl1.dft_spec', type: 'file', name: 'spec', filePath: 'tsdb_outdir/dft_inserted_designs/core_rtl1.dft_spec', summary: 's', tags: ['spec'] },
      ],
      edges: [],
    });
    const r = run(ASSEMBLE, [root]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const g = JSON.parse(readFileSync(join(root, '.ua/knowledge-graph.json'), 'utf8'));
    const L = 'layer:stage-1';
    const id = (p) => `folder:${L}:${p}`;
    const has = (s, t) => g.edges.some((e) => e.source === s && e.target === t && e.type === 'contains');
    expect(has(id('tsdb_outdir'), id('tsdb_outdir/instruments'))).toBe(true);
    expect(has(id('tsdb_outdir/instruments'), id('tsdb_outdir/instruments/core_rtl1_mbist.instrument'))).toBe(true);
    expect(has(id('tsdb_outdir/instruments/core_rtl1_mbist.instrument'), 'file:tsdb_outdir/instruments/core_rtl1_mbist.instrument/core_rtl1_mbist.icl')).toBe(true);
    expect(has(id('tsdb_outdir/dft_inserted_designs'), 'file:tsdb_outdir/dft_inserted_designs/core_rtl1.dft_spec')).toBe(true);
    const folder = g.nodes.find((n) => n.id === id('tsdb_outdir/instruments/core_rtl1_mbist.instrument'));
    expect(folder.tags).toContain('tsdb-folder');
    expect(folder.summary).toMatch(/MBIST/);
    // folders live in the same (single) layer as their files
    const layer = g.layers.find((l) => l.id === L);
    expect(layer.nodeIds).toContain(id('tsdb_outdir'));
    const all = g.layers.flatMap((l) => l.nodeIds);
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps the previous graph as knowledge-graph.prev.json on re-run', () => {
    const r = run(ASSEMBLE, [root]);
    expect(r.status).toBe(0);
    expect(existsSync(join(root, '.ua/knowledge-graph.prev.json'))).toBe(true);
  });

  it('fails clearly when there are no stage fragments', () => {
    const bare = mkdtempSync(join(tmpdir(), 'dft-bare-'));
    mkdirSync(join(bare, '.ua/intermediate'), { recursive: true });
    const r = run(ASSEMBLE, [bare]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no dft-stage/);
    rmSync(bare, { recursive: true, force: true });
  });
});
