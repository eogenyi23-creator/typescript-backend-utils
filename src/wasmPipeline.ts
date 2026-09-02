/**
 * Soroban WASM Upload Pipeline
 *
 * Streaming validation and hash pipeline for Soroban contract WASM files
 * before uploading to the Stellar network via `stellar contract install`.
 *
 * Stellar context:
 * - Deploying a Soroban contract requires two steps:
 *   1. `stellar contract install` — uploads the WASM binary, returns a wasm-hash
 *   2. `stellar contract deploy` — creates a contract instance from the hash
 * - The wasm-hash is SHA-256(wasm_bytes). This pipeline computes it efficiently
 *   via streaming (no full buffer in memory) and validates file integrity before
 *   you attempt an on-chain upload.
 * - Validating locally saves ledger fees from failed upload transactions.
 *
 * Features:
 * - Streams WASM file in configurable chunks (default 64 KB)
 * - Computes SHA-256 on the fly — matches what Stellar network stores
 * - Validates WASM magic bytes (\0asm) to catch non-WASM files early
 * - `validate()` method throws immediately on invalid magic bytes, preventing
 *   accidental uploads of non-WASM files to the network
 * - Verifies chunk byte ranges cover the entire file
 * - Writes a JSON manifest with hash, size, chunk info, and completedAt
 * - Sandbox path isolation to prevent directory traversal
 */

