#!/usr/bin/env node
import fs from "node:fs/promises";
import { Command } from "commander";
import { runScanTask } from "./index.js";
import { ScanConfig } from "./types.js";

const program = new Command();
program.name("diskorg").description("DiskOrg scanner CLI").version("0.1.0");

program
  .command("scan")
  .description("scan files with streaming progress")
  .requiredOption("--roots <paths>", "comma separated roots")
  .option("--min-size <bytes>", "minimum file size")
  .option("--max-size <bytes>", "maximum file size")
  .option("--include <globs>", "comma separated include globs")
  .option("--exclude <globs>", "comma separated exclude globs")
  .option("--exclude-paths <paths>", "comma separated path keywords")
  .option("--skip-onedrive", "skip likely OneDrive placeholders", true)
  .option("--csv <path>", "export indexed records to CSV")
  .option("--json <path>", "export indexed records to JSON")
  .option("--bundle-json <path>", "export structured bundle JSON with duplicate groups and risks")
  .option("--db <path>", "export sqlite snapshot")
  .option("--save-state <path>", "write pause/resume state file")
  .option("--resume-state <path>", "resume from state file")
  .action(async (options) => {
    const config: ScanConfig = {
      roots: String(options.roots)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      minSizeBytes: options.minSize ? Number(options.minSize) : undefined,
      maxSizeBytes: options.maxSize ? Number(options.maxSize) : undefined,
      includeGlobs: options.include
        ? String(options.include)
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : undefined,
      excludeGlobs: options.exclude
        ? String(options.exclude)
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : undefined,
      excludePaths: options.excludePaths
        ? String(options.excludePaths)
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : undefined,
      skipOneDrivePlaceholders: Boolean(options.skipOnedrive),
    };

    let indexed = 0;
    let skipped = 0;
    let risks = 0;
    let currentTaskId = "unknown";

    const { taskId, records } = await runScanTask(config, {
      csvPath: options.csv,
      jsonPath: options.json,
      bundleJsonPath: options.bundleJson,
      dbPath: options.db,
      saveStatePath: options.saveState,
      resumeStatePath: options.resumeState,
      onEvent: (ev) => {
        if (ev.type === "scan_started") {
          currentTaskId = ev.taskId;
        }
        if (ev.type === "file_indexed") {
          indexed += 1;
        }
        if (ev.type === "file_skipped") {
          skipped += 1;
        }
        if (ev.type === "risk_flag") {
          risks += 1;
        }
        if (ev.type === "scan_finished") {
          process.stdout.write(
            `\\nTASK ${currentTaskId} finished | indexed=${indexed} skipped=${skipped} risks=${risks}\\n`,
          );
          return;
        }

        if ((indexed + skipped) % 50 === 0 && indexed + skipped > 0) {
          process.stdout.write(
            `progress indexed=${indexed} skipped=${skipped} risks=${risks}\\n`,
          );
        }
      },
    });

    process.stdout.write(`records=${records.length} task=${taskId}\\n`);
  });

program
  .command("query")
  .description("query exported JSON with sort and filter")
  .requiredOption("--input <path>", "json path from scan export")
  .option("--sort-by <field>", "size|name|path|mtimeMs", "size")
  .option("--order <direction>", "asc|desc", "desc")
  .option("--contains <text>", "path/name contains text")
  .option("--limit <n>", "output row count", "20")
  .action(async (options) => {
    const raw = await fs.readFile(String(options.input), "utf8");
    const data = JSON.parse(raw) as Array<Record<string, unknown>>;
    const contains = options.contains ? String(options.contains).toLowerCase() : "";

    let rows = data;
    if (contains) {
      rows = rows.filter((r) => {
        const p = String(r.path ?? "").toLowerCase();
        const n = String(r.name ?? "").toLowerCase();
        return p.includes(contains) || n.includes(contains);
      });
    }

    const sortBy = String(options.sortBy);
    const order = String(options.order) === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const av = a[sortBy];
      const bv = b[sortBy];
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * order;
      }
      return String(av ?? "").localeCompare(String(bv ?? "")) * order;
    });

    const limit = Number(options.limit);
    for (const row of rows.slice(0, limit)) {
      process.stdout.write(
        `${row.size}\t${row.mtimeMs}\t${row.path}\n`,
      );
    }
  });

program.parseAsync(process.argv);
