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

server.registerResource('fixture-resource', 'fixture://readme', {
  title: 'Fixture resource',
  description: 'A fixture text resource',
  mimeType: 'text/plain'
}, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'fixture-resource-body' }]
}))

server.registerPrompt('greet', {
  title: 'Greeting prompt',
  description: 'Greets a named user',
  argsSchema: { name: z.string() }
}, async ({ name }) => ({
  description: 'A fixture greeting',
  messages: [{ role: 'user', content: { type: 'text', text: `Hello ${name}` } }]
}))

await server.connect(new StdioServerTransport())