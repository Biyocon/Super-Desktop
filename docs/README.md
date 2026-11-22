# PI-Desktop Docs

`docs/` is a VitePress project. The published site starts at [`index.md`](index.md);
the repository's English technical source of truth remains organized under
`spec/` and `adr/`.

## Local commands

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
pnpm docs:check
pnpm check:documentation
pnpm test:documentation
```

The aggregate docs:check keeps the existing locale and page/ADR checks and adds the pinned Project Documentation audit plus its regression tests. The audit validates local anchors, ADR index statuses, successor identities and cycles, frozen archives and exact baseline entries. Unresolved audit observations also fail this project's gate. Historical docs/project records retain their original outbound-link/version context; links from current documents to them are still checked.

The portable checker and third-party notices live under .agents/docs/tools; config.json in the parent directory maps existing document owners and the section-owned decision log. The initial baseline is empty. Target projects need Node 22.19 or newer and no separate npm installation for this audit. Tool updates require reviewing the version and checksum receipt together; the gate rejects a locally modified bundle.

The existing Docs checks CI job now runs for every pull request and push to main. It supplies DOCS_BASE_REF from the PR base, previous push commit or manual-run commit and fetches full history. Missing or unavailable CI bases fail the gate. For the same baseline/archive comparison locally, run node scripts/check-documentation.mjs --base-ref REV. A plain local docs:check has no base comparison unless DOCS_BASE_REF is set. Existing defects cannot be silently added to the baseline: the CI comparison requires the checker's explicit maintenance receipt for any expansion.

The workflow retains policy-sync and site build. Repository branch protection must separately require its existing Docs checks job for GitHub to block merging; a workflow file alone does not configure that setting.

## Layout notes

- `spec/` and `adr/` are the English source of truth; `zh-CN/` mirrors
  `spec/` and `guide/` path for path and is checked by `pnpm docs:check`.
- `image/` holds pictures embedded by the repository READMEs. `public/` holds
  assets served by the site itself (brand mark, screenshots).
- `project/` keeps historical planning records; current status lives in the
  changelog and GitHub Issues.

## Entry points

- [English documentation site](index.md)
- [中文入口](zh-CN/index.md)
- [Quick guide](guide/index.md)
- [Specification index](spec/README.md)
- [ADR index](adr/README.md)
- [Plugin development](plugin-development.md)
- [Visual verification](project/2026-08-13-docs-redesign-verification.md)

The Chinese entry point mirrors the English reading paths and includes a
path-for-path companion for every specification. Each translated page links to
the canonical English source and preserves code, protocol fields, and
identifiers. The generated sidebar keeps both locale trees complete as the
specification set grows.
