# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/hungndp/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/hungndp/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

Entry for the [make.fun bounty "Build a static site faster, 22 November 2026"](https://make.fun/bounty/site-generator-speed-01-run-20261122).

A faster drop-in for make.fun's own makefun-site 1.0.0.

`solve.js` exports `run(input)`, which returns exactly what makefun-site 1.0.0's
`build` returns for the same input: the output tree as a JSON object of every path
it writes and that file's text, byte for byte. `main.ts` is the program the harness
runs: it reads every case from `/input/cases.json`, answers each one alone with
`run`, and writes `/output/answers.json`.

How it is faster, with no change in output:

- **Markdown, one pass.** Bodies are rendered in a single line scan (no token
  objects, no re-lexing): plain runs are found with one shared regex scan and
  escaped in bulk, and the word count for `reading_minutes` is fused into the
  same scan instead of re-scanning the body.
- **Templates compiled to functions.** Each template is parsed once per case and
  compiled (via `new Function`) into a plain render function over a flat scope
  object, so rendering is direct property reads and string pushes instead of a
  tree walk with a scope chain per node.
- **Constant templates cached.** Templates whose render depends only on the
  case's constants (`site`, `tags`, `recent`) — the header, navigation, footer
  and the filler partials that read nothing else — are rendered once per include
  depth and cached for the case. A small static analysis proves which templates
  those are (free names, plus a check that no include site binds one of them in
  a loop); any include cycle disables the cache outright.
- **Memoised slugs and long dates**, and front matter found with `indexOf`
  instead of splitting and rejoining the whole body.

Nothing is cached from one case to the next: every `run()` starts with fresh
memo tables and a fresh template cache.

Verified locally: the kit scorer passes 3/3 on the practice set, and the entry
matches makefun-site byte for byte on 27 generated cases across 9 different
generator seeds. Deterministic: two runs on the practice set write identical
`answers.json`.
