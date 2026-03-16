import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SFMCClient } from './sfmc-client.js';

// ── Config MCP ────────────────────────────────────────────────────────────────────

const cfg = {
    clientId: process.env.SFMC_CLIENT_ID ?? '',
    clientSecret: process.env.SFMC_CLIENT_SECRET ?? '',
    authBaseUri: process.env.SFMC_AUTH_BASE_URI ?? '',
    restBaseUri: process.env.SFMC_REST_BASE_URI ?? '',
    soapBaseUri: process.env.SFMC_SOAP_BASE_URI,
    defaultAccountId: process.env.SFMC_ACCOUNT_ID,
};

if (!cfg.clientId || !cfg.clientSecret || !cfg.authBaseUri || !cfg.restBaseUri) {
    console.error('ERROR: Missing required SFMC credentials. Set SFMC_CLIENT_ID, SFMC_CLIENT_SECRET, SFMC_AUTH_BASE_URI, SFMC_REST_BASE_URI.');
    process.exit(1);
}

const client = new SFMCClient(cfg);
const server = new McpServer({ name: 'SFMC-MCP-V2', version: '2.0.0' });

// ── Helpers ───────────────────────────────────────────────────────────────────

const MAX_CHARS = 200_000;

function ok(data: any): { content: { type: 'text'; text: string }[] } {
    let text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    let truncated = false;
    if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS);
        truncated = true;
    }
    if (truncated) {
        text += '\n\n[RESPONSE TRUNCATED - use pagination or narrower filters to get complete data]';
    }
    return { content: [{ type: 'text', text }] };
}

function err(e: any): { content: { type: 'text'; text: string }[]; isError: true } {
    return { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true };
}

const midParam = z.string().optional().describe(
    'Target Business Unit MID. Omit to use default BU. Pass parent MID (e.g. 500009156) to query the parent/enterprise BU.'
);

// ── Tools ─────────────────────────────────────────────────────────────────────

// 1. Generic REST
server.tool(
    'sfmc_rest_request',
    'Make a request to any SFMC REST API endpoint. Pass mid to target a specific Business Unit.',
    {
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        endpoint: z.string().describe('API endpoint path starting with /'),
        data: z.any().optional().describe('Request body for POST/PUT/PATCH'),
        params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe('Query parameters'),
        mid: midParam,
    },
    async ({ method, endpoint, data, params, mid }) => {
        try {
            const result = await client.rest(method, endpoint, { data, params, mid });
            return ok(result);
        } catch (e) { return err(e); }
    }
);

// 2. SOAP
server.tool(
    'sfmc_soap_request',
    'Make a SOAP API request to SFMC (useful for Account/BU management and other SOAP-only operations). Pass mid to target a specific BU.',
    {
        action: z.string().describe('SOAP action (e.g. Retrieve, Create, Update, Delete)'),
        body: z.string().describe('XML content to place inside <s:Body>'),
        mid: midParam,
    },
    async ({ action, body, mid }) => {
        try {
            const result = await client.soap(action, body, mid);
            return ok(result);
        } catch (e) { return err(e); }
    }
);

// 3. List Business Units
server.tool(
    'sfmc_list_business_units',
    'List all Business Units accessible from this account, including name, ID, parent ID, and active status.',
    {
        mid: midParam,
    },
    async ({ mid }) => {
        try {
            const body = `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
  <RetrieveRequest>
    <ObjectType>BusinessUnit</ObjectType>
    <Properties>ID</Properties>
    <Properties>Name</Properties>
    <Properties>ParentID</Properties>
    <Properties>IsActive</Properties>
    <Properties>AccountType</Properties>
    <Properties>CustomerKey</Properties>
  </RetrieveRequest>
</RetrieveRequestMsg>`;
            const result = await client.soap('Retrieve', body, mid);
            return ok(result);
        } catch (e) { return err(e); }
    }
);

