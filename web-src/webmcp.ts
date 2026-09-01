import { CanvasOperation, PriorityRegion } from "./model";
import { VisualCompositionInput } from "./compositions";

interface ToolResult { content: Array<{ type: "text"; text: string }> }
interface ModelContext {
  registerTool(tool: { name: string; title?: string; description: string; inputSchema?: Record<string, unknown>; execute: (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult }, options?: { signal?: AbortSignal }): Promise<void> | void;
}
declare global { interface Document { modelContext?: ModelContext } }

export interface WebMcpHost {
  session(): Record<string, unknown>;
  waitForTurn(timeoutMs: number): Promise<Record<string, unknown>>;
  inspect(scope: "all" | "priority" | "selection"): Record<string, unknown>;
  focus(bounds: PriorityRegion["bounds"]): Record<string, unknown>;
  publishPlan(summary: string, leaseToken?: string): Record<string, unknown>;
  apply(operations: CanvasOperation[], baseRevision?: number, leaseToken?: string): Promise<Record<string, unknown>>;
  compose(input: VisualCompositionInput, baseRevision?: number, leaseToken?: string): Promise<Record<string, unknown>>;
  complete(summary: string, leaseToken?: string): Record<string, unknown>;
}

const result = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const token = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

const operationSchema = {
  type: "object", required: ["type"], properties: {
    type: { type: "string", enum: ["create_text", "create_note", "create_table", "create_frame", "create_highlight", "highlight_text", "create_shape", "create_arrow", "create_stroke", "create_polygon", "create_icon", "create_agent_marker", "translate", "resize", "update_text", "update_points", "update_style", "set_locked", "reorder", "connect", "align", "distribute", "duplicate", "group", "ungroup", "set_parent", "update_artboard", "set_explanation_sequence", "delete"] },
    id: { type: "string" }, ids: { type: "array", items: { type: "string" } }, groupId: { type: "string" }, parentId: { type: "string" }, anchorId: { type: "string" }, name: { type: "string" }, semanticRole: { type: "string" }, locked: { type: "boolean" },
    x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, dx: { type: "number" }, dy: { type: "number" },
    text: { type: "string" }, title: { type: "string" }, fontSize: { type: "number" }, fontFamily: { type: "string", enum: ["sans", "serif", "mono", "handwriting"] }, fontWeight: { type: "number", enum: [400, 500, 600, 700] }, fontStyle: { type: "string", enum: ["normal", "italic"] }, textDecoration: { type: "string", enum: ["none", "underline", "line-through"] }, textAlign: { type: "string", enum: ["left", "center", "right"] }, blockStyle: { type: "string", enum: ["body", "heading-1", "heading-2", "heading-3", "bullet", "numbered", "check", "quote", "code", "math"] },
    rows: { type: "number" }, columns: { type: "number" }, headers: { type: "array", items: { type: "string" } }, cells: { type: "array", items: { type: "string" } },
    kind: { type: "string", enum: ["rectangle", "ellipse"] }, filled: { type: "boolean" }, closed: { type: "boolean" }, size: { type: "number" }, color: { type: "string" }, backgroundColor: { type: "string" }, strokeWidth: { type: "number" }, fillColor: { type: "string" }, fillOpacity: { type: "number" }, radius: { type: "number" }, opacity: { type: "number" }, padding: { type: "number" }, highlightColor: { type: "string" }, renderStyle: { type: "string", enum: ["clean", "sketch"] }, artboardPreset: { type: "string", enum: ["desktop", "tablet", "mobile", "custom"] }, preset: { type: "string", enum: ["desktop", "tablet", "mobile", "custom"] }, clipContent: { type: "boolean" },
    lineStyle: { type: "string", enum: ["solid", "dashed", "dotted"] }, arrowHeads: { type: "string", enum: ["end", "start", "both"] }, direction: { type: "string", enum: ["front", "back"] }, fromId: { type: "string" }, toId: { type: "string" }, label: { type: "string" }, alignment: { type: "string", enum: ["left", "center-x", "right", "top", "center-y", "bottom"] }, axis: { type: "string", enum: ["horizontal", "vertical"] }, gap: { type: "number" },
    from: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } }, to: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } }, points: { type: "array", items: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" }, pressure: { type: "number" }, time: { type: "number" } } } },
    sequence: { type: "object", required: ["id", "title", "steps"], properties: { id: { type: "string" }, title: { type: "string" }, steps: { type: "array", maxItems: 60, items: { type: "object", required: ["id", "title", "focusElementIds", "revealElementIds"], properties: { id: { type: "string" }, title: { type: "string" }, body: { type: "string" }, focusElementIds: { type: "array", items: { type: "string" } }, revealElementIds: { type: "array", items: { type: "string" } } } } } } }
  }
};

