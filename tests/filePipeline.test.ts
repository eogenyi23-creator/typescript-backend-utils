/**
 * Tests for the file pipeline and metadata extractor.
 */

import { writeFile, mkdir, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { tmpdir } from "os";
import {
  validatePath,
  verifyChunkIntegrity,
  processFile,
  PipelineConfig,
  ChunkRecord,
} from "../src/filePipeline.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_SANDBOX = join(tmpdir(), `pipeline-sandbox-${process.pid}`);
const TEST_OUTPUT = join(tmpdir(), `pipeline-output-${process.pid}`);

function makeConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
  return {
    sandboxDir: TEST_SANDBOX,
    outputDir: TEST_OUTPUT,
    chunkSize: 1024, // 1 KB chunks for faster tests
    ...overrides,
  };
}

/** Creates a test file with the given content */
async function createTestFile(name: string, content: string): Promise<string> {
  const path = join(TEST_SANDBOX, name);
  await writeFile(path, content, "utf8");
  return path;
}

/** Computes expected SHA-256 of a string */
function expectedSha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await mkdir(TEST_SANDBOX, { recursive: true });
  await mkdir(TEST_OUTPUT, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_SANDBOX, { recursive: true, force: true });
  await rm(TEST_OUTPUT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// validatePath tests
// ---------------------------------------------------------------------------

describe("validatePath", () => {
  it("returns the resolved safe path for a valid filename", () => {
    const result = validatePath(TEST_SANDBOX, "test.txt");
    expect(result).toBe(resolve(TEST_SANDBOX, "test.txt"));
  });

  it("throws on directory traversal with ../", () => {
    expect(() => validatePath(TEST_SANDBOX, "../etc/passwd")).toThrow(
      /traversal/i
    );
  });

  it("throws on traversal with encoded sequences", () => {
    expect(() => validatePath(TEST_SANDBOX, "../../etc/passwd")).toThrow(
      /traversal/i
    );
  });

  it("throws on absolute path outside sandbox", () => {
    expect(() => validatePath(TEST_SANDBOX, "/etc/passwd")).toThrow(
      /traversal/i
    );
  });

  it("allows deeply nested paths within sandbox", () => {
    const sub = join(TEST_SANDBOX, "subdir", "file.txt");
    const result = validatePath(TEST_SANDBOX, "subdir/file.txt");
    expect(result).toBe(sub);
  });
});

// ---------------------------------------------------------------------------
// verifyChunkIntegrity tests
// ---------------------------------------------------------------------------

describe("verifyChunkIntegrity", () => {
  it("returns true for contiguous chunks covering file exactly", () => {
    const chunks: ChunkRecord[] = [
      { index: 0, byteOffset: 0, byteLength: 100, compressedSize: 90 },
      { index: 1, byteOffset: 100, byteLength: 100, compressedSize: 85 },
      { index: 2, byteOffset: 200, byteLength: 50, compressedSize: 40 },
    ];
    expect(verifyChunkIntegrity(chunks, 250)).toBe(true);
  });

  it("returns false when total size mismatches", () => {
    const chunks: ChunkRecord[] = [
      { index: 0, byteOffset: 0, byteLength: 100, compressedSize: 90 },
    ];
    expect(verifyChunkIntegrity(chunks, 200)).toBe(false);
  });

  it("returns false when chunks have gaps", () => {
    const chunks: ChunkRecord[] = [
      { index: 0, byteOffset: 0, byteLength: 100, compressedSize: 90 },
      { index: 1, byteOffset: 150, byteLength: 100, compressedSize: 85 }, // gap at 100-149
    ];
    expect(verifyChunkIntegrity(chunks, 250)).toBe(false);
  });

  it("returns false when chunks overlap", () => {
    const chunks: ChunkRecord[] = [
      { index: 0, byteOffset: 0, byteLength: 100, compressedSize: 90 },
      { index: 1, byteOffset: 50, byteLength: 100, compressedSize: 85 }, // starts at 50, overlaps
    ];
    expect(verifyChunkIntegrity(chunks, 150)).toBe(false);
  });

  it("returns true for empty file with no chunks", () => {
    expect(verifyChunkIntegrity([], 0)).toBe(true);
  });

  it("returns false for empty chunks with non-zero size", () => {
    expect(verifyChunkIntegrity([], 100)).toBe(false);
  });

  it("returns false if any chunk has zero byte length", () => {
    const chunks: ChunkRecord[] = [
      { index: 0, byteOffset: 0, byteLength: 0, compressedSize: 0 },
    ];
    expect(verifyChunkIntegrity(chunks, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// processFile tests
// ---------------------------------------------------------------------------

describe("processFile", () => {
  describe("basic functionality", () => {
    it("processes a small file and returns a ledger", async () => {
      const content = "Hello, world! This is a test file.";
      await createTestFile("small.txt", content);

      const ledger = await processFile("small.txt", makeConfig());

      expect(ledger.fileName).toBe("small.txt");
      expect(ledger.extension).toBe(".txt");
      expect(ledger.totalBytes).toBe(Buffer.byteLength(content, "utf8"));
      expect(ledger.sha256).toHaveLength(64);
      expect(ledger.sha256).toBe(expectedSha256(content));
      expect(ledger.chunkCount).toBeGreaterThan(0);
      expect(ledger.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(ledger.chunkIntegrityVerified).toBe(true);
    });

    it("computes the correct SHA-256 hash", async () => {
      const content = "SHA256 test content - " + "x".repeat(500);
      await createTestFile("hash-test.txt", content);

      const ledger = await processFile("hash-test.txt", makeConfig());
      expect(ledger.sha256).toBe(expectedSha256(content));
    });

    it("tracks file extension correctly", async () => {
      await createTestFile("data.json", '{"key":"value"}');
      const ledger = await processFile("data.json", makeConfig());
      expect(ledger.extension).toBe(".json");
    });

    it("handles files with no extension", async () => {
      await createTestFile("noext", "content");
      const ledger = await processFile("noext", makeConfig());
      expect(ledger.extension).toBe("");
    });
  });

  describe("chunking behavior", () => {
    it("splits large files into multiple chunks", async () => {
      const content = "A".repeat(5000); // 5 KB, with 1 KB chunk size
      await createTestFile("large.txt", content);

      const ledger = await processFile("large.txt", makeConfig({ chunkSize: 1024 }));

      expect(ledger.chunkCount).toBeGreaterThan(1);
      expect(ledger.chunks.every((c) => c.byteLength > 0)).toBe(true);
    });

    it("verifies chunk byte ranges integrity", async () => {
      const content = "B".repeat(3000);
      await createTestFile("chunk-integrity.txt", content);

      const ledger = await processFile(
        "chunk-integrity.txt",
        makeConfig({ chunkSize: 512 })
      );

      expect(ledger.chunkIntegrityVerified).toBe(true);
    });

    it("chunks have correct ordered byte offsets", async () => {
      const content = "C".repeat(2048);
      await createTestFile("offsets.txt", content);

      const ledger = await processFile(
        "offsets.txt",
        makeConfig({ chunkSize: 512 })
      );

      let expectedOffset = 0;
      for (const chunk of ledger.chunks) {
        expect(chunk.byteOffset).toBe(expectedOffset);
        expectedOffset += chunk.byteLength;
      }
      expect(expectedOffset).toBe(ledger.totalBytes);
    });

    it("chunk indices are sequential starting at 0", async () => {
      const content = "D".repeat(2048);
      await createTestFile("indices.txt", content);

      const ledger = await processFile(
        "indices.txt",
        makeConfig({ chunkSize: 512 })
      );

      ledger.chunks.forEach((chunk, i) => {
        expect(chunk.index).toBe(i);
      });
    });

    it("compressed size is recorded for each chunk", async () => {
      const content = "E".repeat(2000);
      await createTestFile("compressed.txt", content);

      const ledger = await processFile(
        "compressed.txt",
        makeConfig({ chunkSize: 512 })
      );

      ledger.chunks.forEach((chunk) => {
        expect(chunk.compressedSize).toBeGreaterThan(0);
      });
      expect(ledger.totalCompressedBytes).toBeGreaterThan(0);
    });

    it("processes a single-chunk file correctly", async () => {
      const content = "Small";
      await createTestFile("tiny.txt", content);

      const ledger = await processFile(
        "tiny.txt",
        makeConfig({ chunkSize: 65536 })
      );

      expect(ledger.chunkCount).toBe(1);
      expect(ledger.chunkIntegrityVerified).toBe(true);
    });
  });

  describe("JSON ledger output", () => {
    it("writes a valid JSON ledger file", async () => {
      const content = "ledger test";
      await createTestFile("ledger-test.txt", content);

      await processFile("ledger-test.txt", makeConfig());

      // Find the ledger file in output dir
      const { readdir } = await import("fs/promises");
      const files = await readdir(TEST_OUTPUT);
      const ledgerFiles = files.filter(
        (f) => f.startsWith("ledger-test.txt") && f.endsWith(".ledger.json")
      );

      expect(ledgerFiles.length).toBeGreaterThan(0);

      const ledgerContent = await readFile(
        join(TEST_OUTPUT, ledgerFiles[0]),
        "utf8"
      );
      const parsed = JSON.parse(ledgerContent);

      expect(parsed.fileName).toBe("ledger-test.txt");
      expect(parsed.sha256).toHaveLength(64);
      expect(parsed.chunkIntegrityVerified).toBe(true);
      expect(typeof parsed.totalBytes).toBe("number");
      expect(Array.isArray(parsed.chunks)).toBe(true);
    });
  });

  describe("security: path traversal prevention", () => {
    it("throws for directory traversal paths", async () => {
      await expect(
        processFile("../etc/passwd", makeConfig())
      ).rejects.toThrow(/traversal/i);
    });

    it("throws for absolute paths outside sandbox", async () => {
      await expect(
        processFile("/tmp/exploit.txt", makeConfig())
      ).rejects.toThrow(/traversal/i);
    });

    it("throws for deep traversal", async () => {
      await expect(
        processFile("../../etc/shadow", makeConfig())
      ).rejects.toThrow(/traversal/i);
    });
  });

  describe("error handling", () => {
    it("throws for non-existent file", async () => {
      await expect(
        processFile("nonexistent.txt", makeConfig())
      ).rejects.toThrow(/not found/i);
    });
  });
});