import { createReadStream, statSync, existsSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { createHash } from "crypto";
import { gzip } from "zlib";
import { promisify } from "util";
import { resolve, normalize, extname, basename, join } from "path";

const gzipAsync = promisify(gzip);

/** Magic bytes for a valid WebAssembly binary: \0asm (0x00 0x61 0x73 0x6D) */
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WasmPipelineConfig {
  /** Directory that WASM files must reside in (sandbox) */
  sandboxDir: string;
  /** Output directory for manifest JSON files */
  outputDir?: string;
  /** Chunk size in bytes (default: 64 KB) */
  chunkSize?: number;
  /** Whether to validate WASM magic bytes (default: true) */
  validateMagic?: boolean;
}

export interface WasmChunkRecord {
  index: number;
  byteOffset: number;
  byteLength: number;
  compressedSize: number;
}

export interface WasmManifest {
  /** WASM filename */
  fileName: string;
  /** File extension (should be ".wasm") */
  extension: string;
  /** Total file size in bytes */
  totalBytes: number;
  /** Number of chunks processed */
  chunkCount: number;
  /** Chunk records */
  chunks: WasmChunkRecord[];
  /**
   * SHA-256 hex digest of the WASM bytes.
   * This matches the wasm-hash used by `stellar contract install`.
   */
  sha256: string;
  /** Whether WASM magic bytes were present and valid */
  wasmMagicValid: boolean;
  /** Whether chunk byte ranges exactly cover the file */
  integrityVerified: boolean;
  /** Total compressed size of all chunks */
  totalCompressedBytes: number;
  /** ISO timestamp when processing completed */
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validates that a file path resolves within the sandbox directory.
 * Throws on directory traversal attempts.
 */
export function validateWasmPath(sandboxDir: string, filePath: string): string {
  const normalizedSandbox = resolve(normalize(sandboxDir));
  const resolved = resolve(normalizedSandbox, normalize(filePath));
  if (!resolved.startsWith(normalizedSandbox + "/") && resolved !== normalizedSandbox) {
    throw new Error(
      `Path traversal detected: "${filePath}" resolves outside sandbox "${sandboxDir}"`
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Chunk integrity verification
// ---------------------------------------------------------------------------

export function verifyWasmChunkIntegrity(chunks: WasmChunkRecord[], totalBytes: number): boolean {
  if (chunks.length === 0) return totalBytes === 0;
  let expectedOffset = 0;
  for (const chunk of chunks) {
    if (chunk.byteOffset !== expectedOffset) return false;
    if (chunk.byteLength <= 0) return false;
    expectedOffset += chunk.byteLength;
  }
  return expectedOffset === totalBytes;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Streams a Soroban WASM file, computes its SHA-256 hash (matching the
 * on-chain wasm-hash), validates magic bytes, and writes a manifest JSON.
 *
 * @param filePath - Path to the WASM file (relative to sandboxDir)
 * @param config   - Pipeline configuration
 * @returns        - WasmManifest with hash, size, and integrity status
 */
export async function processWasm(
  filePath: string,
  config: WasmPipelineConfig
): Promise<WasmManifest> {
  const {
    sandboxDir,
    outputDir = sandboxDir,
    chunkSize = 65_536,
    validateMagic = true,
  } = config;

  // 1. Validate path
  const safePath = validateWasmPath(sandboxDir, filePath);

  if (!existsSync(safePath)) throw new Error(`WASM file not found: ${safePath}`);
  const stat = statSync(safePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${safePath}`);

  const totalBytes = stat.size;
  const fileName = basename(safePath);
  const extension = extname(fileName);

  await mkdir(outputDir, { recursive: true });

  // 2. Stream, hash, compress
  const hash = createHash("sha256");
  const chunks: WasmChunkRecord[] = [];
  let byteOffset = 0;
  let totalCompressedBytes = 0;
  // Store first chunk bytes for WASM magic validation after streaming completes
  const firstChunkBytes: Buffer[] = [];

  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(safePath, { highWaterMark: chunkSize });
    let lastGzipPromise: Promise<void> = Promise.resolve();
    let streamError: Error | null = null;

    stream.on("data", (rawChunk: Buffer | string) => {
      if (streamError) return;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);

      // Capture first chunk for magic byte validation
      if (firstChunkBytes.length === 0) firstChunkBytes.push(chunk);

      hash.update(chunk);

      const index = chunks.length;
      const chunkByteOffset = byteOffset;
      chunks.push({ index, byteOffset: chunkByteOffset, byteLength: chunk.length, compressedSize: 0 });
      byteOffset += chunk.length;

      stream.pause();
      lastGzipPromise = lastGzipPromise
        .then(() => gzipAsync(chunk))
        .then((compressed) => {
          chunks[index].compressedSize = compressed.length;
          totalCompressedBytes += compressed.length;
          stream.resume();
        })
        .catch((err: Error) => {
          streamError = err;
          stream.destroy(err);
        });
    });

    stream.on("error", (err) => { streamError = err; rejectStream(err); });
    stream.on("end", () => { lastGzipPromise.then(() => resolveStream()).catch(rejectStream); });
  });

  const sha256 = hash.digest("hex");
  const integrityVerified = verifyWasmChunkIntegrity(chunks, totalBytes);

  // 3. Validate WASM magic bytes
  let wasmMagicValid = false;
  if (!validateMagic) {
    wasmMagicValid = true; // validation skipped
  } else if (firstChunkBytes.length > 0) {
    const first = firstChunkBytes[0];
    wasmMagicValid = first.length >= 4 && first.subarray(0, 4).equals(WASM_MAGIC);
  }

  // 4. Build and write manifest
  const manifest: WasmManifest = {
    fileName,
    extension,
    totalBytes,
    chunkCount: chunks.length,
    chunks,
    sha256,
    wasmMagicValid,
    integrityVerified,
    totalCompressedBytes,
    completedAt: new Date().toISOString(),
  };

  const manifestName = `${fileName}.${Date.now()}.manifest.json`;
  await writeFile(join(outputDir, manifestName), JSON.stringify(manifest, null, 2), "utf8");

  return manifest;
}

/**
 * Convenience class for OO usage.
 *
 * @example
 * const pipeline = new WasmPipeline({ sandboxDir: './contracts/target/wasm32v1-none/release' });
 *
 * // Validate before processing — throws if not a valid WASM binary:
 * await pipeline.validate('my_contract.wasm');
 *
 * // Process and get the manifest + wasm-hash:
 * const manifest = await pipeline.process('my_contract.wasm');
 * console.log('wasm-hash:', manifest.sha256);
 */
export class WasmPipeline {
  constructor(private readonly config: WasmPipelineConfig) {}

  /**
   * Validates that the file at `filePath` is a valid Soroban WASM binary by
   * checking the WebAssembly magic bytes (`\0asm`, `0x00 0x61 0x73 0x6d`).
   *
   * Throws an error if:
   * - The path is outside the sandbox (directory traversal)
   * - The file does not exist
   * - The file does not start with the WASM magic bytes
   *
   * Use this before calling `process()` to prevent uploading non-WASM files
   * to the Stellar network and wasting ledger fees on a guaranteed failure.
   *
   * @param filePath - Path to the WASM file (relative to sandboxDir)
   * @throws {Error} If the file is not a valid WASM binary
   *
   * @example
   * await pipeline.validate('my_contract.wasm'); // throws if invalid
   * const manifest = await pipeline.process('my_contract.wasm');
   */
  async validate(filePath: string): Promise<void> {
    const safePath = validateWasmPath(this.config.sandboxDir, filePath);

    if (!existsSync(safePath)) {
      throw new Error(`WASM file not found: ${safePath}`);
    }

    const stat = statSync(safePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${safePath}`);
    }

    if (stat.size < 4) {
      throw new Error(
        `Invalid WASM file "${filePath}": file is too small to contain magic bytes (${stat.size} bytes)`
      );
    }

    // Read only the first 4 bytes — no need to stream the whole file
    const header = await new Promise<Buffer>((res, rej) => {
      const chunks: Buffer[] = [];
      const stream = createReadStream(safePath, { start: 0, end: 3 });
      stream.on("data", (chunk: Buffer | string) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      );
      stream.on("end", () => res(Buffer.concat(chunks)));
      stream.on("error", rej);
    });

    if (!header.equals(WASM_MAGIC)) {
      throw new Error(
        `Invalid WASM file "${filePath}": expected magic bytes \\0asm (0x00 0x61 0x73 0x6d), ` +
        `got 0x${header.toString("hex").toUpperCase()}`
      );
    }
  }

  async process(filePath: string): Promise<WasmManifest> {
    return processWasm(filePath, this.config);
  }
}
