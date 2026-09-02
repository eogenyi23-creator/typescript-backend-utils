/**
 * Tests for the Soroban WASM upload pipeline.
 */

import { writeFile, mkdir, rm } from "fs/promises";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { tmpdir } from "os";
import {
  validateWasmPath,
  verifyWasmChunkIntegrity,
  processWasm,
  WasmPipelineConfig,
  WasmChunkRecord,
} from "../src/wasmPipeline.js";

// ---------------------------------------------------------------------------
// WASM magic bytes
// ---------------------------------------------------------------------------

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]); // \0asm

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SANDBOX = join(tmpdir(), `wasm-sandbox-${process.pid}`);
const OUTPUT = join(tmpdir(), `wasm-output-${process.pid}`);

function makeConfig(overrides?: Partial<WasmPipelineConfig>): WasmPipelineConfig {
  return { sandboxDir: SANDBOX, outputDir: OUTPUT, chunkSize: 1024, ...overrides };
}

/** Creates a minimal valid WASM binary with magic header + padding */
async function createFakeWasm(name: string, size = 256): Promise<string> {
  const buf = Buffer.alloc(size);
  WASM_MAGIC.copy(buf, 0); // first 4 bytes are valid WASM magic
  buf.writeUInt32LE(1, 4);  // WASM version = 1
  const path = join(SANDBOX, name);
  await writeFile(path, buf);
  return path;
}

/** Creates a non-WASM binary file */
async function createNonWasm(name: string): Promise<string> {
  const path = join(SANDBOX, name);
  await writeFile(path, Buffer.from("not a wasm file, just text"));
  return path;
}

function expectedSha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

beforeAll(async () => {
  await mkdir(SANDBOX, { recursive: true });
  await mkdir(OUTPUT, { recursive: true });
});

