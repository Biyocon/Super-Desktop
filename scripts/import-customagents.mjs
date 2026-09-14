#!/usr/bin/env node
/**
 * Import CustomAgents `profile.md` personas into Iqra-Desktop subagent
 * definitions (`~/.agents/subagents/*.md`).
 *
 * POC for the mapping in Kombi `docs/10-customagents-to-iqra-mapping.md` §6.1.
 * The script is read-only on the CustomAgents repo and only ever writes into
 * the Iqra user-global subagent directory (or an explicit `--out` override).
 *
 * Adapter rules (see docs/10 §3–§4):
 *   1. `id` (or `name`) is normalized to `[a-z0-9-]`, max 40 chars.
 *   2. `description` becomes one routing line: the persona's own `description`
 *      when present and short, otherwise `role` + the first capabilities.
 *   3. `## System Prompt`'s fenced block becomes the delegate prompt; when a
 *      persona has no System Prompt (the BDK "rig" variant), the prompt is
 *      synthesized from role / Formaal / Kernekompetencer / mapped roles.
 *   4. `tools` default to read-only `[Read, Glob, Grep]`; override with
 *      `--tools` for roles that genuinely mutate.
 *
 * Usage:
 *   node scripts/import-customagents.mjs <profile.md>... [--out DIR] [--tools a,b,c] [--dry-run] [--verify]
 *
 * `--verify` runs the real `parseSubagentDefinition` against each generated
 * document and reports `ok` / errors / warnings. `--dry-run` prints without
 * writing anything.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseSubagentDefinition } from "../packages/shared/dist/subagent-definition.js";

const DEFAULT_TOOLS = ["Read", "Glob", "Grep"];

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

function usage() {
  console.log(
    [
      "Usage: node scripts/import-customagents.mjs <profile.md>... [options]",
      "",
      "Options:",
      "  --out DIR      output directory (default: ~/.agents/subagents)",
      "  --tools a,b,c  delegate tools (default: Read,Glob,Grep)",
      "  --dry-run      print the generated documents, write nothing",
      "  --verify       run parseSubagentDefinition on each generated document",
      "  -h, --help     this help",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const profiles = [];
  const opts = { out: null, dryRun: false, verify: false, tools: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--tools") {
      opts.tools = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--verify") opts.verify = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else profiles.push(arg);
  }
  return { profiles, opts };
}

// ---------------------------------------------------------------------------
// CustomAgents profile.md parsing (rich persona frontmatter + body)
// ---------------------------------------------------------------------------

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseInlineList(value) {
  return value
    .slice(1, -1)
    .split(",")
    .map((entry) => unquote(entry))
    .filter((entry) => entry.length > 0);
}

function parseCustomFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const fm = {};
  let body = normalized;
  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---", 3);
    if (end !== -1) {
      const block = normalized.slice(4, end);
      body = normalized.slice(end + 4).replace(/^[ \t]*\n/, "");
      let lastKey = null;
      for (const line of block.split("\n")) {
        if (!line.trim() || line.trim().startsWith("#")) continue;
        const item = line.match(/^[ \t]*-[ \t]+(.*)$/);
        if (item && lastKey) {
          const value = unquote(item[1]);
          if (value) (fm[lastKey] ??= []).push(value);
          continue;
        }
        const pair = line.match(/^([A-Za-z][A-Za-z0-9_\- ]*):[ \t]*(.*)$/);
        if (!pair) continue;
        lastKey = pair[1].trim();
        const value = pair[2].trim();
        if (value.startsWith("[") && value.endsWith("]")) {
          fm[lastKey] = parseInlineList(value);
        } else if (value === "") {
          fm[lastKey] = [];
        } else {
          fm[lastKey] = unquote(value);
        }
      }
    }
  }
  return { fm, body: body.trim() };
}

// ---------------------------------------------------------------------------
// Prompt extraction / synthesis
// ---------------------------------------------------------------------------

/** Text under a `## <heading>` until the next `##` heading, if present. */
function sectionText(body, heading) {
  const re = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "im");
  const match = body.match(re);
  if (!match) return null;
  const after = body.slice(match.index + match[0].length);
  const next = after.match(/^##\s+/m);
  return (next ? after.slice(0, next.index) : after).trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listItems(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.replace(/^-\s*/, "").trim());
}

