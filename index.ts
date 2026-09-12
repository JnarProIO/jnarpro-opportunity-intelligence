import http from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const OpportunitySchema = z.object({
  name: z.string(),
  recurringRevenue: z.boolean(),
  zeroUpfrontCost: z.boolean(),
  automationReady: z.boolean(),
  legitimateAcquisition: z.boolean(),
  scalable: z.boolean(),
  commissionRate: z.number().min(0).max(100),
});

type Opportunity = z.infer<typeof OpportunitySchema>;

function evaluateOpportunity(opportunity: Opportunity) {
  const o = OpportunitySchema.parse(opportunity);

  let score = 0;

  if (o.recurringRevenue) score += 25;
  if (o.zeroUpfrontCost) score += 20;
  if (o.automationReady) score += 20;
  if (o.legitimateAcquisition) score += 20;
  if (o.scalable) score += 10;

  score += Math.min(o.commissionRate / 20, 5);
  score = Math.round(score);

  const qualified =
    o.recurringRevenue &&
    o.zeroUpfrontCost &&
    o.automationReady &&
    o.legitimateAcquisition &&
    o.scalable &&
    score >= 80;

  return {
    ...o,
    score,
    tier: qualified ? "TIER_1" : score >= 60 ? "TIER_2" : "TIER_3",
    qualified,
  };
}


const WEB_SEARCH_MCP_ENDPOINT = "https://web-search-mcp.mcpize.run";

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
};

type RemoteTool = {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
};

function parseMcpPayload(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as JsonRpcResponse;
  }

  // Streamable HTTP may answer as SSE. Use the last JSON data event.
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  for (let i = dataLines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(dataLines[i]) as JsonRpcResponse;
    } catch {
      // Continue until a JSON data event is found.
    }
  }

  throw new Error("Remote MCP returned an unsupported response format");
}

async function remoteMcpRequest(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
  sessionId?: string
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
  };

  if (sessionId) headers["mcp-session-id"] = sessionId;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Remote MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const payload = parseMcpPayload(text);
  if (payload.error) {
    throw new Error(
      `Remote MCP error ${payload.error.code ?? ""}: ${payload.error.message ?? "unknown error"}`
    );
  }

  return {
    payload,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  };
}

async function initializeRemoteSearch(apiKey: string) {
  const endpoints = [
    `${WEB_SEARCH_MCP_ENDPOINT}/mcp`,
    WEB_SEARCH_MCP_ENDPOINT,
  ];

  let lastError: unknown;

  for (const endpoint of endpoints) {
    try {
      const initialized = await remoteMcpRequest(endpoint, apiKey, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {
            name: "JnarPro IO Opportunity Hunter",
            version: "1.0.0",
          },
        },
      });

      if (initialized.sessionId) {
        // MCP initialized notification is best-effort; some gateways do not require it.
        try {
          await remoteMcpRequest(
            endpoint,
            apiKey,
            {
              jsonrpc: "2.0",
              method: "notifications/initialized",
            },
            initialized.sessionId
          );
        } catch {
          // Do not fail discovery because a gateway rejects notification responses.
        }
      }

      return { endpoint, sessionId: initialized.sessionId };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to initialize web-search-mcp");
}

function chooseSearchTool(tools: RemoteTool[]): RemoteTool | undefined {
  return tools.find((tool) => {
    const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
    const props = tool.inputSchema?.properties ?? {};
    return (
      (haystack.includes("search") || haystack.includes("web")) &&
      Object.prototype.hasOwnProperty.call(props, "query")
    );
  });
}

function buildSearchArguments(tool: RemoteTool, query: string, maxResults: number) {
  const props = tool.inputSchema?.properties ?? {};
  const args: Record<string, unknown> = { query };

  if ("limit" in props) args.limit = maxResults;
  if ("maxResults" in props) args.maxResults = maxResults;
  if ("count" in props) args.count = maxResults;

  return args;
}

async function runExternalOpportunitySearch(query: string, maxResults: number) {
  const apiKey = process.env.WEB_SEARCH_MCP_API_KEY;
  if (!apiKey) {
    throw new Error("WEB_SEARCH_MCP_API_KEY is not configured");
  }

  const connection = await initializeRemoteSearch(apiKey);
  const listed = await remoteMcpRequest(
    connection.endpoint,
    apiKey,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    connection.sessionId
  );

  const tools = (listed.payload.result?.tools ?? []) as RemoteTool[];
  const searchTool = chooseSearchTool(tools);
  if (!searchTool) {
    throw new Error(
      `No compatible search tool found. Available tools: ${tools.map((t) => t.name).join(", ")}`
    );
  }

  const called = await remoteMcpRequest(
    connection.endpoint,
    apiKey,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: searchTool.name,
        arguments: buildSearchArguments(searchTool, query, maxResults),
      },
    },
    listed.sessionId ?? connection.sessionId
  );

  return {
    source: "web-search-mcp",
    tool: searchTool.name,
    query,
    result: called.payload.result,
  };
}

