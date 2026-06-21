import * as fs from "fs/promises";
import * as path from "path";

/**
 * In production (standalone Next.js), process.cwd() may not resolve to /app,
 * causing relative "uploads" mkdir to fail with ENOENT.
 * Use an absolute path in production to match the Docker/K8s mount point.
 */
const DEFAULT_UPLOADS_DIR =
  process.env.NODE_ENV === "production"
    ? "/app/uploads"
    : path.join(process.cwd(), "uploads");

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
  await ensureBaseDir();
  const filePath = resolveStoragePath("agent-logs", storageKey);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  await fs.writeFile(filePath, buffer);
}

export async function downloadFile(storageKey: string): Promise<Buffer> {
  const filePath = resolveStoragePath("agent-logs", storageKey);
  return fs.readFile(filePath);
}

export function getPublicUrl(storageKey: string): string {
  const sanitizedKey = storageKey.replace(/\.\./g, "").replace(/^\//, "");
  return `/api/files/agent-logs/${sanitizedKey}`;
}

export function getUploadsDir(): string {
  return getUploadsBaseDir();
}
