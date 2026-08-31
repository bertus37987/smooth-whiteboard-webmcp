import { CanvasOperation } from "./model";

interface ToolResult { content: Array<{ type: "text"; text: string }> }
interface ModelContext {
  registerTool(tool: { name: string; title?: string; description: string; inputSchema?: Record<string, unknown>; execute: (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult }, options?: { signal?: AbortSignal }): Promise<void> | void;
}

declare global { interface Document { modelContext?: ModelContext } }

export interface WebMcpHost {
  inspect(scope: "all" | "selection"): Record<string, unknown>;
  apply(operations: CanvasOperation[], baseRevision?: number): Promise<Record<string, unknown>>;
  complete(summary: string): Record<string, unknown>;
}

const result = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

export async function registerWhiteboardTools(host: WebMcpHost, signal: AbortSignal): Promise<boolean> {
  const context = document.modelContext; if (!context) return false;
  await context.registerTool({
    name: "inspect_whiteboard",
    title: "Inspect shared whiteboard",
    description: "Read the latest whiteboard state, the human's current lasso selection, and any pending instruction. Always inspect immediately before editing so human changes remain the source of truth.",
    inputSchema: { type: "object", properties: { scope: { type: "string", enum: ["all", "selection"], description: "Read the entire board or the active/pending selection." } } },
    execute: (input) => result(host.inspect(input.scope === "selection" ? "selection" : "all"))
  }, { signal });
  await context.registerTool({
    name: "apply_whiteboard_changes",
    title: "Edit shared whiteboard",
    description: "Progressively create, connect, move, resize, restyle, reorder, edit, or delete ordinary editable objects on the current shared whiteboard. Use IDs and coordinates from inspect_whiteboard. Prefer a coherent batch of meaningful operations.",
    inputSchema: {
      type: "object", required: ["operations"], properties: {
        baseRevision: { type: "number", description: "Revision returned by the latest inspection. A stale revision is rejected to protect newer human edits." },
        operations: { type: "array", minItems: 1, maxItems: 80, items: {
          type: "object", required: ["type"], properties: {
            type: { type: "string", enum: ["create_text", "create_shape", "create_arrow", "create_stroke", "translate", "resize", "update_text", "update_style", "reorder", "connect", "delete"] },
            id: { type: "string" }, ids: { type: "array", items: { type: "string" } },
            x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
            dx: { type: "number" }, dy: { type: "number" }, text: { type: "string" }, fontSize: { type: "number" },
            kind: { type: "string", enum: ["rectangle", "ellipse"] }, filled: { type: "boolean" }, size: { type: "number" },
            color: { type: "string" }, strokeWidth: { type: "number" }, fillColor: { type: "string" }, fillOpacity: { type: "number" },
            direction: { type: "string", enum: ["front", "back"] }, fromId: { type: "string" }, toId: { type: "string" }, label: { type: "string" },
            from: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
            to: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
            points: { type: "array", items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, pressure: { type: "number" } }, required: ["x", "y"] } }
          }
        } }
      }
    },
    execute: async (input) => result(await host.apply((input.operations as CanvasOperation[]) ?? [], typeof input.baseRevision === "number" ? input.baseRevision : undefined))
  }, { signal });
  await context.registerTool({
    name: "complete_whiteboard_contribution",
    title: "Finish whiteboard contribution",
    description: "Mark the current progressive contribution finished and give the human a concise summary. The UI then offers Accept or Undo.",
    inputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string", description: "One short sentence describing the contribution." } } },
    execute: (input) => result(host.complete(String(input.summary ?? "Beitrag abgeschlossen")))
  }, { signal });
  return true;
}