afterAll(async () => {
  await rm(SANDBOX, { recursive: true, force: true });
  await rm(OUTPUT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// validateWasmPath
// ---------------------------------------------------------------------------

describe("validateWasmPath", () => {
  it("returns the resolved safe path for a valid WASM filename", () => {
    const result = validateWasmPath(SANDBOX, "my_contract.wasm");
    expect(result).toBe(resolve(SANDBOX, "my_contract.wasm"));
  });

  it("throws on directory traversal with ../", () => {
    expect(() => validateWasmPath(SANDBOX, "../etc/passwd")).toThrow(/traversal/i);
  });

  it("throws on absolute path outside sandbox", () => {
    expect(() => validateWasmPath(SANDBOX, "/etc/passwd")).toThrow(/traversal/i);
  });

  it("allows deeply nested paths within sandbox", () => {
    expect(validateWasmPath(SANDBOX, "target/wasm32/release/contract.wasm"))
      .toBe(resolve(SANDBOX, "target/wasm32/release/contract.wasm"));
  });
});

// ---------------------------------------------------------------------------
// verifyWasmChunkIntegrity
// ---------------------------------------------------------------------------

describe("verifyWasmChunkIntegrity", () => {
  it("returns true for contiguous chunks covering the file", () => {
    const chunks: WasmChunkRecord[] = [
      { index: 0, byteOffset: 0, byteLength: 100, compressedSize: 90 },
      { index: 1, byteOffset: 100, byteLength: 100, compressedSize: 85 },
    ];
    expect(verifyWasmChunkIntegrity(chunks, 200)).toBe(true);
  });

  it("returns false when total size mismatches", () => {
    const chunks: WasmChunkRecord[] = [
      { index: 0, byteOffset: 0, byteLength: 100, compressedSize: 90 },
    ];
    expect(verifyWasmChunkIntegrity(chunks, 200)).toBe(false);
  });

  it("returns false when chunks have gaps", () => {
    const chunks: WasmChunkRecord[] = [
      { index: 0, byteOffset: 0, byteLength: 100, compressedSize: 90 },
      { index: 1, byteOffset: 150, byteLength: 100, compressedSize: 85 }, // gap
    ];
    expect(verifyWasmChunkIntegrity(chunks, 250)).toBe(false);
  });

  it("returns true for an empty WASM file", () => {
    expect(verifyWasmChunkIntegrity([], 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// processWasm
// ---------------------------------------------------------------------------

describe("processWasm", () => {
  describe("basic functionality", () => {
    it("processes a WASM file and returns a manifest", async () => {
      await createFakeWasm("contract.wasm", 512);
      const manifest = await processWasm("contract.wasm", makeConfig());
      expect(manifest.fileName).toBe("contract.wasm");
      expect(manifest.extension).toBe(".wasm");
      expect(manifest.totalBytes).toBe(512);
      expect(manifest.sha256).toHaveLength(64);
      expect(manifest.integrityVerified).toBe(true);
      expect(manifest.wasmMagicValid).toBe(true);
    });

    it("computes SHA-256 matching `stellar contract install` wasm-hash", async () => {
      const buf = Buffer.alloc(256);
      WASM_MAGIC.copy(buf, 0);
      await writeFile(join(SANDBOX, "hash-test.wasm"), buf);
      const manifest = await processWasm("hash-test.wasm", makeConfig());
      expect(manifest.sha256).toBe(expectedSha256(buf));
    });

    it("splits a large WASM file into multiple chunks", async () => {
      await createFakeWasm("large.wasm", 5000);
      const manifest = await processWasm("large.wasm", makeConfig({ chunkSize: 1024 }));
      expect(manifest.chunkCount).toBeGreaterThan(1);
      expect(manifest.integrityVerified).toBe(true);
    });
  });

  describe("WASM magic byte validation", () => {
    it("sets wasmMagicValid=true for a valid WASM binary", async () => {
      await createFakeWasm("valid.wasm", 256);
      const manifest = await processWasm("valid.wasm", makeConfig());
      expect(manifest.wasmMagicValid).toBe(true);
    });

    it("sets wasmMagicValid=false for a non-WASM binary", async () => {
      await createNonWasm("not-wasm.wasm");
      const manifest = await processWasm("not-wasm.wasm", makeConfig());
      expect(manifest.wasmMagicValid).toBe(false);
    });

    it("skips magic validation when validateMagic=false", async () => {
      await createNonWasm("skip-magic.wasm");
      const manifest = await processWasm("skip-magic.wasm", makeConfig({ validateMagic: false }));
      expect(manifest.wasmMagicValid).toBe(true); // skipped = treated as valid
    });
  });

  describe("security: path traversal prevention", () => {
    it("throws for directory traversal paths", async () => {
      await expect(processWasm("../etc/passwd", makeConfig())).rejects.toThrow(/traversal/i);
    });

    it("throws for absolute paths outside sandbox", async () => {
      await expect(processWasm("/tmp/exploit.wasm", makeConfig())).rejects.toThrow(/traversal/i);
    });
  });

  describe("error handling", () => {
    it("throws for non-existent WASM file", async () => {
      await expect(processWasm("nonexistent.wasm", makeConfig())).rejects.toThrow(/not found/i);
    });
  });

  describe("manifest output", () => {
    it("writes a valid JSON manifest file to outputDir", async () => {
      await createFakeWasm("manifest-test.wasm", 256);
      await processWasm("manifest-test.wasm", makeConfig());
      const { readdir, readFile } = await import("fs/promises");
      const files = await readdir(OUTPUT);
      const manifests = files.filter((f) => f.startsWith("manifest-test.wasm") && f.endsWith(".manifest.json"));
      expect(manifests.length).toBeGreaterThan(0);
      const content = JSON.parse(await readFile(join(OUTPUT, manifests[0]), "utf8"));
      expect(content.sha256).toHaveLength(64);
      expect(content.wasmMagicValid).toBe(true);
      expect(content.integrityVerified).toBe(true);
    });
  });
});
