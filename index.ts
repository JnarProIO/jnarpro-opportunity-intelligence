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

function scoreOpportunity(opportunity: Opportunity) {
  let score = 0;

  if (opportunity.recurringRevenue) score += 25;
  if (opportunity.zeroUpfrontCost) score += 20;
  if (opportunity.automationReady) score += 20;
  if (opportunity.legitimateAcquisition) score += 20;
  if (opportunity.scalable) score += 10;

  score += Math.min(opportunity.commissionRate / 20, 5);

  return Math.round(score);
}
function qualifyOpportunity(opportunity: Opportunity) {
  const validated = OpportunitySchema.parse(opportunity);
  const score = scoreOpportunity(validated);

  const qualified =
    validated.recurringRevenue &&
    validated.zeroUpfrontCost &&
    validated.automationReady &&
    validated.legitimateAcquisition &&
    validated.scalable &&
    score >= 80;

  return {
    ...validated,
    score,
    tier: qualified ? "TIER_1" : score >= 60 ? "TIER_2" : "TIER_3",
    qualified,
  };
}
function createServer() {
  const server = new McpServer({
    name: "JnarPro IO Opportunity Intelligence",
    version: "1.0.0",
  });

  server.tool(
    "score_opportunity",
    "Score an online revenue opportunity for JnarPro IO.",
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
      const result = qualifyOpportunity(input);

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

  return server;
}
  server.tool(
    "system_status",
    "Return the current status and qualification rules for JnarPro IO.",
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

const transports = new Map<string, SSEServerTransport>();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/sse") {
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);

    res.on("close", () => {
      transports.delete(transport.sessionId);
    });

    const server = createServer();
    await server.connect(transport);
    return;
  }

  if (req.method === "POST" && url.pathname === "/messages") {
    const sessionId = url.searchParams.get("sessionId");
    const transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      res.writeHead(404);
      res.end("Unknown session");
      return;
    }

    await transport.handlePostMessage(req, res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const port = Number(process.env.PORT ?? 3000);

httpServer.listen(port, "0.0.0.0", () => {
  console.error(`JnarPro IO Opportunity Intelligence running on port ${port}`);
});
