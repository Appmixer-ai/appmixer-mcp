import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import { AppmixerClient } from './client.js';
import { registerApiTools } from './tools/api.js';
import { registerAuthoringTools } from './tools/authoring.js';
import { registerDataTools } from './tools/data.js';
import { GatewayManager, type Logger } from './tools/gateway.js';
import { FLOW_AUTHORING_GUIDE } from './guide.js';
import { VERSION } from './version.js';

export { VERSION } from './version.js';

const INSTRUCTIONS = `Tools for the Appmixer workflow-automation platform, operating on the
authenticated user's tenant.

- Flow IDs are not guessable: call list_flows first.
- get_flow without include_descriptor lists the flow's components and their IDs
  (needed by trigger_component); request the full descriptor only when you need
  the wiring details.
- To BUILD or MODIFY a flow: read get_flow_authoring_guide first, discover exact
  component types/ports/fields with list_apps + get_components, then create_flow,
  fix errors reported by validate_flow via update_flow, and finally start_flow.
  Never guess component types, port names or output variable paths — after
  creating the flow, get_flow_variables returns the exact variable paths and
  test_flow lets you dry-run a component with sample input before starting.
- Components of third-party apps need a connected account: check with
  get_flow_accounts, connect accounts in the Appmixer UI, bind with assign_account.
- Additional tools may appear or disappear at runtime: any flow that contains a
  running "MCP Gateway" component contributes its connected tools to this server.`;

export interface AppmixerMcpServer {
    server: McpServer;
    client: AppmixerClient;
    gatewayManager?: GatewayManager;
    start(): Promise<void>;
    stop(): void;
}

export function createAppmixerServer(config: Config, log: Logger): AppmixerMcpServer {

    const client = new AppmixerClient(config);
    const server = new McpServer(
        { name: 'appmixer', version: VERSION },
        { instructions: INSTRUCTIONS }
    );

    if (config.tools.has('api')) {
        registerApiTools(server, client);
        registerAuthoringTools(server, client);
        registerDataTools(server, client);
        server.registerResource(
            'flow-authoring-guide',
            'appmixer://guides/flow-authoring',
            {
                title: 'Appmixer Flow Authoring Guide',
                description: 'How to write a valid Appmixer flow descriptor JSON.',
                mimeType: 'text/markdown'
            },
            async (uri) => ({
                contents: [{ uri: uri.href, mimeType: 'text/markdown', text: FLOW_AUTHORING_GUIDE }]
            })
        );
    }

    let gatewayManager: GatewayManager | undefined;
    if (config.tools.has('mcpgateway')) {
        gatewayManager = new GatewayManager(server, client, log);
    }

    return {
        server,
        client,
        gatewayManager,
        async start() {
            // Load gateway tools before the client's first tools/list if possible,
            // but never fail server startup because of the gateway plugin.
            if (gatewayManager) {
                try {
                    await gatewayManager.start();
                } catch (err) {
                    log('Gateway manager failed to start; continuing with API tools only.', err);
                }
            }
        },
        stop() {
            gatewayManager?.stop();
        }
    };
}
