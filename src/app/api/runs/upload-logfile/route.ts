import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { uploadFile, getPublicUrl } from "@/lib/storage";
import { getScopedUser } from "@/lib/auth";

export async function POST(req: Request) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const projectId = formData.get("projectId") as string | null;
  const rubricId = formData.get("rubricId") as string | null;
  const sourceTypeRaw = formData.get("sourceType");
  const formatHintRaw = formData.get("formatHint");
  const mappingConfigRaw = formData.get("mappingConfig");

  const sourceType =
    typeof sourceTypeRaw === "string" && sourceTypeRaw.trim()
      ? sourceTypeRaw.trim()
      : null;
  const formatHint =
    typeof formatHintRaw === "string" && formatHintRaw.trim()
      ? formatHintRaw.trim()
      : null;

  let mappingConfig: Prisma.InputJsonValue | null = null;
  if (typeof mappingConfigRaw === "string" && mappingConfigRaw.trim()) {
    try {
      mappingConfig = JSON.parse(mappingConfigRaw) as Prisma.InputJsonValue;
    } catch {
      return NextResponse.json(
        { error: "Invalid mappingConfig JSON" },
        { status: 400 }
      );
    }
  }

  const user = await getScopedUser("write");
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!file || !projectId) {
    return NextResponse.json(
      { error: "Missing file or projectId" },
      { status: 400 }
    );
  }

  const run = await prisma.agentRun.create({
    data: {
      projectId,
      triggeredById: user.id,
      rubricId: rubricId || null,
      status: "CREATED",
    },
  });

  const ext = file.name.split(".").pop() || "log";
  const storageKey = `${projectId}/${run.id}.${ext}`;

  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "UPLOADING" },
  });

  try {
    const fileBuffer = await file.arrayBuffer();
    await uploadFile(storageKey, fileBuffer, file.type || "text/plain");
  } catch (uploadError) {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED" },
    });
    return NextResponse.json(
      { error: `Upload failed: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}` },
      { status: 500 }
    );
  }

  const publicUrl = getPublicUrl(storageKey);

  const fileBuffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", fileBuffer);
  const sha256 = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const base64Content = Buffer.from(fileBuffer).toString("base64");

  await prisma.runLogfile.create({
    data: {
      runId: run.id,
      projectId,
      uploadedById: user.id,
      storageKey,
      url: publicUrl,
      sizeBytes: file.size,
      checksum: sha256,
      contentType: file.type || "text/plain",
      metadata: {
        sourceType,
        formatHint,
        mappingConfig,
        fileContentBase64: base64Content,
      } as Prisma.InputJsonValue,
    },
  });


  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "UPLOADED" },
  });

  return NextResponse.json({
    runId: run.id,
    status: "UPLOADED",
  });
}
