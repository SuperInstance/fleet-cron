interface CronJob {
  id: string;
  name: string;
  schedule: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  enabled: boolean;
  lastRun?: number;
  nextRun: number;
  createdAt: number;
  failureCount: number;
  alertEmail?: string;
}

interface ExecutionHistory {
  id: string;
  jobId: string;
  timestamp: number;
  status: number;
  responseTime: number;
  success: boolean;
  error?: string;
}

interface ScheduleRequest {
  name: string;
  schedule: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  alertEmail?: string;
}

const KV_JOBS = "fleet_cron_jobs";
const KV_HISTORY = "fleet_cron_history";
const KV_LAST_RUN = "fleet_cron_last_run";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:;",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

function parseCron(schedule: string): number {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Invalid cron format. Expected 5 fields: minute hour day month weekday");
  }

  const [minute, hour, day, month, weekday] = parts;
  const now = new Date();
  const next = new Date(now.getTime() + 60000);

  while (true) {
    if (month !== "*" && parseInt(month) !== next.getMonth() + 1) {
      next.setMonth(next.getMonth() + 1);
      next.setDate(1);
      next.setHours(0, 0, 0, 0);
      continue;
    }

    if (day !== "*" && parseInt(day) !== next.getDate()) {
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
      continue;
    }

    if (weekday !== "*" && parseInt(weekday) !== next.getDay()) {
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
      continue;
    }

    if (hour !== "*" && parseInt(hour) !== next.getHours()) {
      next.setHours(next.getHours() + 1);
      next.setMinutes(0, 0, 0);
      continue;
    }

    if (minute !== "*" && parseInt(minute) !== next.getMinutes()) {
      next.setMinutes(next.getMinutes() + 1);
      next.setSeconds(0, 0);
      continue;
    }

    break;
  }

  return next.getTime();
}

async function executeJob(job: CronJob, env: Env): Promise<void> {
  const startTime = Date.now();
  const historyEntry: ExecutionHistory = {
    id: crypto.randomUUID(),
    jobId: job.id,
    timestamp: startTime,
    status: 0,
    responseTime: 0,
    success: false,
  };

  try {
    const response = await fetch(job.url, {
      method: job.method,
      headers: job.headers,
      body: job.body,
    });

    const responseTime = Date.now() - startTime;
    historyEntry.responseTime = responseTime;
    historyEntry.status = response.status;
    historyEntry.success = response.ok;

    if (!response.ok) {
      historyEntry.error = `HTTP ${response.status}`;
      job.failureCount++;

      if (job.alertEmail && job.failureCount >= 3) {
        await sendAlert(job, `Job "${job.name}" failed ${job.failureCount} times`, env);
      }
    } else {
      job.failureCount = 0;
    }
  } catch (error) {
    historyEntry.responseTime = Date.now() - startTime;
    historyEntry.error = error instanceof Error ? error.message : "Unknown error";
    job.failureCount++;

    if (job.alertEmail && job.failureCount >= 3) {
      await sendAlert(job, `Job "${job.name}" failed with error: ${historyEntry.error}`, env);
    }
  }

  job.lastRun = startTime;
  job.nextRun = parseCron(job.schedule);

  await env.FLEET_CRON.put(`${KV_JOBS}:${job.id}`, JSON.stringify(job));
  
  const historyKey = `${KV_HISTORY}:${job.id}:${historyEntry.id}`;
  await env.FLEET_CRON.put(historyKey, JSON.stringify(historyEntry));

  const historyList = await env.FLEET_CRON.get(`${KV_HISTORY}:${job.id}`, "json") as string[] || [];
  historyList.unshift(historyEntry.id);
  if (historyList.length > 100) historyList.pop();
  await env.FLEET_CRON.put(`${KV_HISTORY}:${job.id}`, JSON.stringify(historyList));
}

async function sendAlert(job: CronJob, message: string, env: Env): Promise<void> {
  if (!job.alertEmail) return;

  try {
    await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: job.alertEmail }] }],
        from: { email: "alerts@fleet-cron.com", name: "Fleet Cron" },
        subject: `Alert: ${job.name}`,
        content: [{ type: "text/plain", value: message }],
      }),
    });
  } catch (error) {
    console.error("Failed to send alert:", error);
  }
}

