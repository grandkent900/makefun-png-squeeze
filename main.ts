// png-squeeze: lossless PNG recompression, Node builtins only.
//
// Pipeline: exact colour-type reduction (palette / grey / grey+alpha / RGB /
// RGBA, plus a tRNS key when the image has a single transparent value),
// per-row filter choice (true-deflate-cost brute force, zero-order entropy,
// fixed None), then the winning filtered image is compressed with a
// purpose-built optimal-parsing DEFLATE encoder (hash-chain longest match
// with structural row-stride distances, forward dynamic programming over
// literal / match options, two rounds of Huffman re-estimation, fixed-size
// blocks), falling back to zlib level 9 whenever that is smaller.
// Every choice is a fixed function of the input bytes: no clock, no
// randomness, no environment-dependent variation, so two runs are identical.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync, deflateSync, constants } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- CRC / PNG

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function pngOf(chunks) {
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------------------------------------------------------------- decode

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes) {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(`bad CRC in ${type}`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], interlace: data[12] };
      if (header.depth !== 8 || header.interlace !== 0 || !Object.hasOwn(CHANNELS, header.colourType)) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else throw new Error(`unsupported chunk ${type}`);
  }
  if (!ended || !header || idat.length === 0) throw new Error('truncated PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('IDAT inflates to wrong length');
  const samples = new Uint8Array(height * stride);
  let allNone = true;
  for (let y = 0; y < height; y++) if (raw[y * (stride + 1)] !== 0) { allNone = false; break; }
  if (allNone) {
    for (let y = 0; y < height; y++) samples.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  } else {
    for (let y = 0; y < height; y++) {
      const ft = raw[y * (stride + 1)];
      const src = y * (stride + 1) + 1;
      const o = y * stride;
      const p = o - stride;
      if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
      else if (ft === 1) {
        for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
      } else if (ft === 2) {
        for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
      } else if (ft === 3) {
        for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      } else if (ft === 4) {
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? samples[o + i - bpp] : 0;
          const b = y > 0 ? samples[p + i] : 0;
          const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
          samples[o + i] = raw[src + i] + paeth(a, b, c);
        }
      } else throw new Error(`bad filter type ${ft}`);
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i] * 3;
      rgba[d] = palette[e]; rgba[d + 1] = palette[e + 1]; rgba[d + 2] = palette[e + 2];
      rgba[d + 3] = trns !== null && samples[i] < trns.length ? trns[samples[i]] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- analysis

function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d], g = rgba[d + 1], b = rgba[d + 2], a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || g !== b) grey = false;
    if (!many) {
      const key = (r << 24) | (g << 16) | (b << 8) | a;
      const k = counts.get(key);
      if (k === undefined) {
        if (counts.size >= 256) many = true;
        else counts.set(key, 1);
      } else counts.set(key, k + 1);
    }
  }
  return { opaque, grey, colours: many ? null : counts };
}

// The one fully transparent value (grey sample or RGB triple) the image may
// key by tRNS instead of carrying an alpha channel, or null.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

function paletteForm(rgba, counts, order) {
  const entries = [...counts.entries()].map(([key, count]) => {
    const u = key >>> 0;
    return { key: u, r: (u >>> 24) & 255, g: (u >>> 16) & 255, b: (u >>> 8) & 255, a: u & 255, count };
  });
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  entries.sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.key - y.key;
    return y.count - x.count || x.key - y.key;
  });
  const index = new Map(entries.map((c, i) => [c.key, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r; plte[i * 3 + 1] = c.g; plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const key = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
    indices[i] = index.get(key);
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns });
  return forms;
}

// ---------------------------------------------------------------- filtering

