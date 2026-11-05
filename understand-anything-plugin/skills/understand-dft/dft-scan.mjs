#!/usr/bin/env node
/**
 * dft-scan.mjs
 *
 * Deterministic inventory of a Tessent-style DFT lab / flow folder for the
 * /understand-dft skill. It does NOT read file contents beyond line counts and
 * a few regexes; the LLM work happens later in the dft-stage-analyzer agent.
 *
 * What it produces (JSON, written to <outputPath>):
 *   - stages[]      one entry per numbered stage folder (1.insert_mbist, 2.xxx ...)
 *                   with dofiles, RUNME launchers, logs, reports, netlists,
 *                   simulation evidence, referenced design_ids, open_tsdb targets
 *   - tsdb[]        generated Tessent database artifacts (tsdb_outdir) grouped
 *                   by design_id and mapped back to the stages that use them
 *   - excluded      counts of tool scratch files that were skipped
 *
 * Usage:
 *   node dft-scan.mjs <projectRoot> <outputPath> [--exclude "a,b"] [--max-artifacts 60]
 *
 * Pure Node (fs/path only) so it runs without building @understand-anything/core.
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';

const argv = process.argv.slice(2);
const pos = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else { flags[key] = true; }
  } else {
    pos.push(argv[i]);
  }
}
if (pos.length < 2) {
  console.error('Usage: node dft-scan.mjs <projectRoot> <outputPath> [--exclude "a,b"] [--max-artifacts N]');
  process.exit(2);
}
const ROOT = pos[0].replace(/[\\/]+$/, '');
const OUT = pos[1];
const MAX_ARTIFACTS = Number(flags['max-artifacts']) > 0 ? Number(flags['max-artifacts']) : 120;
const USER_EXCLUDES = String(flags.exclude || '').split(',').map((s) => s.trim()).filter(Boolean);

const SCRATCH_EXT = new Set(['.qdb', '.qtl', '.qpg', '.dbg', '.vec', '.wlf', '.swp', '.swo']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.ua', '.understand-anything', 'work', 'dut_work', '_vmake', '_info', '@_opt']);
const TEXT_EXT = new Set(['.tcl', '.dofile', '.do', '.v', '.vg', '.sv', '.icl', '.pdl', '.tcd', '.sdc', '.scandef', '.txt', '.rpt', '.out', '.svf', '.csh', '.sh', '.log', '.cfg', '.list', '.name']);

const excluded = { scratchFiles: 0, skippedDirs: 0, userExcluded: 0, binaryOrLarge: 0 };

function norm(p) { return p.split('\\').join('/'); }
function matchesUserExclude(rel) {
  return USER_EXCLUDES.some((pat) => {
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '').replace(/\*/g, '[^/]*').replace(//g, '.*') + '$');
    return re.test(rel) || re.test(basename(rel));
  });
}
function lineCount(abs, size) {
  if (size > 5 * 1024 * 1024) { excluded.binaryOrLarge++; return null; }
  try { return readFileSync(abs, 'utf8').split('\n').length; } catch { return null; }
}

/** Walk; returns file records. Does not descend into SKIP_DIRS; simulation_outdir is summarised later. */
const files = [];
const simDirs = [];
function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = join(dir, e.name);
    const rel = norm(abs.slice(ROOT.length + 1));
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) { excluded.skippedDirs++; continue; }
      if (e.name === 'simulation_outdir') { simDirs.push(rel); continue; }
      if (matchesUserExclude(rel)) { excluded.userExcluded++; continue; }
      walk(abs);
    } else if (e.isFile()) {
      const ext = extname(e.name).toLowerCase();
      if (SCRATCH_EXT.has(ext)) { excluded.scratchFiles++; continue; }
      if (matchesUserExclude(rel)) { excluded.userExcluded++; continue; }
      let size = 0;
      try { size = statSync(abs).size; } catch { /* ignore */ }
      files.push({ rel, abs, size, ext, name: e.name });
    }
  }
}
walk(ROOT);

const inTsdb = (rel) => rel.split('/').includes('tsdb_outdir');
const stageOfPath = (rel) => {
  const first = rel.split('/')[0];
  const m = first.match(/^(\d+)[._ -](.+)$/);
  return m ? { id: m[1], folder: first, label: m[2] } : null;
};

function classify(f) {
  const n = f.name;
  if (n === 'RUNME' || f.ext === '.csh' || f.ext === '.sh') return 'runme';
  if (f.ext === '.tcl' || f.ext === '.dofile' || f.ext === '.do' || /dc_shell_import_script$/.test(n)) return 'dofile';
  if (/^(log|log_.*|.*_log|command\.log|syn_log)$/i.test(n) || f.ext === '.log') return 'log';
  if (f.ext === '.rpt' || f.ext === '.out' || /^AU_/.test(n)) return 'report';
  if (f.ext === '.v' || f.ext === '.vg') return 'netlist';
  return 'other';
}

const stages = new Map();
const designFiles = [];
const tsdbFiles = [];
for (const f of files) {
  if (inTsdb(f.rel)) { tsdbFiles.push(f); continue; }
  const st = stageOfPath(f.rel);
  const rec = { path: f.rel, kind: classify(f), size: f.size, lines: TEXT_EXT.has(f.ext) || f.ext === '' ? lineCount(f.abs, f.size) : null };
  if (!st) { designFiles.push({ ...rec, kind: rec.kind === 'netlist' ? 'design' : rec.kind }); continue; }
  if (!stages.has(st.id)) stages.set(st.id, { id: st.id, folder: st.folder, label: st.label, dofiles: [], runme: [], logs: [], reports: [], netlists: [], other: [], simulation: { outdirs: [], transcripts: [], logs: [] }, designIds: [], core: null, openTsdb: [], writesTsdb: false });
  const s = stages.get(st.id);
  if (/\/simulations\//.test('/' + f.rel)) {
    if (/simulation_class\.log$|compile_class\.log$/.test(f.name)) s.simulation.logs.push(rec.path);
    continue; // generated simulator output; transcripts handled via logs list only
  }
  ({ dofile: s.dofiles, runme: s.runme, log: s.logs, report: s.reports, netlist: s.netlists, other: s.other, design: s.netlists })[rec.kind].push(rec);
}

