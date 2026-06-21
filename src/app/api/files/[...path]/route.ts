import { NextResponse } from "next/server";
import * as nodePath from "path";
import { getScopedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { downloadFile } from "@/lib/storage";

const MIME_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".log": "text/plain",
  ".txt": "text/plain",
  ".csv": "text/csv",
};

export async function GET(
  _req: Request,
  context: { params: Promise<{ path: string[] }> }
) {
  const user = await getScopedUser("read");
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { path: segments } = await context.params;
  if (!segments || segments.length < 2) {
    return NextResponse.json({ error: "No path specified" }, { status: 400 });
  }

  // Prevent path traversal
  const joined = segments.join("/");
  if (joined.includes("..")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const [bucket, ...storageKeySegments] = segments;
  if (bucket !== "agent-logs") {
    return NextResponse.json({ error: "Invalid bucket" }, { status: 400 });
  }

  const storageKey = storageKeySegments.join("/");
  const authorizedLogfile = await prisma.runLogfile.findFirst({
    where: {
      storageKey,
      project: {
        workspace: {
          memberships: {
            some: {
              userId: user.id,
            },
          },
        },
      },
    },
    select: { id: true },
  });

  if (!authorizedLogfile) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    const data = await downloadFile(storageKey);
    const ext = nodePath.extname(storageKey).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(data.length),
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