// Filter one row by every filter type into trial[t]; accumulate each type's
// byte histogram (for the entropy estimate) in the same pass.
function filterTrials(samples, curOff, prevOff, stride, bpp, trial, hist) {
  hist.fill(0);
  const out0 = trial[0], out1 = trial[1], out2 = trial[2], out3 = trial[3], out4 = trial[4];
  const hasPrev = prevOff >= 0;
  for (let i = 0; i < stride; i++) {
    const cur = samples[curOff + i];
    const left = i >= bpp ? samples[curOff + i - bpp] : 0;
    const up = hasPrev ? samples[prevOff + i] : 0;
    const upLeft = hasPrev && i >= bpp ? samples[prevOff + i - bpp] : 0;
    let v;
    v = cur; out0[i] = v; hist[v]++;
    v = (cur - left) & 255; out1[i] = v; hist[256 + v]++;
    v = (cur - up) & 255; out2[i] = v; hist[512 + v]++;
    v = (cur - ((left + up) >> 1)) & 255; out3[i] = v; hist[768 + v]++;
    v = (cur - paeth(left, up, upLeft)) & 255; out4[i] = v; hist[1024 + v]++;
  }
}

function entropyBits(hist, base, len) {
  const logLen = Math.log2(len);
  let bits = 0;
  for (let b = 0; b < 256; b++) {
    const c = hist[base + b];
    if (c > 0) bits += c * (logLen - Math.log2(c));
  }
  return bits;
}

// Build three candidate filtered images for one form:
// [0] per-row brute force (true deflate cost, level 4, 32 KiB dictionary),
// [1] per-row minimum entropy, [2] fixed None. Lowest filter type wins ties.
function buildCandidates(samples, width, height, bpp) {
  const stride = width * bpp;
  const rowLen = stride + 1;
  const total = height * rowLen;
  const raws = [];
  for (let c = 0; c < 3; c++) raws.push(new Uint8Array(total));
  const trial = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride));
  const trialFull = new Uint8Array(rowLen);
  const hist = new Int32Array(5 * 256);
  for (let y = 0; y < height; y++) {
    const curOff = y * stride;
    const prevOff = y > 0 ? (y - 1) * stride : -1;
    filterTrials(samples, curOff, prevOff, stride, bpp, trial, hist);
    const at = y * rowLen;
    const dict = y > 0 ? raws[0].subarray(Math.max(0, at - 32768), at) : null;
    let bruteType = 0;
    let bruteBest = Infinity;
    for (let t = 0; t < 5; t++) {
      trialFull[0] = t;
      trialFull.set(trial[t], 1);
      const opts = dict === null ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: dict };
      const len = deflateSync(trialFull, opts).length;
      if (len < bruteBest) { bruteBest = len; bruteType = t; }
    }
    let entType = 0;
    let entBest = Infinity;
    for (let t = 0; t < 5; t++) {
      const bits = entropyBits(hist, t * 256, stride);
      if (bits < entBest) { entBest = bits; entType = t; }
    }
    const picks = [bruteType, entType, 0];
    for (let c = 0; c < 3; c++) {
      const t = picks[c];
      raws[c][at] = t;
      raws[c].set(trial[t], at + 1);
    }
  }
  return raws;
}

// ---------------------------------------------------------------- optimal DEFLATE

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const LEN_SYMBOL = new Uint8Array(259);
for (let s = 0; s < 29; s++) {
  const lo = LEN_BASE[s];
  const hi = s === 28 ? 258 : LEN_BASE[s + 1] - 1;
  for (let l = lo; l <= hi; l++) LEN_SYMBOL[l] = s;
}
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const DIST_SYM = new Uint8Array(32769);
for (let d = 1; d <= 32768; d++) {
  let s = 0;
  while (s < 29 && DIST_BASE[s + 1] <= d) s++;
  DIST_SYM[d] = s;
}
function distSymbol(d) { return DIST_SYM[d]; }
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const OPT_BLOCK = 200000;
const OPT_CHAIN = 256;
const OPT_HASH_BITS = 16;
const OPT_HASH_SIZE = 1 << OPT_HASH_BITS;