async function handleSchedule(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  try {
    const data: ScheduleRequest = await request.json();
    
    if (!data.name || !data.schedule || !data.url) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    const nextRun = parseCron(data.schedule);
    const job: CronJob = {
      id: crypto.randomUUID(),
      name: data.name,
      schedule: data.schedule,
      url: data.url,
      method: data.method || "GET",
      headers: data.headers || {},
      body: data.body,
      enabled: true,
      nextRun,
      createdAt: Date.now(),
      failureCount: 0,
      alertEmail: data.alertEmail,
    };

    await env.FLEET_CRON.put(`${KV_JOBS}:${job.id}`, JSON.stringify(job));

    return new Response(JSON.stringify({ id: job.id, nextRun: new Date(nextRun).toISOString() }), {
      status: 201,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : "Invalid request" 
    }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
}

async function handleJobs(request: Request, env: Env): Promise<Response> {
  const jobs: CronJob[] = [];
  const list = await env.FLEET_CRON.list({ prefix: `${KV_JOBS}:` });

  for (const key of list.keys) {
    const job = await env.FLEET_CRON.get(key.name, "json") as CronJob;
    if (job) jobs.push(job);
  }

  return new Response(JSON.stringify(jobs), {
    headers: { 
      "Content-Type": "application/json", 
      ...CORS_HEADERS,
      ...SECURITY_HEADERS,
    },
  });
}

async function handleHistory(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");
  const limit = parseInt(url.searchParams.get("limit") || "50");

  if (!jobId) {
    return new Response(JSON.stringify({ error: "Missing jobId parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const historyList = await env.FLEET_CRON.get(`${KV_HISTORY}:${jobId}`, "json") as string[] || [];
  const limitedList = historyList.slice(0, limit);
  const history: ExecutionHistory[] = [];

  for (const id of limitedList) {
    const entry = await env.FLEET_CRON.get(`${KV_HISTORY}:${jobId}:${id}`, "json") as ExecutionHistory;
    if (entry) history.push(entry);
  }

  return new Response(JSON.stringify(history), {
    headers: { 
      "Content-Type": "application/json", 
      ...CORS_HEADERS,
      ...SECURITY_HEADERS,
    },
  });
}

function handleHealth(): Response {
  return new Response(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }), {
    headers: { 
      "Content-Type": "application/json",
      ...SECURITY_HEADERS,
    },
  });
}

function handleHome(): Response {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fleet Cron - Cron Job Scheduler</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --dark: #0a0a0f;
            --accent: #059669;
            --light: #f8fafc;
            --gray: #64748b;
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Inter', sans-serif;
            background-color: var(--dark);
            color: var(--light);
            line-height: 1.6;
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        
        header {
            text-align: center;
            padding: 3rem 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            margin-bottom: 3rem;
        }
        
        .logo {
            font-size: 2.5rem;
            font-weight: 700;
            color: var(--accent);
            margin-bottom: 1rem;
            letter-spacing: -0.5px;
        }
        
        .tagline {
            font-size: 1.2rem;
            color: var(--gray);
            font-weight: 300;
        }
        
        .features {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 2rem;
            margin-bottom: 4rem;
        }
        
        .feature-card {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 12px;
            padding: 2rem;
            border: 1px solid rgba(255, 255, 255, 0.1);
            transition: transform 0.3s ease, border-color 0.3s ease;
        }
        
        .feature-card:hover {
            transform: translateY(-5px);
            border-color: var(--accent);
        }
        
        .feature-icon {
            font-size: 2rem;
            margin-bottom: 1rem;
            color: var(--accent);
        }
        
        .feature-title {
            font-size: 1.3rem;
            font-weight: 600;
            margin-bottom: 0.8rem;
            color: var(--light);
        }
        
        .feature-desc {
            color: var(--gray);
            font-size: 0.95rem;
        }
        
        .endpoints {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 12px;
            padding: 2rem;
            margin-bottom: 4rem;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .endpoints h2 {
            color: var(--accent);
            margin-bottom: 1.5rem;
            font-size: 1.8rem;
        }
        
        .endpoint {
            background: rgba(0, 0, 0, 0.3);
            border-radius: 8px;
            padding: 1.5rem;
            margin-bottom: 1rem;
            border-left: 4px solid var(--accent);
        }
        
        .method {
            display: inline-block;
            padding: 0.3rem 0.8rem;
            background: var(--accent);
            color: white;
            border-radius: 4px;
            font-weight: 600;
            font-size: 0.9rem;
            margin-right: 1rem;
        }
        
        .path {
            font-family: 'Monaco', 'Courier New', monospace;
            color: var(--light);
            font-weight: 500;
        }
        
        .desc {
            color: var(--gray);
            margin-top: 0.8rem;
            font-size: 0.95rem;
        }
        
        footer {
            text-align: center;
            padding: 2rem 0;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            color: var(--gray);
            font-size: 0.9rem;
        }
        
        .footer-logo {
            color: var(--accent);
            font-weight: 600;
            margin-bottom: 0.5rem;
        }
        
        @media (max-width: 768px) {
            .features {
                grid-template-columns: 1fr;
            }
            
            header {
                padding: 2rem 0;
            }
            
            .logo {
                font-size: 2rem;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="logo">Fleet Cron</div>
            <div class="tagline">Reliable Cron Job Scheduler for Cloudflare Workers</div>
        </header>
        
        <div class="features">
            <div class="feature-card">
                <div class="feature-icon">⏰</div>
                <div class="feature-title">Cron Parser</div>
                <div class="feature-desc">Advanced cron expression parser supporting standard 5-field format with intelligent scheduling.</div>
            </div>
            
            <div class="feature-card">
                <div class="feature-icon">🏥</div>
                <div class="feature-title">Health Checks</div>
                <div class="feature-desc">Scheduled health checks with configurable intervals and failure detection.</div>
            </div>
            
            <div class="feature-card">
                <div class="feature-icon">🔄</div>
                <div class="feature-title">Batch Jobs</div>
                <div class="feature-desc">Recurring batch job execution with configurable payloads and headers.</div>
            </div>
            
            <div class="feature-card">
                <div class="feature-icon">🚨</div>
                <div class="feature-title">Failure Alerts</div>
                <div class="feature-desc">Email alerts for job failures with configurable thresholds and notification rules.</div>
            </div>
            
            <div class="feature-card">
                <div class="feature-icon">📊</div>
                <div class="feature-title">Execution History</div>
                <div class="feature-desc">Detailed execution history with response times, status codes, and error tracking.</div>
            </div>
            
            <div class="feature-card">
                <div class="feature-icon">🔒</div>
                <div class="feature-title">Secure & Reliable</div>
                <div class="feature-desc">Built with security headers, CSP, and zero dependencies for maximum reliability.</div>
            </div>
        </div>
        
        <div class="endpoints">
            <h2>API Endpoints</h2>
            
            <div class="endpoint">
                <span class="method">POST</span>
                <span class="path">/api/schedule</span>
                <div class="desc">Schedule a new cron job. Requires name, schedule (cron expression), and URL.</div>
            </div>
            
            <div class="endpoint">
                <span class="method">GET</span>
                <span class="path">/api/jobs</span>
                <div class="desc">Retrieve all scheduled jobs with their current status and next execution time.</div>
            </div>
            
            <div class="endpoint">
                <span class="method">GET</span>
                <span class="path">/api/history?jobId=UUID&limit=50</span>
                <div class="desc">Get execution history for a specific job. Optional limit parameter (default: 50).</div>
            </div>
            
            <div class="endpoint">
                <span class="method">GET</span>
                <span class="path">/health</span>
                <div class="desc">Health check endpoint. Returns status and timestamp.</div>
            </div>
        </div>
        
        <footer>
            <div class="footer-logo">Fleet Cron</div>
            <div>Reliable cron job scheduling for Cloudflare Workers</div>
            <div style="margin-top: 0.5rem; font-size: 0.8rem;">Zero dependencies • TypeScript • Secure by design</div>
        </footer>
    </div>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html",
      ...SECURITY_HEADERS,
    },
  });
}

async function scheduledHandler(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  const now = Date.now();
  const lastRunKey = `${KV_LAST_RUN}:${Math.floor(now / 60000)}`;
  
  const lastRun = await env.FLEET_CRON.get(lastRunKey);
  if (lastRun) return;
  
  await env.FLEET_CRON.put(lastRunKey, "1", { expirationTtl: 120 });
  
  const jobs: CronJob[] = [];
  const list = await env.FLEET_CRON.list({ prefix: `${KV_JOBS}:` });
  
  for (const key of list.keys) {
    const job = await env.FLEET_CRON.get(key.name, "json") as CronJob;
    if (job && job.enabled && job.nextRun <= now) {
      jobs.push(job);
    }
  }
  
  for (const job of jobs) {
    ctx.waitUntil(executeJob(job, env));
  }
}

interface Env {
  FLEET_CRON: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    switch (url.pathname) {
      case "/api/schedule":
        return handleSchedule(request, env);
      case "/api/jobs":
        return handleJobs(request, env);
      case "/api/history":
        return handleHistory(request, env);
      case "/health":
        return handleHealth();
      case "/":
        return handleHome();
      default:
        return new Response("Not Found", { status: 404 });
    }
  },
  
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await scheduledHandler(controller, env, ctx);
  },
};