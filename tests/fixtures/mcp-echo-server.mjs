// Tiny MCP server over stdio, used by tests/mcp.test.ts to exercise the real process transport.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo', version: '1.0.0' });
server.registerTool(
  'echo',
  { description: 'Echo the text back', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text} (${process.env.ECHO_PREFIX ?? 'no env'})` }] }),
);
console.error('echo server ready'); // goes to stderr, which the client pipes
await server.connect(new StdioServerTransport());
