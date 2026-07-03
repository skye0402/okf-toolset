import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DefaultOkfToolbox } from '../../src/index.js';
import { FileOkfStore } from '../../src/fs/index.js';
import { registerOkfTools } from '../../src/mcp/index.js';
import { OkfSearchEngine } from '../../src/search/index.js';

const server = new McpServer({ name: 'okf-example', version: '0.1.0' });
const store = new FileOkfStore('tests/fixtures/minimal');
registerOkfTools(server, new DefaultOkfToolbox(new OkfSearchEngine(store)), { store });

console.log('Attach your preferred MCP transport to server.');
