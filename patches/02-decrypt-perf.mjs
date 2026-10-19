// Perf: bulk memory copies + periodic main-thread yields in WASM decrypt.
// Replaces per-byte copy loops with TypedArray.set() and yields to the event
// loop every 64 chunks (~640KB) so large decrypts no longer freeze the page.
// Yields are safe: each iteration re-acquires the memory view via wasm.H().
export default {
  file: "vendor/upstream-src/lib/decrypt.js",
  replacements: [
    {
      id: "diterb-bulk-copy",
      old: [
        "  const dOff = allocDiterB(diterBBytes.length);",
        "  mem = wasm.H();",
        "  for (let i = 0; i < diterBBytes.length; i++) mem[dOff + i] = diterBBytes[i];",
      ].join("\n"),
      new: [
        "  const dOff = allocDiterB(diterBBytes.length);",
        "  mem = wasm.H();",
        "  mem.set(diterBBytes, dOff); // patched(02): bulk copy",
      ].join("\n"),
    },
    {
      id: "input-bulk-copy",
      old: [
        "  const input = encData instanceof Uint8Array ? encData : new Uint8Array(encData);",
        "  const chunks = [];",
        "  for (let off = 0; off < input.length; off += 10240) {",
        "    const len = Math.min(10240, input.length - off);",
        "    const iOff = allocInput(len);",
        "    mem = wasm.H();",
        "    for (let i = 0; i < len; i++) mem[iOff + i] = input[off + i];",
      ].join("\n"),
      new: [
        "  const input = encData instanceof Uint8Array ? encData : new Uint8Array(encData);",
        "  const chunks = [];",
        "  let yieldTick = 0; // patched(02): periodic event-loop yield",
        "  for (let off = 0; off < input.length; off += 10240) {",
        "    const len = Math.min(10240, input.length - off);",
        "    const iOff = allocInput(len);",
        "    mem = wasm.H();",
        "    mem.set(input.subarray(off, off + len), iOff); // patched(02): bulk copy",
      ].join("\n"),
    },
    {
      id: "chunk-yield",
      old: [
        "      advance();",
        "      more = process_(0);",
        "    }",
        "  }",
      ].join("\n"),
      new: [
        "      advance();",
        "      more = process_(0);",
        "    }",
        "    if ((++yieldTick & 63) === 0) await new Promise((r) => setTimeout(r, 0));",
        "  }",
      ].join("\n"),
    },
  ],
};
