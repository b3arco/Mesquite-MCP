import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    name: "mesquite-mcp",
    status: "ok",
    endpoints: ["/.well-known/mcp", "/mcp"]
  });
});

app.get("/.well-known/mcp", (req, res) => {
  res.json({
    tools: [
      {
        name: "capture_lead",
        description: "Capture a new business lead",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            phone: { type: "string" },
            service: { type: "string" }
          },
          required: ["name", "phone"]
        }
      },
      {
        name: "send_sms",
        description: "Send SMS to a lead",
        input_schema: {
          type: "object",
          properties: {
            phone: { type: "string" },
            message: { type: "string" }
          }
        }
      }
    ]
  });
});

app.post("/mcp", async (req, res) => {
  const { tool, input } = req.body;

  if (tool === "capture_lead") {
    return res.json({
      success: true,
      message: "Lead captured",
      data: input
    });
  }

  if (tool === "send_sms") {
    return res.json({
      success: true,
      message: "SMS sent (mock)"
    });
  }

  return res.status(400).json({ error: "Unknown tool" });
});

app.listen(port, () => {
  console.log(`MCP server running on port ${port}`);
});