function extractSystemPrompt(body) {
  const heading = body.match(/^##\s+System\s*Prompt\s*$/im);
  if (!heading) return null;
  const after = body.slice(heading.index + heading[0].length);
  const fence = after.match(/```[\w-]*\n([\s\S]*?)\n```/);
  if (!fence) return null;
  return fence[1].trim();
}

function synthesizePrompt(fm, body) {
  const role = fm.role || fm.name || fm.id || "agent";
  const division = fm.division ? ` (${fm.division})` : "";
  const parts = [`Du er en ${role}-agent${division}.`];

  const formaal = sectionText(body, "Formaal") ?? sectionText(body, "Formål");
  if (formaal) {
    const items = listItems(formaal);
    parts.push(items.length ? items.join("\n") : formaal);
  }

  const mapped = sectionText(body, "Mappede Banedanmark Roller");
  if (mapped) {
    const items = listItems(mapped);
    if (items.length) {
      parts.push("Mappede Banedanmark-roller:\n" + items.map((i) => `- ${i}`).join("\n"));
    }
  }

  const competencies = sectionText(body, "Kernekompetencer");
  if (competencies) {
    const items = listItems(competencies);
    if (items.length) {
      parts.push("Kernekompetencer:\n" + items.map((i) => `- ${i}`).join("\n"));
    }
  }

  return parts.join("\n\n").trim();
}

// ---------------------------------------------------------------------------
// Adapter rules
// ---------------------------------------------------------------------------

function normalizeId(value) {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40);
}

function synthesizeDescription(fm) {
  const own = typeof fm.description === "string" ? fm.description.trim() : "";
  if (own) return own;
  const role = fm.role || fm.name || fm.id || "agent";
  const caps = Array.isArray(fm.capabilities) ? fm.capabilities.slice(0, 4) : [];
  return caps.length ? `${role} — ${caps.join(", ")}` : role;
}

function yamlQuote(value) {
  return JSON.stringify(value);
}

function generateDefinition(fm, prompt, tools) {
  const name = normalizeId(fm.id || fm.name);
  const description = synthesizeDescription(fm);
  const toolsBlock = tools.map((tool) => `  - ${tool}`).join("\n");
  return (
    `---\n` +
    `name: ${name}\n` +
    `description: ${yamlQuote(description)}\n` +
    `tools:\n${toolsBlock}\n` +
    `---\n\n` +
    `${prompt}\n`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { profiles, opts, help } = parseArgs(process.argv.slice(2));
  if (help) return usage();
  if (!profiles.length) {
    usage();
    console.error("\nNo profile.md paths given.");
    process.exitCode = 2;
    return;
  }

  const outDir = opts.out ?? join(homedir(), ".agents", "subagents");
  const tools = opts.tools ?? DEFAULT_TOOLS;

  const results = [];
  for (const profilePath of profiles) {
    const raw = await readFile(profilePath, "utf8");
    const { fm, body } = parseCustomFrontmatter(raw);
    const id = normalizeId(
      fm.id || fm.name || basename(profilePath).replace(/\.md$/i, ""),
    );
    const prompt = extractSystemPrompt(body) || synthesizePrompt(fm, body);
    const definition = generateDefinition(fm, prompt, tools);
    const outPath = join(outDir, `${id}.md`);
    results.push({ id, prompt, definition, outPath, profilePath });
  }

  if (opts.verify) {
    for (const result of results) {
      result.parsed = parseSubagentDefinition(result.definition, {
        source: "user",
        fallbackName: result.id,
        filePath: result.outPath,
      });
    }
  }

  if (!opts.dryRun) {
    await mkdir(outDir, { recursive: true });
    for (const result of results) {
      await writeFile(result.outPath, result.definition, "utf8");
    }
  }

  for (const result of results) {
    const parsed = result.parsed;
    console.log(`\n=== ${result.id} ===`);
    console.log(`  source : ${result.profilePath}`);
    console.log(`  output : ${result.outPath}${opts.dryRun ? " (dry-run)" : ""}`);
    console.log(`  prompt : ${result.prompt.length} chars`);
    if (parsed) {
      if (parsed.ok) {
        const d = parsed.definition;
        console.log(`  VERIFY : OK  name="${d.name}" tools=[${d.tools.join(", ")}]`);
        if (parsed.warnings.length) {
          for (const w of parsed.warnings) console.log(`    warn: ${w}`);
        }
      } else {
        console.log(`  VERIFY : FAIL`);
        for (const e of parsed.errors) console.log(`    error: ${e}`);
        for (const w of parsed.warnings) console.log(`    warn: ${w}`);
      }
    }
  }

  console.log(
    `\n${opts.dryRun ? "Dry run" : "Wrote"} ${results.length} document(s) -> ${outDir}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