// Length-limited Huffman code lengths from frequencies: plain Huffman tree,
// clamped to maxBits with a Kraft-exact repair; if the repair cannot reach
// Kraft 1 exactly, frequencies are halved and the tree rebuilt (all-ones
// frequencies give depth <= 9, so this always terminates).
function huffmanLengths(freqIn, maxBits) {
  let freq = freqIn;
  for (let attempt = 0; attempt < 40; attempt++) {
    const got = huffmanLengthsOnce(freq, maxBits);
    if (got !== null) return got;
    freq = Float64Array.from(freq, (f) => (f > 0 ? Math.max(1, f >> 1) : 0));
  }
  return new Uint8Array(freqIn.length);
}

function huffmanLengthsOnce(freq, maxBits) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  let heap = [];
  for (let s = 0; s < n; s++) if (freq[s] > 0) heap.push({ f: freq[s], sym: s, left: null, right: null });
  if (heap.length === 0) return lengths;
  if (heap.length === 1) { lengths[heap[0].sym] = 1; return lengths; }
  heap.sort((a, b) => a.f - b.f);
  const q1 = heap, q2 = [];
  let i1 = 0, i2 = 0;
  const take = () => {
    if (i2 >= q2.length || (i1 < q1.length && q1[i1].f <= q2[i2].f)) return q1[i1++];
    return q2[i2++];
  };
  let remaining = heap.length;
  while (remaining > 1) {
    const a = take(), b = take();
    q2.push({ f: a.f + b.f, sym: -1, left: a, right: b });
    remaining--;
  }
  const root = q2[q2.length - 1];
  const walk = (node, d) => {
    if (node.sym >= 0) { lengths[node.sym] = d; return; }
    walk(node.left, d + 1); walk(node.right, d + 1);
  };
  walk(root, 0);
  let maxd = 0;
  for (let s = 0; s < n; s++) if (lengths[s] > maxd) maxd = lengths[s];
  if (maxd <= maxBits) return lengths;
  const total = 1 << maxBits;
  let units = 0;
  for (let s = 0; s < n; s++) {
    if (lengths[s] > maxBits) lengths[s] = maxBits;
    if (lengths[s] > 0) units += 1 << (maxBits - lengths[s]);
  }
  let excess = units - total;
  if (excess > 0) {
    const order = [];
    for (let s = 0; s < n; s++) if (freq[s] > 0) order.push(s);
    order.sort((a, b) => freq[a] - freq[b]);
    while (excess > 0) {
      let progressed = false;
      for (let l = maxBits - 1; l >= 0 && excess > 0; l--) {
        const step = 1 << (maxBits - 1 - l);
        if (step > excess) continue;
        for (const s of order) {
          if (excess <= 0) break;
          if (lengths[s] === l) { lengths[s]++; excess -= step; progressed = true; }
        }
      }
      if (!progressed) {
        let best = -1, bestL = -1;
        for (const s of order) if (lengths[s] < maxBits && lengths[s] > bestL) { best = s; bestL = lengths[s]; }
        if (best < 0) break;
        lengths[best]++;
        excess -= 1 << (maxBits - 1 - bestL);
        while (excess < 0) {
          let ms = -1;
          for (let i = order.length - 1; i >= 0; i--) if (lengths[order[i]] === maxBits) { ms = order[i]; break; }
          if (ms < 0) break;
          lengths[ms]--;
          excess += 1;
        }
      }
    }
  }
  if (maxd > maxBits) {
    let u = 0;
    for (let s = 0; s < n; s++) if (lengths[s] > 0) u += 1 << (maxBits - lengths[s]);
    if (u !== total) return null;
  }
  return lengths;
}

