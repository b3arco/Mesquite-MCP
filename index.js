import "dotenv/config";
import express from "express";
import cors from "cors";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

const app = createMcpExpressApp({ host: "0.0.0.0" });
const port = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

const server = new McpServer(
  {
    name: "mesquite-mcp",
    version: "1.0.0"
  },
  {
    instructions:
      "Use scrape_leads to run an Apify actor that collects leads from a website or search source. Use send_sms to draft or send follow-up text messages when phone and message are provided."
  }
);

server.registerTool(
  "scrape_leads",
  {
    title: "Scrape Leads",
    description: "Run an Apify actor to scrape leads and return dataset items.",
    inputSchema: z.object({
      actorId: z.string().min(1).optional(),
      runInput: z.record(z.string(), z.unknown()).default({}),
      limit: z.number().int().min(1).max(100).optional()
    })
  },
  async ({ actorId, runInput, limit }) => {
    if (!process.env.APIFY_API_TOKEN) {
      return {
        content: [{ type: "text", text: "Missing APIFY_API_TOKEN in server environment." }],
        isError: true
      };
    }

    const resolvedActorId = actorId || process.env.APIFY_LEAD_SCRAPER_ACTOR_ID;

    if (!resolvedActorId) {
      return {
        content: [
          {
            type: "text",
            text: "Missing actorId. Provide actorId in the tool call or set APIFY_LEAD_SCRAPER_ACTOR_ID in the server environment."
          }
        ],
        isError: true
      };
    }

    const url = new URL(
      `https://api.apify.com/v2/acts/${encodeURIComponent(resolvedActorId)}/run-sync-get-dataset-items`
    );

    if (limit) {
      url.searchParams.set("limit", String(limit));
    }

    try {
      const apifyResponse = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.APIFY_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(runInput ?? {})
      });

      if (!apifyResponse.ok) {
        const errorText = await apifyResponse.text();

        return {
          content: [
            {
              type: "text",
              text: `Apify rejected the scrape request with HTTP ${apifyResponse.status}: ${errorText}`
            }
          ],
          isError: true
        };
      }

      const items = await apifyResponse.json();
      const count = Array.isArray(items) ? items.length : 0;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                actorId: resolvedActorId,
                count,
                items
              },
              null,
              2
            )
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to reach Apify: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      };
    }
  }
);

server.registerTool(
  "send_sms",
  {
    title: "Send SMS",
    description: "Send an SMS follow-up to a lead.",
    inputSchema: z.object({
      phone: z.string().min(1),
      message: z.string().min(1)
    })
  },
  async ({ phone, message }) => ({
    content: [
      {
        type: "text",
        text: `Mock SMS sent to ${phone}: ${message}`
      }
    ]
  })
);

app.get("/", (req, res) => {
  res.json({
    name: "mesquite-mcp",
    status: "ok",
    endpoints: ["/.well-known/mcp", "/mcp"],
    connector_url: "/mcp",
    transport: "streamable-http"
  });
});

app.get("/.well-known/mcp", (req, res) => {
  res.json({
    name: "mesquite-mcp",
    version: "1.0.0",
    connector_url: `${req.protocol}://${req.get("host")}/mcp`,
    transport: "streamable-http",
    tools: [
      {
        name: "scrape_leads",
        description: "Run an Apify actor to scrape leads and return dataset items."
      },
      {
        name: "send_sms",
        description: "Send SMS to a lead."
      }
    ]
  });
});

app.post("/mcp", async (req, res) => {
  try {
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    res.status(500).json({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal server error"
      },
      id: null
    });
  }
});

app.listen(port, () => {
  console.log(`Mesquite MCP server running on port ${port}`);
});