function createMcpServer() {
  const server = new McpServer({
    name: "JnarPro IO Opportunity Intelligence",
    version: "1.0.0",
  });

  server.tool(
    "score_opportunity",
    "Evaluate and score a potential recurring-revenue opportunity for JnarPro IO.",
    {
      name: z.string(),
      recurringRevenue: z.boolean(),
      zeroUpfrontCost: z.boolean(),
      automationReady: z.boolean(),
      legitimateAcquisition: z.boolean(),
      scalable: z.boolean(),
      commissionRate: z.number().min(0).max(100),
    },
    async (input) => {
      const result = evaluateOpportunity(input);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "hunt_opportunities",
    "Search the live web for recurring-revenue opportunities and return source evidence for JnarPro IO qualification.",
    {
      query: z
        .string()
        .min(3)
        .default(
          'affiliate API recurring commission "free to join" OR "no upfront cost" automation'
        ),
      maxResults: z.number().int().min(1).max(10).default(5),
    },
    async ({ query, maxResults }) => {
      try {
        const result = await runExternalOpportunitySearch(query, maxResults);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "EVIDENCE_COLLECTED",
                  qualificationStatus: "UNVERIFIED",
                  note: "External evidence has been collected. A candidate is not TIER_1 until every JnarPro IO non-negotiable is verified from source evidence.",
                  ...result,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "SEARCH_ERROR",
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "system_status",
    "Return the current JnarPro IO Opportunity Intelligence system status.",
    {},
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              system: "JnarPro IO",
              module: "Opportunity Intelligence",
              status: "online",
              opportunityHunter: {
                externalSearchConfigured: Boolean(process.env.WEB_SEARCH_MCP_API_KEY),
                source: "web-search-mcp",
                stage: "external evidence collection",
              },
              requirements: [
                "$0 upfront cost",
                "recurring revenue",
                "automation capable",
                "legitimate customer acquisition",
                "scalable",
              ],
            },
            null,
            2
          ),
        },
      ],
    })
  );

  return server;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      if (!body) {
        resolve(undefined);
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

const httpTransports: Record<string, StreamableHTTPServerTransport> = {};
const sseTransports: Record<string, SSEServerTransport> = {};

async function handleStreamableHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  try {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId =
      typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;

    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId && httpTransports[sessionId]) {
      transport = httpTransports[sessionId];
    }

    let body: unknown = undefined;

    if (req.method === "POST") {
      body = await readJsonBody(req);
    }

    if (!transport && req.method === "POST" && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          httpTransports[newSessionId] = transport!;
        },
      });

      transport.onclose = () => {
        if (transport?.sessionId) {
          delete httpTransports[transport.sessionId];
        }
      };

      const server = createMcpServer();
      await server.connect(transport);
    }

    if (!transport) {
      res.writeHead(400, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Invalid or missing MCP session",
          },
          id: null,
        })
      );

      return;
    }

    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error("Streamable HTTP error:", error);

    if (!res.headersSent) {
      res.writeHead(500, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        })
      );
    }
  }
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`
    );

    /*
     * MODERN MCP
     * Support BOTH "/" and "/mcp" so MCPize discovery works
     * regardless of which HTTP endpoint it probes.
     */
    if (
      (requestUrl.pathname === "/" || requestUrl.pathname === "/mcp") &&
      (req.method === "POST" ||
        req.method === "GET" ||
        req.method === "DELETE")
    ) {
      /*
       * A normal browser GET to "/" receives a health response.
       * MCP GET requests include an MCP session ID.
       */
      if (
        requestUrl.pathname === "/" &&
        req.method === "GET" &&
        !req.headers["mcp-session-id"]
      ) {
        res.writeHead(200, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            name: "JnarPro IO Opportunity Intelligence",
            status: "online",
            mcp: true,
            streamableHttpEndpoint: "/mcp",
            sseEndpoint: "/sse",
          })
        );

        return;
      }

      await handleStreamableHttp(req, res);
      return;
    }

    /*
     * LEGACY SSE MCP
     */
    if (requestUrl.pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res);

      sseTransports[transport.sessionId] = transport;

      res.on("close", () => {
        delete sseTransports[transport.sessionId];
      });

      const server = createMcpServer();
      await server.connect(transport);

      return;
    }

    if (requestUrl.pathname === "/messages" && req.method === "POST") {
      const sessionId = requestUrl.searchParams.get("sessionId");

      if (!sessionId) {
        res.writeHead(400);
        res.end("Missing sessionId");
        return;
      }

      const transport = sseTransports[sessionId];

      if (!transport) {
        res.writeHead(404);
        res.end("Unknown MCP session");
        return;
      }

      const body = await readJsonBody(req);

      await transport.handlePostMessage(req, res, body);
      return;
    }

    /*
     * HEALTH CHECK
     */
    if (requestUrl.pathname === "/health") {
      res.writeHead(200, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          status: "ok",
          system: "JnarPro IO Opportunity Intelligence",
        })
      );

      return;
    }

    res.writeHead(404, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        error: "Not found",
      })
    );
  } catch (error) {
    console.error("Server error:", error);

    if (!res.headersSent) {
      res.writeHead(500);
      res.end("Internal server error");
    }
  }
});

const port = Number(process.env.PORT ?? 3000);

httpServer.listen(port, "0.0.0.0", () => {
  console.error(
    `JnarPro IO Opportunity Intelligence running on port ${port}`
  );
});            
