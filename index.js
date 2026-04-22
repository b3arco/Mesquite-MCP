import "dotenv/config";
import crypto from "node:crypto";
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
const leadStatuses = ["new", "qualified", "contacted", "follow_up", "won", "lost"];

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

function normalizeLeadStatus(status) {
  return leadStatuses.includes(status) ? status : "new";
}

async function sendTwilioSms({ phone, message }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    throw new Error(
      "Missing Twilio configuration. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER."
    );
  }

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const body = new URLSearchParams({
    To: phone,
    From: fromNumber,
    Body: message
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Twilio rejected the SMS request with HTTP ${response.status}: ${errorText}`);
  }

  const result = await response.json();

  return {
    sid: result.sid,
    status: result.status,
    to: result.to,
    from: result.from
  };
}

async function runApifyActor({ actorId, runInput, limit }) {
  if (!process.env.APIFY_API_TOKEN) {
    throw new Error("Missing APIFY_API_TOKEN in server environment.");
  }

  const resolvedActorId = actorId || process.env.APIFY_LEAD_SCRAPER_ACTOR_ID;

  if (!resolvedActorId) {
    throw new Error(
      "Missing actorId. Provide actorId in the request or set APIFY_LEAD_SCRAPER_ACTOR_ID in the server environment."
    );
  }

  const url = new URL(
    `https://api.apify.com/v2/acts/${encodeURIComponent(resolvedActorId)}/run-sync-get-dataset-items`
  );

  if (limit) {
    url.searchParams.set("limit", String(limit));
  }

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
    throw new Error(`Apify rejected the scrape request with HTTP ${apifyResponse.status}: ${errorText}`);
  }

  const items = await apifyResponse.json();

  return {
    actorId: resolvedActorId,
    count: Array.isArray(items) ? items.length : 0,
    items
  };
}

async function createLead(input) {
  const id = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const status = normalizeLeadStatus(input.status ?? "new");

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
      status,
      input.tags ?? [],
      input.notes ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );

  await getPool().query(
    `
      insert into lead_events (id, lead_id, event_type, body, metadata)
      values ($1, $2, 'lead_created', $3, $4::jsonb)
    `,
    [eventId, id, input.notes ?? "Lead saved", JSON.stringify({ source: input.source ?? null })]
  );

  return { success: true, leadId: id, status };
}