function canonicalCodes(lengths) {
  const n = lengths.length;
  const codes = new Uint32Array(n);
  const blCount = new Int32Array(16);
  for (let s = 0; s < n; s++) blCount[lengths[s]]++;
  blCount[0] = 0;
  const nextCode = new Int32Array(16);
  let code = 0;
  for (let b = 1; b < 16; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  for (let s = 0; s < n; s++) {
    const l = lengths[s];
    if (l > 0) codes[s] = nextCode[l]++;
  }
  return codes;
}

class BitWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.bitbuf = 0; this.bitcnt = 0; }
  ensure(n) {
    if (this.pos + n + 8 > this.buf.length) {
      const nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n + 1024));
      nb.set(this.buf.subarray(0, this.pos)); this.buf = nb;
    }
  }
  write(code, len) {
    this.bitbuf |= code << this.bitcnt;
    this.bitcnt += len;
    while (this.bitcnt >= 8) {
      this.ensure(1);
      this.buf[this.pos++] = this.bitbuf & 255;
      this.bitbuf >>>= 8; this.bitcnt -= 8;
    }
  }
  align() {
    if (this.bitcnt > 0) { this.ensure(1); this.buf[this.pos++] = this.bitbuf & 255; this.bitbuf = 0; this.bitcnt = 0; }
  }
  writeRev(code, len) {
    let rev = 0;
    for (let i = 0; i < len; i++) { rev = (rev << 1) | ((code >> i) & 1); }
    this.write(rev, len);
  }
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Greedy tokenization (longest match, one-step lazy) for initial frequencies.
function greedyTokens(data, start, blen, mLen, mDist) {
  const tokens = [];
  let i = 0;
  while (i < blen) {
    const L = mLen[i];
    if (L >= 3) {
      const Lnext = i + 1 < blen ? mLen[i + 1] : 0;
      if (Lnext > L) { tokens.push({ pos: i, len: 0, dist: 0 }); i++; continue; }
      tokens.push({ pos: i, len: L, dist: mDist[i] }); i += L;
    } else { tokens.push({ pos: i, len: 0, dist: 0 }); i++; }
  }
  return tokens;
}

// Forward dynamic programming over literal / match options. Each position
// offers up to three matches: the longest found, the most recent, and the
// best at a structural row-stride distance. Returns tokens.
function parseDP(data, start, blen, mLen, mDist, mLen2, mDist2, mLen3, mDist3, litBits, lenBits, distBits) {
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) lenCost[l] = lenBits[LEN_SYMBOL[l]] + LEN_EXTRA[LEN_SYMBOL[l]];
  const distCost = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) distCost[d] = distBits[DIST_SYM[d]] + DIST_EXTRA[DIST_SYM[d]];
  const candTable = [];
  for (let L = 3; L <= 258; L++) {
    const arr = [];
    for (let s = 0; s < 29; s++) {
      const hi = s === 28 ? 258 : LEN_BASE[s + 1] - 1;
      if (LEN_BASE[s] > L) break;
      arr.push(Math.min(L, hi));
    }
    candTable[L] = arr;
  }
  const cost = new Float64Array(blen + 1).fill(Infinity);
  const choice = new Int16Array(blen + 1);
  const choiceDist = new Int32Array(blen + 1);
  cost[0] = 0;
  for (let i = 0; i < blen; i++) {
    const c = cost[i];
    if (c === Infinity) continue;
    const nc = c + litBits[data[start + i]];
    if (nc < cost[i + 1]) { cost[i + 1] = nc; choice[i + 1] = 0; }
    for (let pi = 0; pi < 3; pi++) {
      const L = pi === 0 ? mLen[i] : pi === 1 ? mLen2[i] : mLen3[i];
      if (L < 3) continue;
      const D = pi === 0 ? mDist[i] : pi === 1 ? mDist2[i] : mDist3[i];
      const base = c + distCost[D];
      const cl = candTable[L];
      for (let j = 0; j < cl.length; j++) {
        const l = cl[j];
        const nc2 = base + lenCost[l];
        if (nc2 < cost[i + l]) { cost[i + l] = nc2; choice[i + l] = l; choiceDist[i + l] = D; }
      }
    }
  }
  const tokens = [];
  let i = blen;
  while (i > 0) {
    const l = choice[i];
    if (l === 0) { tokens.push({ pos: i - 1, len: 0, dist: 0 }); i--; }
    else { tokens.push({ pos: i - l, len: l, dist: choiceDist[i] }); i -= l; }
  }
  tokens.reverse();
  return tokens;
}

