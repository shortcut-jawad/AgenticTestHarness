import * as fs from "fs/promises";
import * as path from "path";

/**
 * Use path.resolve to always produce an absolute path for the uploads dir.
 * path.join(process.cwd(), "uploads") can produce a relative path if cwd()
 * returns something unexpected in Next.js standalone mode.
 * path.resolve always returns an absolute path, which prevents ENOENT on mkdir.
 */
const DEFAULT_UPLOADS_DIR = path.resolve(process.cwd(), "uploads");


import { prisma } from "@/lib/prisma";

let baseDirEnsured = false;

function getUploadsBaseDir(): string {
  return process.env.UPLOADS_DIR || DEFAULT_UPLOADS_DIR;
}

async function ensureBaseDir(): Promise<void> {
  if (baseDirEnsured) return;
  const baseDir = getUploadsBaseDir();
  await fs.mkdir(path.join(baseDir, "agent-logs"), { recursive: true });
  baseDirEnsured = true;
}

function resolveStoragePath(bucket: string, storageKey: string): string {
  // Prevent path traversal
  const sanitizedKey = storageKey.replace(/\.\./g, "").replace(/^\//, "");
  return path.join(getUploadsBaseDir(), bucket, sanitizedKey);
}

export async function uploadFile(
  storageKey: string,
  data: Buffer | ArrayBuffer | Uint8Array,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _contentType?: string
): Promise<void> {
  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);

  // 1. Try local filesystem
  try {
    await ensureBaseDir();
    const filePath = resolveStoragePath("agent-logs", storageKey);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, buffer);
  } catch (err) {
    console.warn("Failed to write to local storage (expected on Vercel):", err);
    // 2. Try ephemeral /tmp fallback
    try {
      const filename = path.basename(storageKey);
      const tmpDir = path.join("/tmp", "uploads", "agent-logs");
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(path.join(tmpDir, filename), buffer);
      console.log("Cached log file in /tmp/uploads");
    } catch (tmpErr) {
      console.warn("Failed to write to /tmp cache:", tmpErr);
    }
  }
}

export async function downloadFile(storageKey: string): Promise<Buffer> {
  // 1. Try default uploads dir
  try {
    const filePath = resolveStoragePath("agent-logs", storageKey);
    return await fs.readFile(filePath);
  } catch (fsError) {
    // 2. Try /tmp/uploads cache
    try {
      const filename = path.basename(storageKey);
      const tmpFilePath = path.join("/tmp", "uploads", "agent-logs", filename);
      return await fs.readFile(tmpFilePath);
    } catch (tmpError) {
      // 3. Fall back to database
      try {
        const logfile = await prisma.runLogfile.findFirst({
          where: { storageKey }
        });
        if (logfile && logfile.metadata) {
          const metadata = logfile.metadata as any;
          if (metadata.fileContentBase64) {
            return Buffer.from(metadata.fileContentBase64, "base64");
          }
        }
      } catch (dbError) {
        console.error("Failed to fetch logfile from database:", dbError);
      }
      throw fsError;
    }
  }
}

export function getPublicUrl(storageKey: string): string {
  const sanitizedKey = storageKey.replace(/\.\./g, "").replace(/^\//, "");
  return `/api/files/agent-logs/${sanitizedKey}`;
}

export function getUploadsDir(): string {
  return getUploadsBaseDir();
}
