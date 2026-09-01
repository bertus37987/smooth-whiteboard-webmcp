import { CanvasOperation } from "./model";
import { VisualCompositionInput } from "./compositions";

interface ToolResult { content: Array<{ type: "text"; text: string }> }
interface ModelContext {
  registerTool(tool: { name: string; title?: string; description: string; inputSchema?: Record<string, unknown>; execute: (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult }, options?: { signal?: AbortSignal }): Promise<void> | void;
}

declare global { interface Document { modelContext?: ModelContext } }

export interface WebMcpHost {
  inspect(scope: "all" | "selection"): Record<string, unknown>;
  apply(operations: CanvasOperation[], baseRevision?: number): Promise<Record<string, unknown>>;
  compose(input: VisualCompositionInput, baseRevision?: number): Promise<Record<string, unknown>>;
  complete(summary: string): Record<string, unknown>;
}

const result = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

export async function registerWhiteboardTools(host: WebMcpHost, signal: AbortSignal): Promise<boolean> {
  const context = document.modelContext; if (!context) return false;
  await context.registerTool({
    name: "inspect_whiteboard",
    title: "Inspect shared whiteboard",
    description: "Read the latest whiteboard state, the human's current lasso selection, and any pending instruction. Pending request ink contains the non-permanent blue AI-Pen strokes in world coordinates. Always inspect immediately before editing so human changes remain the source of truth.",
    inputSchema: { type: "object", properties: { scope: { type: "string", enum: ["all", "selection"], description: "Read the entire board or the active/pending selection." } } },
    execute: (input) => result(host.inspect(input.scope === "selection" ? "selection" : "all"))
  }, { signal });
  await context.registerTool({
    name: "apply_whiteboard_changes",
    title: "Edit shared whiteboard",
    description: "Precisely edit the live board with ordinary editable objects. Supports styled text, rewriting/shortening, text highlighting, colors, filled shapes, rounded corners, solid/dashed/dotted lines, one- or two-headed arrows, custom strokes and polygons, point editing, smart connections, moving, resizing, grouping, duplication, alignment, distribution, layers and deletion. Inspect first and use the latest revision.",
    inputSchema: {
      type: "object", required: ["operations"], properties: {
        baseRevision: { type: "number", description: "Revision returned by the latest inspection. A stale revision is rejected to protect newer human edits." },
        operations: { type: "array", minItems: 1, maxItems: 120, items: {
          type: "object", required: ["type"], properties: {
            type: { type: "string", enum: ["create_text", "create_highlight", "highlight_text", "create_shape", "create_arrow", "create_stroke", "create_polygon", "translate", "resize", "update_text", "update_points", "update_style", "reorder", "connect", "align", "distribute", "duplicate", "group", "ungroup", "delete"] },
            id: { type: "string" }, ids: { type: "array", items: { type: "string" } },
            groupId: { type: "string" },
            x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
            dx: { type: "number" }, dy: { type: "number" }, text: { type: "string" }, fontSize: { type: "number" },
            fontFamily: { type: "string", enum: ["sans", "serif", "mono", "handwriting"] }, fontWeight: { type: "number", enum: [400, 500, 600, 700] }, fontStyle: { type: "string", enum: ["normal", "italic"] }, textAlign: { type: "string", enum: ["left", "center", "right"] },
            kind: { type: "string", enum: ["rectangle", "ellipse"] }, filled: { type: "boolean" }, closed: { type: "boolean" }, size: { type: "number" },
            color: { type: "string" }, strokeWidth: { type: "number" }, fillColor: { type: "string" }, fillOpacity: { type: "number" }, radius: { type: "number" }, opacity: { type: "number" }, padding: { type: "number" },
            lineStyle: { type: "string", enum: ["solid", "dashed", "dotted"] }, arrowHeads: { type: "string", enum: ["end", "start", "both"] },
            direction: { type: "string", enum: ["front", "back"] }, fromId: { type: "string" }, toId: { type: "string" }, label: { type: "string" },
            alignment: { type: "string", enum: ["left", "center-x", "right", "top", "center-y", "bottom"] }, axis: { type: "string", enum: ["horizontal", "vertical"] }, gap: { type: "number" },
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
    name: "create_structured_visual",
    title: "Create editable visual structure",
    description: "Create a polished, fully editable UI wireframe, flowchart, mindmap, research brief, step-by-step calculation, or plotted graph. Use this for coherent visual proposals; then refine individual objects with apply_whiteboard_changes. Nodes remain grouped and connectors stay attached when the human moves them.",
    inputSchema: {
      type: "object", required: ["kind"], properties: {
        baseRevision: { type: "number", description: "Revision from the latest inspect_whiteboard call." },
        kind: { type: "string", enum: ["flowchart", "mindmap", "ui_wireframe", "research_report", "math_steps", "plot"] },
        id: { type: "string", description: "Stable prefix for generated editable object IDs." }, title: { type: "string" },
        x: { type: "number", description: "World-coordinate origin." }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
        nodes: { type: "array", maxItems: 40, items: { type: "object", required: ["id", "label"], properties: {
          id: { type: "string" }, label: { type: "string" }, detail: { type: "string" }, parentId: { type: "string" },
          role: { type: "string", enum: ["primary", "secondary", "decision", "frame", "header", "sidebar", "card", "button", "input", "text"] },
          x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }
        } } },
        edges: { type: "array", maxItems: 80, items: { type: "object", required: ["fromId", "toId"], properties: { fromId: { type: "string" }, toId: { type: "string" }, label: { type: "string" } } } },
        sections: { type: "array", maxItems: 20, items: { type: "object", required: ["heading", "body"], properties: { heading: { type: "string" }, body: { type: "string" } } } },
        steps: { type: "array", maxItems: 30, items: { type: "object", required: ["expression"], properties: { expression: { type: "string" }, explanation: { type: "string" } } } },
        axes: { type: "object", required: ["xMin", "xMax", "yMin", "yMax"], properties: { xMin: { type: "number" }, xMax: { type: "number" }, yMin: { type: "number" }, yMax: { type: "number" }, xLabel: { type: "string" }, yLabel: { type: "string" } } },
        series: { type: "array", maxItems: 8, items: { type: "object", required: ["points"], properties: { label: { type: "string" }, color: { type: "string" }, points: { type: "array", maxItems: 400, items: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } } } } } }
      }
    },
    execute: async (input) => result(await host.compose(input as unknown as VisualCompositionInput, typeof input.baseRevision === "number" ? input.baseRevision : undefined))
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