const compositionSchema = {
  type: "object", required: ["kind"], properties: {
    leaseToken: { type: "string" }, baseRevision: { type: "number" }, kind: { type: "string", enum: ["flowchart", "mindmap", "ui_wireframe", "ui_mockup", "research_report", "math_steps", "plot", "study_note", "timeline", "comparison", "hierarchy", "visual_explainer", "guided_explainer"] },
    id: { type: "string" }, title: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
    nodes: { type: "array", maxItems: 40, items: { type: "object", required: ["id", "label"], properties: { id: { type: "string" }, label: { type: "string" }, detail: { type: "string" }, parentId: { type: "string" }, role: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } } } },
    edges: { type: "array", maxItems: 80, items: { type: "object", required: ["fromId", "toId"], properties: { fromId: { type: "string" }, toId: { type: "string" }, label: { type: "string" } } } },
    sections: { type: "array", maxItems: 24, items: { type: "object", required: ["heading", "body"], properties: { heading: { type: "string" }, body: { type: "string" } } } },
    steps: { type: "array", maxItems: 30, items: { type: "object", required: ["expression"], properties: { expression: { type: "string" }, explanation: { type: "string" } } } },
    axes: { type: "object", properties: { xMin: { type: "number" }, xMax: { type: "number" }, yMin: { type: "number" }, yMax: { type: "number" }, xLabel: { type: "string" }, yLabel: { type: "string" } } },
    series: { type: "array", maxItems: 8, items: { type: "object", required: ["points"], properties: { label: { type: "string" }, color: { type: "string" }, points: { type: "array", maxItems: 400, items: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } } } } } },
    presentationSteps: { type: "array", maxItems: 40, items: { type: "object", required: ["title", "focusIds"], properties: { title: { type: "string" }, body: { type: "string" }, focusIds: { type: "array", items: { type: "string" } }, revealIds: { type: "array", items: { type: "string" } } } } },
    theme: { type: "object", properties: { background: { type: "string" }, surface: { type: "string" }, text: { type: "string" }, accent: { type: "string" } } }
  }
};

export async function registerWhiteboardTools(host: WebMcpHost, signal: AbortSignal): Promise<boolean> {
  const context = document.modelContext; if (!context) return false;
  const register = (tool: Parameters<ModelContext["registerTool"]>[0]) => context.registerTool(tool, { signal });
  await register({ name: "start_whiteboard_session", title: "Start whiteboard session", description: "Start the alternating workflow. If no human turn is queued, call wait_for_human_turn next.", inputSchema: { type: "object", properties: {} }, execute: () => result(host.session()) });
  await register({ name: "wait_for_human_turn", title: "Wait for human note", description: "Wait until the human presses the submit arrow. Claims one turn and returns the text prompt, priority regions, blue AI-pen ink and local English handwriting transcriptions. Complete the contribution and then wait again.", inputSchema: { type: "object", properties: { timeoutMs: { type: "number", minimum: 1000, maximum: 20000 } } }, execute: async (input) => result(await host.waitForTurn(Math.max(1000, Math.min(20000, number(input.timeoutMs) ?? 15000)))) });
  await register({ name: "inspect_whiteboard", title: "Inspect shared whiteboard", description: "Read prompt, blue AI pen, editable objects, artboards, explanation sequences and layout quality warnings. Recognized handwriting is metadata only; visible strokes remain the source of truth.", inputSchema: { type: "object", properties: { scope: { type: "string", enum: ["all", "priority", "selection"] } } }, execute: (input) => result(host.inspect(input.scope === "selection" ? "selection" : input.scope === "priority" ? "priority" : "all")) });
  await register({ name: "focus_whiteboard_region", title: "Focus a whiteboard region", description: "Move the human-visible camera to a world-coordinate region before explaining or editing it.", inputSchema: { type: "object", required: ["minX", "minY", "maxX", "maxY"], properties: { minX: { type: "number" }, minY: { type: "number" }, maxX: { type: "number" }, maxY: { type: "number" } } }, execute: (input) => result(host.focus({ minX: number(input.minX) ?? 0, minY: number(input.minY) ?? 0, maxX: number(input.maxX) ?? 0, maxY: number(input.maxY) ?? 0 })) });
  await register({ name: "publish_agent_plan", title: "Publish agent plan", description: "Publish one concise line about the next visual step before editing. Do not narrate chain-of-thought.", inputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" }, leaseToken: { type: "string" } } }, execute: (input) => result(host.publishPlan(String(input.summary ?? ""), token(input.leaseToken))) });
  await register({ name: "apply_whiteboard_changes", title: "Edit shared whiteboard", description: "Create or edit movable canvas objects: rich text, agent-only tables, artboards, highlights, filled shapes, arrows, icons, custom drawings, temporary red agent comments, groups, explanation steps and layout. Changes remain a proposal until the human accepts them.", inputSchema: { type: "object", required: ["operations"], properties: { leaseToken: { type: "string" }, baseRevision: { type: "number" }, operations: { type: "array", minItems: 1, maxItems: 160, items: operationSchema } } }, execute: async (input) => result(await host.apply((input.operations as CanvasOperation[]) ?? [], number(input.baseRevision), token(input.leaseToken))) });
  await register({ name: "create_structured_visual", title: "Create editable visual", description: "Create an editable study note, guided explainer, diagram, timeline, comparison, hierarchy, styled UI mockup, research brief, math derivation or plot. Prefer student-like composition and sketch accents where they clarify.", inputSchema: compositionSchema, execute: async (input) => result(await host.compose(input as unknown as VisualCompositionInput, number(input.baseRevision), token(input.leaseToken))) });
  await register({ name: "complete_whiteboard_contribution", title: "Finish whiteboard turn", description: "Finish the claimed turn, show the human a short result summary, then call wait_for_human_turn again.", inputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" }, leaseToken: { type: "string" } } }, execute: (input) => result(host.complete(String(input.summary ?? "Beitrag abgeschlossen"), token(input.leaseToken))) });
  return true;
}
