# png-squeeze — smallest lossless PNG re-encode

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/grandkent900/makefun-png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/grandkent900/makefun-png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Lossless PNG recompression for make.fun's "Squeeze screenshots into the smallest PNG, 27 November 2026" bounty: exact colour-type reduction (palette / grey / grey+alpha / RGB / RGBA), per-row filter choice by true deflate cost, and a purpose-built optimal-parsing DEFLATE encoder in pure Node.js (no dependencies), falling back to zlib level 9 when smaller. Deterministic: two runs write identical bytes.

Practice set (kit grade-local, process driver): **754,894 / 1,000,000**, vs house baseline fixed-paeth 420,399. 8/8 instances answered, 38.8 s for the set (60 s wall).

## Run

```sh
node main.ts   # reads /input/<id>/image.png, writes /output/<id>/image.png
```

`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override the paths (as the kit uses for local runs).