// 4. List CloudPages (webpages)
server.tool(
    'sfmc_list_cloudpages',
    'List CloudPages (webpages) in SFMC. Pass mid to list pages from a specific Business Unit.',
    {
        page: z.number().optional().default(1).describe('Page number (default: 1)'),
        pageSize: z.number().optional().default(50).describe('Results per page (default: 50, max: 200)'),
        nameFilter: z.string().optional().describe('Filter pages by name (partial match)'),
        mid: midParam,
    },
    async ({ page, pageSize, nameFilter, mid }) => {
        try {
            const query: any = {
                leftOperand: {
                    property: 'assetType.name',
                    simpleOperator: 'equal',
                    value: 'webpage',
                },
                logicalOperator: 'AND',
                rightOperand: nameFilter
                    ? {
                          property: 'name',
                          simpleOperator: 'like',
                          value: nameFilter,
                      }
                    : {
                          property: 'assetType.name',
                          simpleOperator: 'equal',
                          value: 'webpage',
                      },
            };

            const result = await client.rest('POST', '/asset/v1/content/assets/query', {
                data: {
                    query,
                    fields: ['id', 'name', 'assetType', 'status', 'createdDate', 'modifiedDate', 'owner', 'enterpriseId', 'memberId'],
                    page: { page, pageSize: Math.min(pageSize, 200) },
                },
                mid,
            });

            // Return a clean summary
            const items = (result.items ?? []).map((p: any) => ({
                id: p.id,
                name: p.name,
                status: p.status?.id,
                buMid: p.memberId,
                created: p.createdDate,
                modified: p.modifiedDate,
                owner: p.owner?.name,
            }));

            return ok({ count: result.count, page: result.page, pageSize: result.pageSize, pages: Math.ceil((result.count ?? 0) / pageSize), items });
        } catch (e) { return err(e); }
    }
);

// 5. Get CloudPage detail
server.tool(
    'sfmc_get_cloudpage',
    'Get full details and content of a specific CloudPage by its asset ID.',
    {
        id: z.number().describe('Asset ID of the CloudPage'),
        mid: midParam,
    },
    async ({ id, mid }) => {
        try {
            const result = await client.rest('GET', `/asset/v1/content/assets/${id}`, { mid });
            return ok(result);
        } catch (e) { return err(e); }
    }
);

// 6. List Emails
server.tool(
    'sfmc_list_emails',
    'List email assets in SFMC. Pass mid to target a specific BU.',
    {
        page: z.number().optional().default(1),
        pageSize: z.number().optional().default(50),
        nameFilter: z.string().optional().describe('Filter by name (partial match)'),
        mid: midParam,
    },
    async ({ page, pageSize, nameFilter, mid }) => {
        try {
            const query: any = {
                leftOperand: {
                    property: 'assetType.name',
                    simpleOperator: 'equal',
                    value: 'htmlemail',
                },
                logicalOperator: 'AND',
                rightOperand: nameFilter
                    ? { property: 'name', simpleOperator: 'like', value: nameFilter }
                    : { property: 'assetType.name', simpleOperator: 'equal', value: 'htmlemail' },
            };

            const result = await client.rest('POST', '/asset/v1/content/assets/query', {
                data: {
                    query,
                    fields: ['id', 'name', 'assetType', 'status', 'createdDate', 'modifiedDate', 'owner', 'memberId'],
                    page: { page, pageSize: Math.min(pageSize, 200) },
                },
                mid,
            });

            const items = (result.items ?? []).map((e: any) => ({
                id: e.id,
                name: e.name,
                status: e.status?.id,
                buMid: e.memberId,
                created: e.createdDate,
                modified: e.modifiedDate,
                owner: e.owner?.name,
            }));

            return ok({ count: result.count, page: result.page, pageSize: result.pageSize, items });
        } catch (e) { return err(e); }
    }
);

