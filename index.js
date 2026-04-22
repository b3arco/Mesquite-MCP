import "dotenv/config";
import express from "express";
import cors from "cors";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import pg from "pg";
import * as z from "zod";

const app = createMcpExpressApp({ host: "0.0.0.0" });
const port = Number(process.env.PORT) || 3000;
const { Pool } = pg;

app.use(cors());
app.use(express.json());

let pool;
let schemaReady;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL in server environment.");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false }
    });
  }

  return pool;
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = await getPool().connect();

      try {
        await client.query(`
          create table if not exists leads (
            id uuid primary key,
            name text,
            company text,
            email text,
            phone text,
            website text,
            source text,
            service text,
            status text not null default 'new',
            tags text[] not null default '{}',
            notes text,
            metadata jsonb not null default '{}'::jsonb,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
          );
        `);

        await client.query(`
          create table if not exists lead_events (
            id uuid primary key,
            lead_id uuid not null references leads(id) on delete cascade,
            event_type text not null,
            body text,
            metadata jsonb not null default '{}'::jsonb,
            created_at timestamptz not null default now()
          );
        `);

        await client.query(`
          create table if not exists followup_tasks (
            id uuid primary key,
            lead_id uuid not null references leads(id) on delete cascade,
            title text not null,
            status text not null default 'open',
            channel text,
            due_at timestamptz,
            details text,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
          );
        `);
      } finally {
        client.release();
      }
    })();
  }

  return schemaReady;
}

async function withSchema(callback) {
  try {
    await ensureSchema();
    return await callback();
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error)
        }
      ],
      isError: true
    };
  }
}

const server = new McpServer(
  {
    name: "mesquite-mcp",
    version: "1.0.0"
  },
  {
    instructions:
      "Use scrape_leads to run an Apify actor that collects leads from a website or search source. Use save_lead, list_leads, update_lead_status, and create_followup_task to manage a lightweight CRM pipeline. Use send_sms to draft or send follow-up text messages when phone and message are provided."
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
  "save_lead",
  {
    title: "Save Lead",
    description: "Save a lead into the CRM database.",
    inputSchema: z.object({
      name: z.string().optional(),
      company: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      website: z.string().optional(),
      source: z.string().optional(),
      service: z.string().optional(),
      status: z.string().default("new"),
      tags: z.array(z.string()).default([]),
      notes: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).default({})
    })
  },
  async (input) =>
    withSchema(async () => {
      const id = crypto.randomUUID();
      const eventId = crypto.randomUUID();

      await getPool().query(
        `
          insert into leads (
            id, name, company, email, phone, website, source, service, status, tags, notes, metadata
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
          )
        `,
        [
          id,
          input.name ?? null,
          input.company ?? null,
          input.email ?? null,
          input.phone ?? null,
          input.website ?? null,
          input.source ?? null,
          input.service ?? null,
          input.status,
          input.tags,
          input.notes ?? null,
          JSON.stringify(input.metadata)
        ]
      );

      await getPool().query(
        `
          insert into lead_events (id, lead_id, event_type, body, metadata)
          values ($1, $2, 'lead_created', $3, $4::jsonb)
        `,
        [eventId, id, input.notes ?? "Lead saved", JSON.stringify({ source: input.source ?? null })]
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, leadId: id, status: input.status }, null, 2)
          }
        ]
      };
    })
);

server.registerTool(
  "list_leads",
  {
    title: "List Leads",
    description: "List leads from the CRM database with optional filters.",
    inputSchema: z.object({
      status: z.string().optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(25)
    })
  },
  async ({ status, search, limit }) =>
    withSchema(async () => {
      const params = [];
      const clauses = [];

      if (status) {
        params.push(status);
        clauses.push(`status = $${params.length}`);
      }

      if (search) {
        params.push(`%${search}%`);
        clauses.push(
          `(coalesce(name, '') ilike $${params.length} or coalesce(company, '') ilike $${params.length} or coalesce(email, '') ilike $${params.length} or coalesce(phone, '') ilike $${params.length})`
        );
      }

      params.push(limit);

      const whereClause = clauses.length ? `where ${clauses.join(" and ")}` : "";
      const { rows } = await getPool().query(
        `
          select id, name, company, email, phone, website, source, service, status, tags, notes, created_at, updated_at
          from leads
          ${whereClause}
          order by updated_at desc
          limit $${params.length}
        `,
        params
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: rows.length, leads: rows }, null, 2)
          }
        ]
      };
    })
);

server.registerTool(
  "update_lead_status",
  {
    title: "Update Lead Status",
    description: "Update a lead's pipeline status and optionally add an event note.",
    inputSchema: z.object({
      leadId: z.string().uuid(),
      status: z.string().min(1),
      note: z.string().optional()
    })
  },
  async ({ leadId, status, note }) =>
    withSchema(async () => {
      const updateResult = await getPool().query(
        `
          update leads
          set status = $2, updated_at = now()
          where id = $1
          returning id, status, updated_at
        `,
        [leadId, status]
      );

      if (!updateResult.rowCount) {
        return {
          content: [{ type: "text", text: `Lead not found: ${leadId}` }],
          isError: true
        };
      }

      await getPool().query(
        `
          insert into lead_events (id, lead_id, event_type, body, metadata)
          values ($1, $2, 'status_updated', $3, $4::jsonb)
        `,
        [
          crypto.randomUUID(),
          leadId,
          note ?? `Lead moved to ${status}`,
          JSON.stringify({ status })
        ]
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(updateResult.rows[0], null, 2)
          }
        ]
      };
    })
);

server.registerTool(
  "create_followup_task",
  {
    title: "Create Follow-up Task",
    description: "Create a follow-up task for a lead.",
    inputSchema: z.object({
      leadId: z.string().uuid(),
      title: z.string().min(1),
      channel: z.string().optional(),
      dueAt: z.string().optional(),
      details: z.string().optional()
    })
  },
  async ({ leadId, title, channel, dueAt, details }) =>
    withSchema(async () => {
      const leadCheck = await getPool().query(`select id from leads where id = $1`, [leadId]);

      if (!leadCheck.rowCount) {
        return {
          content: [{ type: "text", text: `Lead not found: ${leadId}` }],
          isError: true
        };
      }

      const taskId = crypto.randomUUID();
      const { rows } = await getPool().query(
        `
          insert into followup_tasks (id, lead_id, title, channel, due_at, details)
          values ($1, $2, $3, $4, $5, $6)
          returning id, lead_id as "leadId", title, status, channel, due_at as "dueAt", details, created_at as "createdAt"
        `,
        [taskId, leadId, title, channel ?? null, dueAt ?? null, details ?? null]
      );

      await getPool().query(
        `
          insert into lead_events (id, lead_id, event_type, body, metadata)
          values ($1, $2, 'followup_created', $3, $4::jsonb)
        `,
        [
          crypto.randomUUID(),
          leadId,
          title,
          JSON.stringify({ channel: channel ?? null, dueAt: dueAt ?? null })
        ]
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(rows[0], null, 2)
          }
        ]
      };
    })
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
        name: "save_lead",
        description: "Save a lead into the CRM database."
      },
      {
        name: "list_leads",
        description: "List leads from the CRM database with optional filters."
      },
      {
        name: "update_lead_status",
        description: "Update a lead's pipeline status."
      },
      {
        name: "create_followup_task",
        description: "Create a follow-up task for a lead."
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