async function updateLead(leadId, input) {
  const status = normalizeLeadStatus(input.status ?? "new");
  const updateResult = await getPool().query(
    `
      update leads
      set name = $2,
          company = $3,
          email = $4,
          phone = $5,
          website = $6,
          source = $7,
          service = $8,
          status = $9,
          tags = $10,
          notes = $11,
          metadata = $12::jsonb,
          updated_at = now()
      where id = $1
      returning id, name, company, email, phone, website, source, service, status, tags, notes, metadata, updated_at
    `,
    [
      leadId,
      input.name ?? null,
      input.company ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.website ?? null,
      input.source ?? null,
      input.service ?? null,
      status,
      input.tags ?? [],
      input.notes ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );

  if (!updateResult.rowCount) {
    throw new Error(`Lead not found: ${leadId}`);
  }

  await getPool().query(
    `
      insert into lead_events (id, lead_id, event_type, body, metadata)
      values ($1, $2, 'lead_updated', $3, $4::jsonb)
    `,
    [
      crypto.randomUUID(),
      leadId,
      input.notes ?? "Lead updated",
      JSON.stringify({ status })
    ]
  );

  return updateResult.rows[0];
}

async function deleteLead(leadId) {
  const deleteResult = await getPool().query(`delete from leads where id = $1 returning id`, [leadId]);

  if (!deleteResult.rowCount) {
    throw new Error(`Lead not found: ${leadId}`);
  }

  return { success: true, leadId };
}

async function fetchLeads({ status, search, limit = 25 }) {
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
      select id, name, company, email, phone, website, source, service, status, tags, notes, metadata, created_at, updated_at
      from leads
      ${whereClause}
      order by updated_at desc
      limit $${params.length}
    `,
    params
  );

  return { count: rows.length, leads: rows };
}

async function changeLeadStatus({ leadId, status, note }) {
  const normalizedStatus = normalizeLeadStatus(status);
  const updateResult = await getPool().query(
    `
      update leads
      set status = $2, updated_at = now()
      where id = $1
      returning id, status, updated_at
    `,
    [leadId, normalizedStatus]
  );

  if (!updateResult.rowCount) {
    throw new Error(`Lead not found: ${leadId}`);
  }

  await getPool().query(
    `
      insert into lead_events (id, lead_id, event_type, body, metadata)
      values ($1, $2, 'status_updated', $3, $4::jsonb)
    `,
    [
      crypto.randomUUID(),
      leadId,
      note ?? `Lead moved to ${normalizedStatus}`,
      JSON.stringify({ status: normalizedStatus })
    ]
  );

  return updateResult.rows[0];
}

async function createFollowupTask({ leadId, title, channel, dueAt, details }) {
  const leadCheck = await getPool().query(`select id from leads where id = $1`, [leadId]);

  if (!leadCheck.rowCount) {
    throw new Error(`Lead not found: ${leadId}`);
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

  return rows[0];
}

async function fetchDashboardData() {
  const [{ rows: leads }, { rows: tasks }, { rows: counts }, { rows: recentEvents }] = await Promise.all([
    getPool().query(
      `
        select id, name, company, email, phone, website, source, service, status, tags, notes, created_at, updated_at
        from leads
        order by updated_at desc
        limit 100
      `
    ),
    getPool().query(
      `
        select t.id, t.lead_id as "leadId", t.title, t.status, t.channel, t.due_at as "dueAt", t.details,
               l.name as "leadName", l.company as "leadCompany"
        from followup_tasks t
        join leads l on l.id = t.lead_id
        order by coalesce(t.due_at, t.created_at) asc
        limit 100
      `
    ),
    getPool().query(
      `
        select status, count(*)::int as count
        from leads
        group by status
      `
    ),
    getPool().query(
      `
        select e.id, e.lead_id as "leadId", e.event_type as "eventType", e.body, e.created_at as "createdAt",
               l.name as "leadName", l.company as "leadCompany"
        from lead_events e
        join leads l on l.id = e.lead_id
        order by e.created_at desc
        limit 20
      `
    )
  ]);

  return {
    leads,
    tasks,
    counts: leadStatuses.map((status) => ({
      status,
      count: counts.find((row) => row.status === status)?.count ?? 0
    })),
    recentEvents,
    statuses: leadStatuses
  };
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
    try {
      const result = await runApifyActor({ actorId, runInput, limit });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
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
    withSchema(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await createLead(input), null, 2)
        }
      ]
    }))
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
    withSchema(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await fetchLeads({ status, search, limit }), null, 2)
        }
      ]
    }))
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
    withSchema(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await changeLeadStatus({ leadId, status, note }), null, 2)
        }
      ]
    }))
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
    withSchema(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await createFollowupTask({ leadId, title, channel, dueAt, details }),
            null,
            2
          )
        }
      ]
    }))
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
  async ({ phone, message }) => {
    try {
      const result = await sendTwilioSms({ phone, message });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
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
);

app.get("/", (req, res) => {
  res.json({
    name: "mesquite-mcp",
    status: "ok",
    endpoints: [
      "/.well-known/mcp",
      "/api/health",
      "/api/leads",
      "/api/tasks",
      "/api/scrape",
      "/api/sms",
      "/mcp"
    ],
    connector_url: `${req.protocol}://${req.get("host")}/mcp`,
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

app.get("/api/health", async (req, res) => {
  try {
    await ensureSchema();

    res.json({
      name: "mesquite-mcp-crm",
      status: "ok",
      endpoints: ["/api/dashboard", "/api/leads", "/api/tasks", "/api/scrape", "/mcp"],
      connector_url: "/mcp",
      transport: "streamable-http"
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    await ensureSchema();
    res.json(await fetchDashboardData());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/api/leads", async (req, res) => {
  try {
    await ensureSchema();
    res.json(
      await fetchLeads({
        status: typeof req.query.status === "string" ? req.query.status : undefined,
        search: typeof req.query.search === "string" ? req.query.search : undefined,
        limit: typeof req.query.limit === "string" ? Number(req.query.limit) : 50
      })
    );
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.post("/api/leads", async (req, res) => {
  try {
    await ensureSchema();
    res.status(201).json(await createLead(req.body ?? {}));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.put("/api/leads/:leadId", async (req, res) => {
  try {
    await ensureSchema();
    res.json(await updateLead(req.params.leadId, req.body ?? {}));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(message.startsWith("Lead not found") ? 404 : 500).json({ error: message });
  }
});

app.patch("/api/leads/:leadId/status", async (req, res) => {
  try {
    await ensureSchema();
    res.json(
      await changeLeadStatus({
        leadId: req.params.leadId,
        status: req.body?.status,
        note: req.body?.note
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(message.startsWith("Lead not found") ? 404 : 500).json({ error: message });
  }
});

app.delete("/api/leads/:leadId", async (req, res) => {
  try {
    await ensureSchema();
    res.json(await deleteLead(req.params.leadId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(message.startsWith("Lead not found") ? 404 : 500).json({ error: message });
  }
});

app.post("/api/sms", async (req, res) => {
  try {
    const result = await sendTwilioSms({
      phone: req.body?.phone,
      message: req.body?.message
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.post("/api/tasks", async (req, res) => {
  try {
    await ensureSchema();
    res.status(201).json(await createFollowupTask(req.body ?? {}));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(message.startsWith("Lead not found") ? 404 : 500).json({ error: message });
  }
});

app.post("/api/scrape", async (req, res) => {
  try {
    res.json(await runApifyActor(req.body ?? {}));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
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
