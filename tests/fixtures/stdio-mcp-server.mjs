import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'stdio-fixture', version: '1.0.0' })
server.registerTool('echo', {
  title: 'Echo text',
  inputSchema: { text: z.string() }
}, async ({ text }) => ({
  content: [{ type: 'text', text: `stdio:${text}` }],
  structuredContent: { transport: 'stdio', text, fixtureValue: process.env.FIXTURE_VALUE ?? null }
}))

await server.connect(new StdioServerTransport())