/** simulation_outdir: record signoff simulation names + transcript paths */
for (const rel of simDirs) {
  const st = stageOfPath(rel);
  if (!st || !stages.has(st.id)) continue;
  const s = stages.get(st.id);
  s.simulation.outdirs.push(rel);
  const root = join(ROOT, rel);
  try {
    for (const sub of readdirSync(root, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      for (const sim of readdirSync(join(root, sub.name), { withFileTypes: true })) {
        if (sim.isDirectory() && sim.name.endsWith('.simulation')) {
          const t = join(root, sub.name, sim.name, 'transcript');
          try { statSync(t); s.simulation.transcripts.push(norm(t.slice(ROOT.length + 1))); } catch { /* none */ }
        }
      }
    }
  } catch { /* ignore */ }
}

/** Regex facts from dofiles (first 400 KB each) */
for (const s of stages.values()) {
  const ownIds = new Set();   // design_ids this stage creates or builds on for its own core
  const readIds = new Set();  // design_ids of OTHER cores it only reads (e.g. a lower-level graybox)
  const readPairs = [];
  for (const d of s.dofiles) {
    let txt = '';
    try { txt = readFileSync(join(ROOT, d.path), 'utf8').slice(0, 400000); } catch { continue; }
    for (const m of txt.matchAll(/set_context\s+\S+(?:\s+-\S+)*?\s+-design_id\s+(\w+)/g)) ownIds.add(m[1]);
    for (const m of txt.matchAll(/read_design\s+(\w+)(?:\s+-\S+(?:\s+\w+)?)*?\s+-design_id\s+(\w+)/g)) readPairs.push([m[1], m[2]]);
    for (const m of txt.matchAll(/open_tsdb\s+(\S+)/g)) s.openTsdb.push(m[1]);
    const cur = txt.match(/set_current_design\s+(\S+)/);
    if (cur && !s.core) s.core = cur[1];
    if (/write_tsdb_data|create_patterns|process_dft_spec|insert_test_logic|run_testbench_simulations/.test(txt)) s.writesTsdb = true;
  }
  for (const [design, id] of readPairs) {
    if (s.core && design === s.core) ownIds.add(id); else readIds.add(`${design}:${id}`);
  }
  s.designIds = [...ownIds];
  s.readOnlyDesigns = [...readIds];
  s.openTsdb = [...new Set(s.openTsdb)];
}

/** tsdb_outdir artifact index, mapped to design_ids */
const PRIORITY = ['.dft_spec', '.patterns_spec_signoff', '.icl', '.pdl', '.tcd', '.scandef', '.generation_log', '.sdc', '.v', '.vg', '.faults.gz', '.patdb'];
const artifacts = tsdbFiles.map((f) => {
  const parts = f.rel.split('/');
  const idx = parts.indexOf('tsdb_outdir');
  return { path: f.rel, group: parts[idx + 1] || '', size: f.size, ext: f.ext, name: f.name, lines: TEXT_EXT.has(f.ext) ? lineCount(f.abs, f.size) : null };
});
function priority(a) {
  const i = PRIORITY.findIndex((p) => a.path.endsWith(p));
  return i === -1 ? PRIORITY.length : i;
}
for (const s of stages.values()) {
  const core = s.core ? s.core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const rx = s.designIds.map((id) => new RegExp('(^|/)' + core + '[_.]' + id + '([_.]|/|$)'));
  const sel = core ? artifacts.filter((a) => rx.some((r) => r.test(a.path.split('/').slice(-3).join('/')))) : [];
  sel.sort((a, b) => priority(a) - priority(b) || a.path.localeCompare(b.path));
  s.tsdbArtifacts = sel.slice(0, MAX_ARTIFACTS).map((a) => ({ path: a.path, group: a.group, lines: a.lines, size: a.size }));
  s.tsdbArtifactsTotal = sel.length;
}

const out = {
  schemaVersion: 1,
  projectRoot: norm(ROOT),
  scannedAt: new Date().toISOString(),
  stages: [...stages.values()].sort((a, b) => Number(a.id) - Number(b.id)),
  designFiles,
  tsdbRoots: [...new Set(artifacts.map((a) => a.path.split('/tsdb_outdir')[0] + '/tsdb_outdir'))],
  tsdbArtifactCount: artifacts.length,
  excluded,
  warnings: [],
};
if (out.stages.length === 0) out.warnings.push('No numbered stage folders (e.g. 1.insert_mbist) found; /understand-dft expects the stage-folder layout.');
if (artifacts.length === 0) out.warnings.push('No tsdb_outdir found; generated-artifact analysis will be skipped.');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`dft-scan: stages=${out.stages.length} designFiles=${designFiles.length} tsdbArtifacts=${artifacts.length} scratchSkipped=${excluded.scratchFiles}`);
for (const s of out.stages) {
  console.log(`  stage ${s.id} ${s.folder}: dofiles=${s.dofiles.length} logs=${s.logs.length} reports=${s.reports.length} sims=${s.simulation.transcripts.length} designIds=[${s.designIds.join(',')}] tsdb=${s.tsdbArtifactsTotal}`);
}
for (const w of out.warnings) console.log('  warning: ' + w);