// 7. List Data Extensions
server.tool(
    'sfmc_list_data_extensions',
    'List Data Extensions in SFMC with their keys and row counts.',
    {
        nameFilter: z.string().optional().describe('Filter by name (partial match)'),
        page: z.number().optional().default(1),
        pageSize: z.number().optional().default(50),
        mid: midParam,
    },
    async ({ nameFilter, page, pageSize, mid }) => {
        try {
            let filter = '';
            if (nameFilter) {
                filter = `<Filter xsi:type="SimpleFilterPart" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <Property>Name</Property>
      <SimpleOperator>like</SimpleOperator>
      <Value>${nameFilter}</Value>
    </Filter>`;
            }

            const body = `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
  <RetrieveRequest>
    <ObjectType>DataExtension</ObjectType>
    <Properties>Name</Properties>
    <Properties>CustomerKey</Properties>
    <Properties>Description</Properties>
    <Properties>IsSendable</Properties>
    <Properties>IsTestable</Properties>
    <Properties>CreatedDate</Properties>
    <Properties>ModifiedDate</Properties>
    ${filter}
  </RetrieveRequest>
</RetrieveRequestMsg>`;

            const result = await client.soap('Retrieve', body, mid);
            return ok(result);
        } catch (e) { return err(e); }
    }
);

// 8. Get Data Extension rows
server.tool(
    'sfmc_get_data_extension',
    'Get rows from a Data Extension by its external key.',
    {
        key: z.string().describe('External key of the Data Extension'),
        filter: z.string().optional().describe('Filter expression (e.g. "Status=Active")'),
        fields: z.array(z.string()).optional().describe('Fields to return (omit for all)'),
        orderBy: z.string().optional(),
        page: z.number().optional().default(1),
        pageSize: z.number().optional().default(50),
        mid: midParam,
    },
    async ({ key, filter, fields, orderBy, page, pageSize, mid }) => {
        try {
            const params: Record<string, any> = {};
            if (filter) params.$filter = filter;
            if (fields?.length) params.$fields = fields.join(',');
            if (orderBy) params.$orderBy = orderBy;
            params.$page = page;
            params.$pageSize = pageSize;

            const result = await client.rest('GET', `/data/v1/customobjectdata/key/${key}/rowset`, { params, mid });
            return ok(result);
        } catch (e) { return err(e); }
    }
);

// 9. List Journeys
server.tool(
    'sfmc_list_journeys',
    'List Journey Builder journeys. Pass mid to target a specific BU.',
    {
        nameFilter: z.string().optional().describe('Filter by name (partial match)'),
        status: z.enum(['Draft', 'Active', 'Paused', 'Stopped', 'Deleted']).optional(),
        page: z.number().optional().default(1),
        pageSize: z.number().optional().default(50),
        mid: midParam,
    },
    async ({ nameFilter, status, page, pageSize, mid }) => {
        try {
            const params: Record<string, any> = { $page: page, $pageSize: pageSize };
            if (nameFilter) params.nameFilter = nameFilter;
            if (status) params.status = status;

            const result = await client.rest('GET', '/interaction/v1/interactions', { params, mid });

            const items = (result.items ?? []).map((j: any) => ({
                id: j.id,
                key: j.key,
                name: j.name,
                status: j.status,
                version: j.version,
                created: j.createdDate,
                modified: j.modifiedDate,
                entryMode: j.entryMode,
            }));

            return ok({ count: result.count, page: result.page, pageSize: result.pageSize, items });
        } catch (e) { return err(e); }
    }
);

// 10. Get Journey detail
server.tool(
    'sfmc_get_journey',
    'Get full details of a specific Journey Builder journey by its ID.',
    {
        id: z.string().describe('Journey ID (GUID)'),
        version: z.number().optional().describe('Version number (omit for latest)'),
        mid: midParam,
    },
    async ({ id, version, mid }) => {
        try {
            const endpoint = version
                ? `/interaction/v1/interactions/${id}?versionNumber=${version}`
                : `/interaction/v1/interactions/${id}`;
            const result = await client.rest('GET', endpoint, { mid });
            return ok(result);
        } catch (e) { return err(e); }
    }
);

// 11. List Automations
server.tool(
    'sfmc_list_automations',
    'List Automation Studio automations. Pass mid to target a specific BU.',
    {
        page: z.number().optional().default(1),
        pageSize: z.number().optional().default(50),
        mid: midParam,
    },
    async ({ page, pageSize, mid }) => {
        try {
            const result = await client.rest('GET', '/automation/v1/automations', {
                params: { $page: page, $pageSize: pageSize },
                mid,
            });

            const items = (result.items ?? []).map((a: any) => ({
                id: a.id,
                key: a.key,
                name: a.name,
                status: a.status,
                schedule: a.schedule?.scheduledTime,
                lastRunTime: a.lastRunTime,
                description: a.description,
            }));

            return ok({ count: result.count, page: result.page, pageSize: result.pageSize, items });
        } catch (e) { return err(e); }
    }
);

