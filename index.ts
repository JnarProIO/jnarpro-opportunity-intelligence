import http from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

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
              qualificationRules: {
                zeroUpfrontCost: true,
                recurringRevenueRequired: true,
                automationRequired: true,
                legitimateAcquisitionRequired: true,
                scalabilityRequired: true,
              },
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

const transports: Record<string, SSEServerTransport> = {};

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`
    );

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          name: "JnarPro IO Opportunity Intelligence",
          status: "online",
          transport: "sse",
          endpoint: "/sse",
        })
      );

      return;
    }

    if (req.method === "GET" && url.pathname === "/sse") {
      const server = createMcpServer();
      const transport = new SSEServerTransport("/messages", res);

      transports[transport.sessionId] = transport;

      res.on("close", () => {
        delete transports[transport.sessionId];
      });

      await server.connect(transport);
      return;
    }

    if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId");

      if (!sessionId) {
        res.writeHead(400);
        res.end("Missing sessionId");
        return;
      }

      const transport = transports[sessionId];

      if (!transport) {
        res.writeHead(404);
        res.end("Unknown MCP session");
        return;
      }

      let body = "";

      req.on("data", (chunk) => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          const parsedBody = body ? JSON.parse(body) : undefined;

          await transport.handlePostMessage(req, res, parsedBody);
        } catch (error) {
          console.error("MCP message error:", error);

          if (!res.headersSent) {
            res.writeHead(500);
            res.end("Internal server error");
          }
        }
      });

      return;
    }

    res.writeHead(404);
    res.end("Not found");
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
    `JnarPro IO Opportunity Intelligence listening on port ${port}`
  );
});
