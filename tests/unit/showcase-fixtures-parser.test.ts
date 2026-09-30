import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { previewParseLog } from "@/lib/parser";

const showcaseDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "showcase");

function readFixture(name: string) {
  return readFileSync(join(showcaseDir, name), "utf8");
}

describe("showcase parser fixtures", () => {
  it("parses the OpenAI Agents fixture with the openai adapter", () => {
    const preview = previewParseLog({
      text: readFixture("openai-agents-multi-tool-success.jsonl"),
      sourceType: "openai_agents",
    });

    expect(preview.strictReport.adapterUsed).toBe("openai_agents");
    expect(preview.strictReport.detectedFormat).toBe("jsonl");
    expect(preview.metrics.totalToolCalls).toBe(3);
    expect(preview.metrics.totalErrors).toBe(0);
    expect(preview.task.text).toContain("Lisbon");
  });

  it("parses the LangChain fixture and detects a retry", () => {
    const preview = previewParseLog({
      text: readFixture("langchain-retry-and-recovery.jsonl"),
      sourceType: "langchain",
    });

    expect(preview.strictReport.adapterUsed).toBe("langchain");
    expect(preview.strictReport.detectedFormat).toBe("jsonl");
    expect(preview.metrics.totalToolCalls).toBe(4);
    expect(preview.metrics.totalRetries).toBe(1);
    expect(preview.task.text).toContain("Madrid");
  });

  it("parses the generic JSONL fixture and redacts the API key", () => {
    const preview = previewParseLog({
      text: readFixture("generic-jsonl-redaction-and-error.jsonl"),
      sourceType: "generic_jsonl",
    });

    expect(preview.strictReport.adapterUsed).toBe("generic_jsonl");
    expect(preview.metrics.totalToolCalls).toBe(3);
    expect(preview.metrics.totalErrors).toBe(1);
    expect(preview.metrics.totalRetries).toBe(1);
    expect(preview.redactionReport.redactedCount).toBeGreaterThan(0);
  });

  it("parses the public data trajectory fixture and supports trajectory selection", () => {
    const tokyo = previewParseLog({
      text: readFixture("public-data-trajectories-dual.json"),
      sourceType: "public_data_trajectory",
      formatHint: "json",
      mappingConfig: { publicDataTrajectoryIndex: 0 },
    });
    const lisbon = previewParseLog({
      text: readFixture("public-data-trajectories-dual.json"),
      sourceType: "public_data_trajectory",
      formatHint: "json",
      mappingConfig: { publicDataTrajectoryIndex: 1 },
    });

    expect(tokyo.strictReport.adapterUsed).toBe("public_data_trajectory");
    expect(tokyo.strictReport.detectedFormat).toBe("json");
    expect(tokyo.metrics.totalToolCalls).toBe(2);
    expect(tokyo.task.text).toContain("Tokyo");
    expect(lisbon.task.text).toContain("Lisbon");
  });

  it("parses the mapped JSON array when custom paths are provided", () => {
    const preview = previewParseLog({
      text: readFixture("custom-mapped-json-array.json"),
      sourceType: "generic_json",
      formatHint: "json",
      mappingConfig: {
        idPath: "entry_ref",
        typePath: "kind",
        timestampPath: "when",
        dataPath: "payload",
      },
    });

    expect(preview.strictReport.adapterUsed).toBe("generic_jsonl");
    expect(preview.strictReport.detectedFormat).toBe("json");
    expect(preview.events).toHaveLength(4);
    expect(preview.metrics.totalToolCalls).toBe(1);
    expect(preview.task.text).toContain("Rome");
  });

  it("falls back cleanly for plain text logs", () => {
    const preview = previewParseLog({
      text: readFixture("plain-text-agent-session.log"),
      sourceType: "generic",
      formatHint: "text",
    });

    expect(preview.strictReport.adapterUsed).toBe("generic_jsonl");
    expect(preview.strictReport.detectedFormat).toBe("text");
    expect(preview.events.length).toBeGreaterThan(0);
    expect(preview.metrics.totalToolCalls).toBe(0);
  });
});