// 12. Lookup Subscriber
server.tool(
    'sfmc_get_subscriber',
    'Look up a subscriber by email address or subscriber key.',
    {
        emailOrKey: z.string().describe('Email address or subscriber key to look up'),
        mid: midParam,
    },
    async ({ emailOrKey, mid }) => {
        try {
            const isEmail = emailOrKey.includes('@');
            const property = isEmail ? 'EmailAddress' : 'SubscriberKey';

            const body = `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
  <RetrieveRequest>
    <ObjectType>Subscriber</ObjectType>
    <Properties>ID</Properties>
    <Properties>SubscriberKey</Properties>
    <Properties>EmailAddress</Properties>
    <Properties>Status</Properties>
    <Properties>UnsubscribedDate</Properties>
    <Properties>CreatedDate</Properties>
    <Properties>ModifiedDate</Properties>
    <Filter xsi:type="SimpleFilterPart" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <Property>${property}</Property>
      <SimpleOperator>equals</SimpleOperator>
      <Value>${emailOrKey}</Value>
    </Filter>
  </RetrieveRequest>
</RetrieveRequestMsg>`;

            const result = await client.soap('Retrieve', body, mid);
            return ok(result);
        } catch (e) { return err(e); }
    }
);

// 13. Send Definition / Triggered Sends
server.tool(
    'sfmc_list_send_definitions',
    'List Triggered Send Definitions or Journey Send Definitions.',
    {
        type: z.enum(['triggered', 'journey']).optional().default('triggered'),
        page: z.number().optional().default(1),
        pageSize: z.number().optional().default(50),
        mid: midParam,
    },
    async ({ type, page, pageSize, mid }) => {
        try {
            if (type === 'journey') {
                const result = await client.rest('GET', '/messaging/v1/email/definitions', {
                    params: { $page: page, $pageSize: pageSize },
                    mid,
                });
                return ok(result);
            }

            const body = `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
  <RetrieveRequest>
    <ObjectType>TriggeredSendDefinition</ObjectType>
    <Properties>CustomerKey</Properties>
    <Properties>Name</Properties>
    <Properties>TriggeredSendStatus</Properties>
    <Properties>CreatedDate</Properties>
    <Properties>ModifiedDate</Properties>
  </RetrieveRequest>
</RetrieveRequestMsg>`;

            const result = await client.soap('Retrieve', body, mid);
            return ok(result);
        } catch (e) { return err(e); }
    }
);

// 14. List Contact/Audience Lists
server.tool(
    'sfmc_list_lists',
    'List subscriber lists in SFMC.',
    {
        nameFilter: z.string().optional(),
        mid: midParam,
    },
    async ({ nameFilter, mid }) => {
        try {
            let filter = '';
            if (nameFilter) {
                filter = `<Filter xsi:type="SimpleFilterPart" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <Property>ListName</Property>
      <SimpleOperator>like</SimpleOperator>
      <Value>${nameFilter}</Value>
    </Filter>`;
            }

            const body = `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
  <RetrieveRequest>
    <ObjectType>List</ObjectType>
    <Properties>ID</Properties>
    <Properties>ListName</Properties>
    <Properties>Description</Properties>
    <Properties>ListClassification</Properties>
    <Properties>Type</Properties>
    <Properties>CreatedDate</Properties>
    <Properties>ModifiedDate</Properties>
    ${filter}
  </RetrieveRequest>
</RetrieveRequestMsg>`;

            const result = await client.soap('Retrieve', body, mid);
            return ok(result);
        } catch (e) { return err(e); }
    }
);

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
    console.error('Starting SFMC MCP V2...');
    console.error(`Default BU: ${cfg.defaultAccountId ?? '(none)'}`);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('SFMC MCP V2 running');
}

main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
});
