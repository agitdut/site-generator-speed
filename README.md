# site-generator-speed-01 — a faster makefun-site 1.0.0

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/agitdut/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/agitdut/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A dependency-free, drop-in replacement for `makefun-site` 1.0.0 whose
`run(input)` returns the **same answer, byte for byte**, for every input —
and does it faster. On the kit's practice set (3 cases, 257–486 files each)
it passes **3/3** against the oracle, and runs about **1.4x faster
end-to-end** than the house baseline (about 1.8x on the build itself, the
rest being the driver's fixed JSON parse/stringify).

## Where the speed comes from

- **Inline Markdown** scans plain text in whole chunks between markers
  instead of escaping one character at a time.
- **The block lexer** dispatches on each line's first character instead of
  running six regular expressions per line.
- **Front matter** is parsed by scanning line boundaries with `indexOf`
  instead of splitting the whole file (bodies can be large).
- **Templates** render into an array of fragments joined once, instead of
  concatenating a string node by node.
- **Line ends** are normalised and **heading ids** are de-duplicated exactly
  as the reference does; nothing else about the semantics changed.

## Files

- `solve.js` — the whole generator: text rules, front matter, Markdown,
  templates, and the build pipeline. No imports, no dependencies.
- `main.ts` — the kit driver, kept verbatim: reads `/input/cases.json`,
  answers each case with `run()` from `solve.js`, writes
  `/output/answers.json`.
- `package.json` — `{"type": "module"}` so `solve.js` loads as ESM.

## Verification

Against the kit's practice set (expected answers from the oracle):

```
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=<out> node main.ts
# then the kit scorer with MAKEFUN_OUTPUT_DIR=<out>:
# {"passed":1,"cases_passed":3,"cases_total":3}
```

A differential test over 7 adversarial suites (CRLF endings, front-matter
edge cases, duplicate headings, slug collisions, deep includes, shadowed
statics, empty bodies) also matches the reference byte for byte.
