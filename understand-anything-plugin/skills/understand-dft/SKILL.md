---
name: understand-dft
description: Build a DFT-architecture knowledge graph for a Tessent-style flow folder (numbered stage directories with dofiles, logs and a tsdb_outdir). Explains how the flow works - hierarchy, test access, clocking, scan modes, patterns - with command-step nodes and real numbers from logs and generated files. Use instead of /understand for DFT labs.
argument-hint: "[path] [--exclude <patterns>] [--max-artifacts <n>] [--no-dashboard]"
---

# /understand-dft

Produces `knowledge-graph.json` for a DFT flow so the dashboard shows, per stage, **what each command does to the DFT architecture and what the logs and generated files say about it**. It is an alternative to `/understand`, which cannot parse TCL, dofiles, logs or ICL/PDL and treats generated tool output as noise.

Use it when the folder looks like this (names may differ, the leading number matters):

```
1.insert_mbist/   2.insert_edt_occ/   3.synthesis/   4.scan_insertion/   5.atpg/   6.xxx/  ...
tsdb_outdir/      design/
```

If the folder is an ordinary software project, use `/understand` instead.

## Options

- A directory path (the flow folder, e.g. one core or one lab). Default: the current working directory.
- `--exclude <patterns>`: extra comma-separated glob patterns to skip.
- `--max-artifacts <n>`: cap on generated artifacts listed per stage (default 120).
- `--no-dashboard`: do not launch the dashboard at the end.

## Progress reporting

Print `[Phase N/6] <name>...` at each phase and a one-line result when it finishes.

## Phase 0: Pre-flight

1. Resolve `PROJECT_ROOT` from the argument (verify with `test -d`; stop with an error if missing). Do not default to a personal or unrelated folder: if no path was given and the working directory has no numbered stage folders, ask the user which folder to analyze.
2. Resolve `PLUGIN_ROOT` and `SKILL_DIR` (this skill's directory) the same way the `/understand` skill does, and `UA_DIR` = `$PROJECT_ROOT/.understand-anything` if it exists, else `$PROJECT_ROOT/.ua`. Create `$UA_DIR/intermediate`.
3. These helper scripts need only Node >= 18. The dashboard needs `pnpm install` and a core build in `PLUGIN_ROOT` the first time (see `/understand-dashboard`).

## Phase 1: Inventory

```bash
node "<SKILL_DIR>/dft-scan.mjs" "$PROJECT_ROOT" "$UA_DIR/intermediate/dft-inventory.json" [--exclude "..."] [--max-artifacts N]
```

It skips tool scratch (`.qdb .qtl .qpg .dbg .vec .wlf`, `work/`, `dut_work/`, `_vmake/`) and indexes the numbered stage folders, their dofiles, RUNME launchers, logs, reports, simulation transcripts, the design ids each dofile uses, and the `tsdb_outdir` artifacts that belong to each stage's own design id (artifacts of lower-level cores that the stage only *reads* are not mixed in).

Show the user the per-stage summary printed by the script. Stop and explain if there are no stage folders. Warn if there is no `tsdb_outdir` (analysis will rely on dofiles and logs only).

## Phase 2: Stage analysis

Dispatch one `dft-stage-analyzer` agent per stage, up to 4 at a time. Prompt template:

> Analyze DFT stage `<id>` (`<folder>`).
> Project root: `$PROJECT_ROOT`. Data dir: `$UA_DIR`.
> Inventory entry (JSON): `<the stage object from dft-inventory.json>`
> Write: `$UA_DIR/intermediate/dft-stage-<id>.json`

Verify each expected `dft-stage-<id>.json` exists and parses; re-dispatch once for any that is missing or invalid.

## Phase 3: Hierarchy and strategy pass

Dispatch one more `dft-stage-analyzer` with `stage: "H"`. Pass the list of stage fragment files and the design-source paths from `designFiles` in the inventory. It writes `dft-stage-H.json`. Skip this phase only if the flow has a single flat design with no lower-level cores (say so in the final report).

## Phase 4: Assemble

```bash
node "<SKILL_DIR>/dft-assemble.mjs" "$PROJECT_ROOT" --name "<short project name>" --inventory "$UA_DIR/intermediate/dft-inventory.json"
```

The script types command steps as `concept` (so the dashboard shows them without toggles), adds the `contains` / `triggers` edges, builds one layer per stage plus a hierarchy layer, drops dangling edges, builds a tour, validates, and writes `knowledge-graph.json`, `meta.json` and `dft-assemble-report.json`. A previous graph is kept as `knowledge-graph.prev.json`.

If it exits non-zero, read the printed `ISSUE` lines, fix the stage fragment concerned (or re-dispatch that agent), and run it again. Do not hand-edit `knowledge-graph.json`.

## Phase 5: Report

Tell the user, from the script output and `dft-assemble-report.json`:

- stages, node and edge counts, layers
- how many nodes are **inferred** and which files were only **partly read**
- dropped edges, if any
- anything notable the agents flagged as an observation

## Phase 6: Dashboard

Unless `--no-dashboard` was given, invoke the `/understand-dashboard` skill for `PROJECT_ROOT`. If another dashboard is already using the default port the next free port is chosen; give the user the full URL including `?token=`.

## Notes

- Intermediate files stay in `$UA_DIR/intermediate/` (nothing is moved or deleted); re-run `dft-assemble.mjs` after editing a fragment to rebuild quickly.
- The graph is only as good as what the agents read. The report lists partial reads so you know where to look deeper.
- Generated output from other tools may be partly text the agents did not write; treat summaries marked `inferred` as hypotheses, not facts.
