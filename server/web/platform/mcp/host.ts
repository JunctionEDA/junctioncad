// host.ts — what a domain hands the headless tool host so that an AI assistant can work on its documents.
//
// The MCP endpoint (server/src/mcp.rs) runs every tool call in a Node process per person (server/src/mcp_host.rs).
// That process is one program (web/domains/pcb/mcp/host.ts, built into static/dist/mcp-host.js); each domain adds
// its tools to it as a table of functions, and lists their names, descriptions and argument schemas in
// web/domains/<id>/mcp/tools.json, which the server reads into the catalog (mcp.rs DOMAIN_TOOLS).  Nothing in a
// domain's table knows about another domain.
//
// A call arrives as an McpRequest and answers with an McpReply:
//   result   the JSON the model reads
//   png      a picture to show with it, base64 (the server sends it as an image)
//   record   for a change: { docId, title, edits, undo } — the server stores it, and hands `undo` back to the
//            domain's `undo` when the person's assistant calls undo_changes or redo_changes
//   swap     from `undo`: the record that takes this undo back (what redo_changes is handed)
// A failure a model can act on is thrown as an McpToolError; anything else is reported as an internal failure.

export interface McpDocEntry { docId: string; path: string; docType: string }
export interface McpProject { projectId: string; name: string; role: string; docs: McpDocEntry[] }

export interface McpRequest {
  id: number;
  /** the server's own address, and a short-lived token that acts as the person */
  base: string; token: string;
  /** the name of the AI client, shown to the people in the document */
  agent: string;
  canWrite: boolean;
  user: { id: number; login: string; name: string };
  tool: string;
  project: McpProject | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any;
}

export interface McpChangeRecord { docId: string; title: string; edits: string[]; undo: { domain: string; [key: string]: unknown } }
export interface McpReply { result: unknown; record?: McpChangeRecord; swap?: unknown; png?: string }

/** A failure whose message is for the model: what was wrong with the call and what to do instead. */
export class McpToolError extends Error {
  constructor(message: string) { super(message); this.name = "McpToolError"; }
}

export interface McpDomainTools {
  /** the domain's id (the folder under web/domains/); it marks the undo records the domain's tools leave */
  domain: string;
  tools: { [name: string]: (req: McpRequest) => Promise<McpReply> };
  /** Take back (or, for redo_changes, put back) a change one of the tools recorded: `req.args.__record` is the record. */
  undo?(req: McpRequest): Promise<McpReply>;
  /** Let go of documents nobody asked about for `idleMs`. */
  sweep?(idleMs: number): void;
}
