// Eyrie decode probe: drive the freshly built libraw.wasm directly (no TS wrapper),
// decode one raw, and diff the result against Eyrie's Python reference bundle.
// Usage: node probe-eyrie.mjs <raw-file> <bundle.json>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import initLibRaw from "./packages/libraw.wasm/dist/libraw.mjs";

const rawPath = process.argv[2];
const bundlePath = process.argv[3];
const wasmPath = fileURLToPath(
    new URL("./packages/libraw.wasm/dist/libraw.wasm", import.meta.url),
);

const bundle = JSON.parse(readFileSync(bundlePath, "utf-8"));
const Module = await initLibRaw({ wasmBinary: readFileSync(wasmPath) });

const lr = Module._libraw_init(0);

// Load the raw file into wasm memory and open it.
const bytes = readFileSync(rawPath);
const buf = Module._malloc(bytes.length);
Module.HEAPU8.set(bytes, buf); // re-read HEAPU8 each access; memory can grow
let rc = Module._libraw_open_buffer(lr, buf, bytes.length);
if (rc !== 0) throw new Error(`open_buffer failed rc=${rc}`);
rc = Module._libraw_unpack(lr);
if (rc !== 0) throw new Error(`unpack failed rc=${rc}`);

const rawW = Module._libraw_get_raw_width(lr);
const rawH = Module._libraw_get_raw_height(lr);
const camMul = [0, 1, 2, 3].map((i) => Module._libraw_get_cam_mul(lr, i));
const preMul = [0, 1, 2, 3].map((i) => Module._libraw_get_pre_mul(lr, i));
const colorMax = Module._libraw_get_color_maximum(lr);
const dataMax = Module._libraw_get_data_maximum(lr);
const black = Module._libraw_get_black(lr);
const cblack = [0, 1, 2, 3, 4, 5].map((i) => Module._libraw_get_cblack(lr, i));
const camXyz = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => Module._libraw_get_cam_xyz(lr, i, j)),
);
// Per-channel black as LibRaw reports it: scalar black + per-channel cblack.
const perChanBlack = [0, 1, 2, 3].map((c) => black + cblack[c]);

// Walk the raw ADU array; bin min/max/mean by CFA channel (periodic 2x2).
const ptr = Module._libraw_get_raw_image(lr);
const pat = [0, 1].map((r) => [0, 1].map((c) => Module._libraw_COLOR(lr, r, c)));
const u16 = new Uint16Array(Module.HEAPU8.buffer, ptr, rawW * rawH);
const ch = Array.from({ length: 4 }, () => ({ min: Infinity, max: 0, sum: 0, n: 0 }));
for (let row = 0; row < rawH; row++) {
    const pr = pat[row & 1];
    const base = row * rawW;
    for (let col = 0; col < rawW; col++) {
        const v = u16[base + col];
        const s = ch[pr[col & 1]];
        if (v < s.min) s.min = v;
        if (v > s.max) s.max = v;
        s.sum += v;
        s.n++;
    }
}
const obsMax = Math.max(...ch.map((s) => s.max));

Module._libraw_close(lr);

// ---- Diff against the bundle ----
const b = bundle.sensor;
const bw = bundle.whiteBalance ?? {};
const rows = [];
const cmp = (label, got, exp, ok) => rows.push({ label, got, exp, ok });

cmp("raw width", rawW, bundle.geometry.rawWidth, rawW === bundle.geometry.rawWidth);
cmp("raw height", rawH, bundle.geometry.rawHeight, rawH === bundle.geometry.rawHeight);
cmp(
    "black (per channel)",
    JSON.stringify(perChanBlack),
    JSON.stringify(b.black.declaredPerChannel),
    JSON.stringify(perChanBlack) === JSON.stringify(b.black.declaredPerChannel),
);
cmp(
    "observed max",
    obsMax,
    b.white.observedMaxPerChannel?.[0] ?? b.white.nominal,
    obsMax === (b.white.observedMaxPerChannel?.[0] ?? null),
);
cmp("color.maximum (white)", colorMax, b.white.nominal, null);

// cam_xyz vs the bundle's xyz_to_camera characterization matrix.
const expMat = bundle.color?.characterization?.matrix;
if (expMat) {
    let maxErr = 0;
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            maxErr = Math.max(maxErr, Math.abs(camXyz[i][j] - expMat[i][j]));
    cmp("cam_xyz max abs err vs matrix", maxErr.toExponential(2), "< 1e-3", maxErr < 1e-3);
}

const mark = (ok) => (ok === null ? "·" : ok ? "✅" : "❌");
console.log(`\n=== libraw.wasm decode vs bundle: ${bundle.provenance.sourceFilename} ===`);
console.log(`libraw version: ${Module._libraw_version ? "(n/a)" : ""}`);
for (const r of rows)
    console.log(`${mark(r.ok)}  ${r.label.padEnd(30)} got=${r.got}   exp=${r.exp}`);
console.log("\n--- raw values ---");
console.log("cam_mul     :", camMul.map((x) => x.toFixed(4)).join(", "));
console.log("pre_mul     :", preMul.map((x) => x.toFixed(4)).join(", "));
console.log("black scalar:", black, " cblack[0..5]:", cblack.join(","));
console.log("color.max   :", colorMax, " data_maximum:", dataMax);
console.log("CFA 2x2 idx :", JSON.stringify(pat));
console.log("per-channel obs max:", ch.map((s) => s.max).join(", "));
console.log("per-channel obs min:", ch.map((s) => s.min).join(", "));
console.log("cam_xyz:");
for (const r of camXyz) console.log("   ", r.map((x) => x.toFixed(4)).join(", "));

const fails = rows.filter((r) => r.ok === false);
console.log(`\n${fails.length === 0 ? "ALL CHECKS PASSED" : fails.length + " CHECK(S) FAILED"}`);