function emitBlock(out, data, start, tokens, litLengths, distLengths, isLast) {
  let lastLit = 285;
  while (lastLit > 256 && litLengths[lastLit] === 0) lastLit--;
  let lastDist = 29;
  while (lastDist > 0 && distLengths[lastDist] === 0) lastDist--;
  const allLengths = new Uint8Array(288 + 30);
  allLengths.set(litLengths.subarray(0, 286), 0);
  allLengths.set(distLengths.subarray(0, 30), 286);
  const totalCodes = 286 + (lastDist + 1);
  const clSymbols = [];
  const clFreq = new Float64Array(19);
  let i = 0;
  const lens = allLengths.subarray(0, totalCodes);
  while (i < lens.length) {
    const v = lens[i];
    let run = 1;
    while (i + run < lens.length && lens[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) { const take = Math.min(r, 138); clSymbols.push([18, take - 11]); clFreq[18]++; r -= take; }
      if (r >= 3) { clSymbols.push([17, r - 3]); clFreq[17]++; r = 0; }
      while (r > 0) { clSymbols.push([0, 0]); clFreq[0]++; r--; }
    } else {
      clSymbols.push([v, 0]); clFreq[v]++;
      let r = run - 1;
      while (r >= 3) { const take = Math.min(r, 6); clSymbols.push([16, take - 3]); clFreq[16]++; r -= take; }
      while (r > 0) { clSymbols.push([v, 0]); clFreq[v]++; r--; }
    }
    i += run;
  }
  const clLengths = huffmanLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLengths[CL_ORDER[hclen - 1]] === 0) hclen--;
  const litCodes = canonicalCodes(litLengths);
  const distCodes = canonicalCodes(distLengths);
  const clCodes = canonicalCodes(clLengths);
  out.write(isLast ? 1 : 0, 1);
  out.write(2, 2);
  out.write(lastLit - 256, 5);
  out.write(lastDist, 5);
  out.write(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) out.write(clLengths[CL_ORDER[k]], 3);
  for (const [sym, extra] of clSymbols) {
    out.writeRev(clCodes[sym], clLengths[sym]);
    if (sym === 16) out.write(extra, 2);
    else if (sym === 17) out.write(extra, 3);
    else if (sym === 18) out.write(extra, 7);
  }
  for (const t of tokens) {
    if (t.len === 0) {
      const s = data[start + t.pos];
      out.writeRev(litCodes[s], litLengths[s]);
    } else {
      const ls = LEN_SYMBOL[t.len];
      out.writeRev(litCodes[257 + ls], litLengths[257 + ls]);
      out.write(t.len - LEN_BASE[ls], LEN_EXTRA[ls]);
      const ds = distSymbol(t.dist);
      out.writeRev(distCodes[ds], distLengths[ds]);
      out.write(t.dist - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  out.writeRev(litCodes[256], litLengths[256]);
}

// Optimal-parsing DEFLATE of `data` (a filtered PNG image), with row-stride
// distances supplied for structural matches. Returns a zlib stream.
function deflateOptimal(data, rowLen) {
  const n = data.length;
  const strides = [];
  for (let k = 1; k <= 24; k++) strides.push(rowLen * k);
  const out = new BitWriter(n + 4096);
  const head = new Int32Array(OPT_HASH_SIZE).fill(-1);
  const prev = new Int32Array(32768);
  let blockStart = 0;
  while (blockStart < n) {
    const blockEnd = Math.min(n, blockStart + OPT_BLOCK);
    const blen = blockEnd - blockStart;
    const isLast = blockEnd === n;
    const mLen = new Int16Array(blen);
    const mDist = new Int32Array(blen);
    const mLen2 = new Int16Array(blen);
    const mDist2 = new Int32Array(blen);
    const mLen3 = new Int16Array(blen);
    const mDist3 = new Int32Array(blen);
    for (let i = 0; i < blen; i++) {
      const pos = blockStart + i;
      if (pos + 2 >= n) continue;
      const v = (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2];
      const h = (Math.imul(v, 2654435761) >>> 16) & (OPT_HASH_SIZE - 1);
      let cand = head[h];
      prev[pos & 32767] = cand;
      head[h] = pos;
      const firstCand = cand;
      const maxLen = Math.min(258, blockEnd - pos);
      let bestLen = 0, bestDist = 0;
      let steps = 0;
      const limit = Math.max(0, pos - 32768);
      let chainCap = OPT_CHAIN;
      while (cand >= limit && steps < chainCap) {
        steps++;
        if (bestLen > 0 && data[cand + bestLen] !== data[pos + bestLen]) { cand = prev[cand & 32767]; continue; }
        let l = 0;
        while (l + 4 <= maxLen) {
          const wa = data[cand + l] | (data[cand + l + 1] << 8) | (data[cand + l + 2] << 16) | (data[cand + l + 3] << 24);
          const wb = data[pos + l] | (data[pos + l + 1] << 8) | (data[pos + l + 2] << 16) | (data[pos + l + 3] << 24);
          if (wa !== wb) break;
          l += 4;
        }
        while (l < maxLen && data[cand + l] === data[pos + l]) l++;
        if (l > bestLen) {
          bestLen = l; bestDist = pos - cand;
          if (l >= maxLen) break;
          if (l >= 32) chainCap = Math.min(chainCap, steps + 32);
        }
        cand = prev[cand & 32767];
      }
      if (bestLen >= 3) { mLen[i] = bestLen; mDist[i] = bestDist; }
      if (firstCand >= 0 && firstCand >= limit) {
        let l2 = 0;
        const ml2 = Math.min(258, blockEnd - pos);
        while (l2 < ml2 && data[firstCand + l2] === data[pos + l2]) l2++;
        if (l2 >= 3) { mLen2[i] = l2; mDist2[i] = pos - firstCand; }
      }
      const ml0 = Math.min(258, blockEnd - pos);
      for (let si = 0; si < strides.length; si++) {
        if (bestLen >= ml0) break;
        const d = strides[si];
        if (d <= 0 || d > pos || d > 32768) continue;
        const cand2 = pos - d;
        if (cand2 < 0) continue;
        if (data[cand2] !== data[pos] || data[cand2 + 1] !== data[pos + 1] || data[cand2 + 2] !== data[pos + 2]) continue;
        if (bestLen > 2 && data[cand2 + bestLen] !== data[pos + bestLen]) continue;
        let l = 3;
        while (l + 4 <= ml0) {
          const wa = data[cand2 + l] | (data[cand2 + l + 1] << 8) | (data[cand2 + l + 2] << 16) | (data[cand2 + l + 3] << 24);
          const wb = data[pos + l] | (data[pos + l + 1] << 8) | (data[pos + l + 2] << 16) | (data[pos + l + 3] << 24);
          if (wa !== wb) break;
          l += 4;
        }
        while (l < ml0 && data[cand2 + l] === data[pos + l]) l++;
        if (l > mLen3[i]) { mLen3[i] = l; mDist3[i] = d; }
        if (l > bestLen) bestLen = l;
      }
    }
    const freqOf = (toks) => {
      const litFreq = new Float64Array(288);
      const distFreq = new Float64Array(30);
      for (const t of toks) {
        if (t.len === 0) litFreq[data[blockStart + t.pos]]++;
        else { litFreq[257 + LEN_SYMBOL[t.len]]++; distFreq[distSymbol(t.dist)]++; }
      }
      litFreq[256] = 1;
      if (distFreq.reduce((a, b) => a + b, 0) === 0) distFreq[0] = 1;
      return { litFreq, distFreq };
    };
    const costsOf = (litLengths, distLengths) => {
      const litBits = new Float64Array(288);
      for (let s = 0; s < 288; s++) litBits[s] = litLengths[s] === 0 ? 30 : litLengths[s];
      const lenBits = new Float64Array(29);
      for (let s = 0; s < 29; s++) lenBits[s] = litLengths[257 + s] === 0 ? 30 : litLengths[257 + s];
      const distBits = new Float64Array(30);
      for (let s = 0; s < 30; s++) distBits[s] = distLengths[s] === 0 ? 30 : distLengths[s];
      return { litBits, lenBits, distBits };
    };
    let { litFreq, distFreq } = freqOf(greedyTokens(data, blockStart, blen, mLen, mDist));
    let litLengths = huffmanLengths(litFreq, 15);
    let distLengths = huffmanLengths(distFreq, 15);
    let { litBits, lenBits, distBits } = costsOf(litLengths, distLengths);
    let tokens = null;
    for (let iter = 0; iter < 2; iter++) {
      tokens = parseDP(data, blockStart, blen, mLen, mDist, mLen2, mDist2, mLen3, mDist3, litBits, lenBits, distBits);
      ({ litFreq, distFreq } = freqOf(tokens));
      litLengths = huffmanLengths(litFreq, 15);
      distLengths = huffmanLengths(distFreq, 15);
      ({ litBits, lenBits, distBits } = costsOf(litLengths, distLengths));
      if (iter === 1) emitBlock(out, data, blockStart, tokens, litLengths, distLengths, isLast);
    }
    blockStart = blockEnd;
  }
  out.align();
  const body = out.buf.subarray(0, out.pos);
  const res = new Uint8Array(body.length + 6);
  res[0] = 0x78; res[1] = 0x9c;
  res.set(body, 2);
  const ad = adler32(data);
  res[res.length - 4] = (ad >>> 24) & 255;
  res[res.length - 3] = (ad >>> 16) & 255;
  res[res.length - 2] = (ad >>> 8) & 255;
  res[res.length - 1] = ad & 255;
  return res;
}

// ---------------------------------------------------------------- encode

function chunkBytes(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

function encodeImage(rgba, width, height) {
  let best = null; // { bytes, zlib, form, raw }
  for (const form of formsOf(rgba)) {
    const overhead = chunkBytes(form);
    const raws = buildCandidates(form.samples, width, height, form.bpp);
    for (const raw of raws) {
      const zlib = deflateSync(raw, { level: 9, memLevel: 9 });
      const bytes = zlib.length + overhead;
      if (best === null || bytes < best.bytes) best = { bytes, zlib, form, raw };
    }
  }
  // Deterministic zlib variants on the winning filtered data.
  const variants = [
    { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
    { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
  ];
  for (const opts of variants) {
    const zlib = deflateSync(best.raw, opts);
    const bytes = zlib.length + chunkBytes(best.form);
    if (bytes < best.bytes) best = { bytes, zlib, form: best.form, raw: best.raw };
  }
  // Optimal-parsing DEFLATE on the winning filtered data; keep whichever
  // of it and the best zlib stream is smaller.
  const optimal = deflateOptimal(best.raw, width * best.form.bpp + 1);
  if (optimal.length + chunkBytes(best.form) < best.bytes) {
    best = { bytes: optimal.length + chunkBytes(best.form), zlib: optimal, form: best.form, raw: best.raw };
  }
  const chunks = [['IHDR', ihdrOf(width, height, best.form.colourType)]];
  if (best.form.plte !== null) chunks.push(['PLTE', best.form.plte]);
  if (best.form.trns !== null) chunks.push(['tRNS', best.form.trns]);
  chunks.push(['IDAT', new Uint8Array(best.zlib)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------------------------------------------------------------- main

for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), encodeImage(image.rgba, image.width, image.height));
}
