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
      "Use capture_lead to save new leads in GoHighLevel. Use send_sms to send follow-up text messages when phone and message are provided."
  }
);

server.registerTool(
  "capture_lead",
  {
    title: "Capture Lead",
    description: "Capture a new business lead in GoHighLevel.",
    inputSchema: z.object({
      name: z.string().min(1),
      phone: z.string().min(1),
      service: z.string().optional()
    })
  },
  async ({ name, phone, service }) => {
    if (!process.env.GHL_API_KEY) {
      return {
        content: [{ type: "text", text: "Missing GHL_API_KEY in server environment." }],
        isError: true
      };
    }

    try {
      const ghlResponse = await fetch("https://rest.gohighlevel.com/v1/contacts/", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GHL_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name,
          phone
        })
      });

      if (!ghlResponse.ok) {
        const errorText = await ghlResponse.text();

        return {
          content: [
            {
              type: "text",
              text: `GoHighLevel rejected the lead capture request with HTTP ${ghlResponse.status}: ${errorText}`
            }
          ],
          isError: true
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Lead captured for ${name} (${phone})${service ? ` for service "${service}"` : ""}.`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to reach GoHighLevel: ${error instanceof Error ? error.message : String(error)}`
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
        name: "capture_lead",
        description: "Capture a new business lead in GoHighLevel."
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
