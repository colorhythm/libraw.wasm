// Sweep: decode every Eyrie test raw via the freshly built libraw.wasm and diff
// against its Python reference bundle. Source-aware: cam_xyz is only compared when
// the bundle's characterization came from libraw (not the DNG-profile path).
// Usage: node sweep-eyrie.mjs <test_files_dir>
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import initLibRaw from "./packages/libraw.wasm/dist/libraw.mjs";

const dir = process.argv[2] ?? "/Users/jharmon/df/eyrie/test_files";
const bundleDir = join(dir, "bundles");
const wasmPath = fileURLToPath(
    new URL("./packages/libraw.wasm/dist/libraw.wasm", import.meta.url),
);
const Module = await initLibRaw({ wasmBinary: readFileSync(wasmPath) });

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function decode(rawPath, geo) {
    const lr = Module._libraw_init(0);
    const bytes = readFileSync(rawPath);
    const buf = Module._malloc(bytes.length);
    Module.HEAPU8.set(bytes, buf);
    let rc = Module._libraw_open_buffer(lr, buf, bytes.length);
    if (rc !== 0) { Module._free(buf); Module._libraw_close(lr); throw new Error(`open rc=${rc}`); }
    rc = Module._libraw_unpack(lr);
    if (rc !== 0) { Module._free(buf); Module._libraw_close(lr); throw new Error(`unpack rc=${rc}`); }

    const rawW = Module._libraw_get_raw_width(lr);
    const rawH = Module._libraw_get_raw_height(lr);
    const black = Module._libraw_get_black(lr);
    const cblack = [0, 1, 2, 3].map((i) => Module._libraw_get_cblack(lr, i));
    const perChanBlack = cblack.map((cb) => black + cb);
    const camXyz = [0, 1, 2].map((i) => [0, 1, 2].map((j) => Module._libraw_get_cam_xyz(lr, i, j)));

    let fullMax = null, activeMax = null;
    const ptr = Module._libraw_get_raw_image(lr);
    if (ptr) {
        const u16 = new Uint16Array(Module.HEAPU8.buffer, ptr, rawW * rawH);
        let fm = 0;
        for (let k = 0; k < u16.length; k++) if (u16[k] > fm) fm = u16[k];
        fullMax = fm;
        // Active-area max: exclude declared margins (the "visible" crop the reference uses).
        const t = geo?.marginTop ?? 0, l = geo?.marginLeft ?? 0;
        const aw = geo?.activeWidth ?? rawW, ah = geo?.activeHeight ?? rawH;
        let am = 0;
        for (let row = t; row < t + ah; row++) {
            const base = row * rawW;
            for (let col = l; col < l + aw; col++) { const v = u16[base + col]; if (v > am) am = v; }
        }
        activeMax = am;
    }
    Module._free(buf);
    Module._libraw_close(lr);
    return { rawW, rawH, perChanBlack, camXyz, fullMax, activeMax };
}

const bundles = readdirSync(bundleDir).filter((f) => f.endsWith(".bundle.json")).sort();
const results = [];
for (const bf of bundles) {
    const b = JSON.parse(readFileSync(join(bundleDir, bf), "utf-8"));
    const fn = b.provenance.sourceFilename;
    const model = b.source?.model;
    const ch = b.color?.characterization ?? {};
    const expBlack = b.sensor?.black?.declaredPerChannel ?? null;
    const expObs = b.sensor?.white?.observedMaxPerChannel?.[0] ?? null;
    const expMat = ch.source === "libraw_rgb_xyz_matrix" ? ch.matrix : null;
    let r;
    try {
        r = decode(join(dir, fn), b.geometry);
    } catch (e) {
        results.push({ fn, model, error: e.message });
        continue;
    }
    const dimsOk = r.rawW === b.geometry.rawWidth && r.rawH === b.geometry.rawHeight;
    const blackOk = expBlack ? eq(r.perChanBlack, expBlack) : null;
    const obsOk = expObs != null && r.activeMax != null ? r.activeMax === expObs : null;
    const fullOk = expObs != null && r.fullMax != null ? r.fullMax === expObs : null;
    r.obsNote = obsOk === false ? `active=${r.activeMax} full=${r.fullMax} exp=${expObs}` : null;
    let matErr = null;
    if (expMat && expMat.length === 3) {
        matErr = 0;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
            matErr = Math.max(matErr, Math.abs(r.camXyz[i][j] - expMat[i][j]));
    }
    results.push({ fn, model, dimsOk, blackOk, obsOk, fullOk, obsNote: r.obsNote, matErr, got: r, expBlack, expObs });
}

const m = (v) => (v === null ? "·" : v ? "✅" : "❌");
console.log(`\n${"file".padEnd(34)}${"model".padEnd(13)}dims black  obsMax  cam_xyz`);
for (const r of results) {
    if (r.error) { console.log(`${r.fn.slice(0, 33).padEnd(34)}${(r.model||"").padEnd(13)}ERROR: ${r.error}`); continue; }
    const matCell = r.matErr === null ? "·" : (r.matErr < 1e-3 ? "✅" : `❌ ${r.matErr.toExponential(1)}`);
    console.log(`${r.fn.slice(0, 33).padEnd(34)}${(r.model||"").padEnd(13)} ${m(r.dimsOk)}    ${m(r.blackOk)}     ${m(r.obsOk)}     ${matCell}`);
}

// Summaries
const core = results.filter((r) => !r.error);
const bayer = core.filter((r) => r.model === "flat_bayer");
const fail = (sel, pred) => sel.filter(pred).length;
console.log(`\n--- summary ---`);
console.log(`decoded ${core.length}/${results.length} (errors: ${results.filter(r=>r.error).length})`);
console.log(`flat_bayer dims:   ${fail(bayer, r=>r.dimsOk)}/${bayer.length} match`);
console.log(`cam_xyz (libraw path): ${fail(core, r=>r.matErr!==null && r.matErr<1e-3)}/${fail(core, r=>r.matErr!==null)} match < 1e-3`);
console.log(`black per-channel: ${fail(core, r=>r.blackOk===true)}/${fail(core, r=>r.blackOk!==null)} exact (black+cblack model)`);
console.log(`observed max (active-area): ${fail(core, r=>r.obsOk===true)}/${fail(core, r=>r.obsOk!==null)} exact`);
console.log(`observed max (full-raw):    ${fail(core, r=>r.fullOk===true)}/${fail(core, r=>r.obsOk!==null)} exact`);
const obsMiss = core.filter(r=>r.obsOk===false);
if (obsMiss.length) { console.log(`\nobserved-max still off after active-crop:`); for (const r of obsMiss) console.log(`  ${r.fn.slice(0,33).padEnd(34)} ${r.obsNote}`); }
// Show black mismatches (informative: where the simple black model diverges)
const blackMiss = core.filter(r=>r.blackOk===false);
if (blackMiss.length) {
    console.log(`\nblack mismatches (got vs bundle):`);
    for (const r of blackMiss) console.log(`  ${r.fn.slice(0,33).padEnd(34)} got=${JSON.stringify(r.got.perChanBlack)} exp=${JSON.stringify(r.expBlack)}`);
}
