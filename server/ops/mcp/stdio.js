// stdio entry point for desktop MCP clients (Claude Desktop, Claude Code, MCP Inspector).
// The principal comes from the environment and defaults to read-only. Consequential tools still
// require a human-approved approval_id recorded through the AirportOps UI, whatever the role.
//   OPS_MCP_USER=admin OPS_MCP_ROLE=admin node ops/mcp/stdio.js
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') });
const { createOpsMcpServer } = await import('./server.js');

const principal = {
  username: process.env.OPS_MCP_USER || 'mcp-stdio',
  role: process.env.OPS_MCP_ROLE === 'admin' ? 'admin' : 'regular',
};
const server = createOpsMcpServer(() => principal);
await server.connect(new StdioServerTransport());
console.error(`[airportops-mcp] stdio server ready as ${principal.username} (${principal.role})`);
