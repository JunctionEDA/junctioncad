// mcp-tools.ts — the domains that give an AI assistant tools of their own, for the headless tool host
// (web/domains/pcb/mcp/host.ts; the contract is web/platform/mcp/host.ts).
//
// A domain's tools live in its own folder: `mcp/host.ts` exports the table of functions, `mcp/tools.json` lists
// the names, descriptions and argument schemas the server offers (server/src/mcp.rs DOMAIN_TOOLS).  To add a
// domain's tools, add its table here and its tools.json there.  The electronics tools predate this list and are
// the host's own.
import type { McpDomainTools } from "../platform/mcp/host";
import { MECHANICAL_TOOLS } from "./mechanical/mcp/host";

export const DOMAIN_TOOLS: readonly McpDomainTools[] = [MECHANICAL_TOOLS];
