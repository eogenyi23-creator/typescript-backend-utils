/**
 * File Pipeline and Metadata Extractor
 *
 * Asynchronous streaming pipeline that:
 * 1. Validates input paths against directory traversal attacks
 * 2. Streams a file in configurable byte chunks via fs.createReadStream
 * 3. Computes SHA-256 hash on the fly while streaming
 * 4. Compresses each chunk with zlib (gzip)
 * 5. Verifies that chunk byte ranges cover the entire file
 * 6. Writes a JSON ledger with metrics, chunk info, and integrity hash
 *
 * Backpressure is handled natively via pipe() / stream.pipeline().
 */

import { createReadStream, statSync, existsSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { createHash } from "crypto";
import { gzip } from "zlib";
import { promisify } from "util";
import { resolve, normalize, extname, basename, join } from "path";

const gzipAsync = promisify(gzip);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  /** Directory that input files must reside in (sandbox) */
  sandboxDir: string;
  /** Output directory for ledger JSON files */
  outputDir: string;
  /** Chunk size in bytes (default: 64 KB) */
  chunkSize?: number;
}

export interface ChunkRecord {
  /** Chunk sequence number (0-indexed) */
  index: number;
  /** Starting byte offset within the original file */
  byteOffset: number;
  /** Number of bytes in this chunk */
  byteLength: number;
  /** Compressed size in bytes after gzip */
  compressedSize: number;
}

export interface PipelineLedger {
  /** Original filename */
  fileName: string;
  /** File extension (e.g. ".txt") */
  extension: string;
  /** Total file size in bytes */
  totalBytes: number;
  /** Number of chunks processed */
  chunkCount: number;
  /** Ordered array of chunk records */
  chunks: ChunkRecord[];
  /** SHA-256 hex digest of the entire file content */
  sha256: string;
  /** ISO timestamp when processing completed */
  completedAt: string;
  /** Total compressed size across all chunks in bytes */
  totalCompressedBytes: number;
  /** Whether chunk byte ranges exactly cover the file */
  chunkIntegrityVerified: boolean;
}

// ---------------------------------------------------------------------------
// Path validation (sandbox isolation)
// ---------------------------------------------------------------------------

/**
 * Validates that a file path resolves within the sandbox directory.
 * Throws if the path escapes the sandbox (directory traversal prevention).
 *
 * @param sandboxDir - Absolute path to the allowed sandbox directory
 * @param filePath   - User-supplied file path (may be relative or contain ..)
 * @returns The resolved, safe absolute path
 */
export function validatePath(sandboxDir: string, filePath: string): string {
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
// Chunk ordering verification
// ---------------------------------------------------------------------------

/**
 * Verifies that chunk byte ranges are contiguous and cover the entire file.
 *
 * @param chunks     - Array of chunk records in order
 * @param totalBytes - Expected total file size
 * @returns true if all byte ranges match up
 */
export function verifyChunkIntegrity(
  chunks: ChunkRecord[],
  totalBytes: number
): boolean {
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
 * Processes a file through the streaming pipeline.
 *
 * Reads the file in chunks, hashes on the fly, compresses each chunk,
 * verifies chunk ordering, and writes a structured JSON ledger.
 *
 * @param filePath - Path to the input file (relative to sandboxDir or absolute)
 * @param config   - Pipeline configuration
 * @returns The complete pipeline ledger
 */
export async function processFile(
  filePath: string,
  config: PipelineConfig
): Promise<PipelineLedger> {
  const { sandboxDir, outputDir, chunkSize = 65_536 } = config;

  // ------------------------------------------------------------------
  // 1. Validate path (directory traversal prevention)
  // ------------------------------------------------------------------
  const safePath = validatePath(sandboxDir, filePath);

  if (!existsSync(safePath)) {
    throw new Error(`File not found: ${safePath}`);
  }

  const stat = statSync(safePath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${safePath}`);
  }

  const totalBytes = stat.size;
  const fileName = basename(safePath);
  const extension = extname(fileName);

  // ------------------------------------------------------------------
  // 2. Ensure output directory exists
  // ------------------------------------------------------------------
  await mkdir(outputDir, { recursive: true });

  // ------------------------------------------------------------------
  // 3. Stream the file, compute SHA-256, compress chunks
  // ------------------------------------------------------------------
  const hash = createHash("sha256");
  const chunks: ChunkRecord[] = [];
  let byteOffset = 0;
  let totalCompressedBytes = 0;

  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(safePath, { highWaterMark: chunkSize });
    /**
     * Track the last gzip promise so we can chain onto it when the stream
     * ends. This ensures all async gzip work finishes before we proceed.
     */
    let lastGzipPromise: Promise<void> = Promise.resolve();
    let streamError: Error | null = null;

    stream.on("data", (rawChunk: Buffer | string) => {
      if (streamError) return;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);

      // Update running hash synchronously (in stream order)
      hash.update(chunk);

      const index = chunks.length;
      const chunkByteOffset = byteOffset;

      // Reserve a placeholder so that chunk order is preserved
      chunks.push({
        index,
        byteOffset: chunkByteOffset,
        byteLength: chunk.length,
        compressedSize: 0, // will be updated once gzip completes
      });

      byteOffset += chunk.length;

      // Pause stream for backpressure: don't read ahead while compressing
      stream.pause();

      // Chain gzip operations sequentially to avoid out-of-order updates
      lastGzipPromise = lastGzipPromise
        .then(() => gzipAsync(chunk))
        .then((compressed) => {
          chunks[index].compressedSize = compressed.length;
          totalCompressedBytes += compressed.length;
          // Resume reading only after this chunk is fully processed
          stream.resume();
        })
        .catch((err: Error) => {
          streamError = err;
          stream.destroy(err);
        });
    });

    stream.on("error", (err) => {
      streamError = err;
      rejectStream(err);
    });

    stream.on("end", () => {
      // Wait for all pending gzip operations to complete before resolving
      lastGzipPromise.then(() => resolveStream()).catch(rejectStream);
    });
  });

  // ------------------------------------------------------------------
  // 4. Finalize hash
  // ------------------------------------------------------------------
  const sha256 = hash.digest("hex");

  // ------------------------------------------------------------------
  // 5. Verify chunk byte ranges cover the entire file
  // ------------------------------------------------------------------
  const chunkIntegrityVerified = verifyChunkIntegrity(chunks, totalBytes);

  // ------------------------------------------------------------------
  // 6. Build and write the JSON ledger
  // ------------------------------------------------------------------
  const ledger: PipelineLedger = {
    fileName,
    extension,
    totalBytes,
    chunkCount: chunks.length,
    chunks,
    sha256,
    completedAt: new Date().toISOString(),
    totalCompressedBytes,
    chunkIntegrityVerified,
  };

  const ledgerName = `${fileName}.${Date.now()}.ledger.json`;
  const ledgerPath = join(outputDir, ledgerName);

  await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");

  return ledger;
}
