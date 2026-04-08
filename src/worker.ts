interface ScheduledJob {
  id: string;
  name: string;
  cronExpression: string;
  endpoint: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  lastRun?: string;
  nextRun: string;
  enabled: boolean;
  failureCount: number;
  createdAt: string;
}

interface ExecutionHistory {
  id: string;
  jobId: string;
  jobName: string;
  timestamp: string;
  status: 'success' | 'failure';
  response?: string;
  duration: number;
}

interface ScheduleRequest {
  name: string;
  cronExpression: string;
  endpoint: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const STORAGE_KEYS = {
  JOBS: 'fleet_cron_jobs',
  HISTORY: 'fleet_cron_history',
  CONFIG: 'fleet_cron_config'
};

const DEFAULT_CONFIG = {
  maxHistory: 1000,
  alertThreshold: 3,
  healthCheckEndpoint: '/health'
};

class CronParser {
  static validate(expression: string): boolean {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    
    const validatePart = (part: string, min: number, max: number): boolean => {
      if (part === '*') return true;
      
      const ranges = part.split(',');
      for (const range of ranges) {
        if (range.includes('-')) {
          const [start, end] = range.split('-').map(Number);
          if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
            return false;
          }
        } else if (range.includes('/')) {
          const [value, step] = range.split('/').map(v => v === '*' ? v : Number(v));
          if (step === undefined || isNaN(step as number) || (step as number) < 1) {
            return false;
          }
        } else {
          const num = Number(range);
          if (isNaN(num) || num < min || num > max) {
            return false;
          }
        }
      }
      return true;
    };
    
    return validatePart(minute, 0, 59) &&
           validatePart(hour, 0, 23) &&
           validatePart(dayOfMonth, 1, 31) &&
           validatePart(month, 1, 12) &&
           validatePart(dayOfWeek, 0, 6);
  }

  static getNextRun(expression: string, fromDate: Date = new Date()): Date {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.split(/\s+/);
    
    const next = new Date(fromDate.getTime() + 60000);
    next.setSeconds(0, 0);
    
    while (true) {
      if (!this.matchesField(month, next.getMonth() + 1)) {
        next.setMonth(next.getMonth() + 1);
        next.setDate(1);
        next.setHours(0, 0, 0, 0);
        continue;
      }
      
      if (!this.matchesField(dayOfMonth, next.getDate()) || 
          !this.matchesField(dayOfWeek, next.getDay())) {
        next.setDate(next.getDate() + 1);
        next.setHours(0, 0, 0, 0);
        continue;
      }
      
      if (!this.matchesField(hour, next.getHours())) {
        next.setHours(next.getHours() + 1);
        next.setMinutes(0, 0, 0);
        continue;
      }
      
      if (!this.matchesField(minute, next.getMinutes())) {
        next.setMinutes(next.getMinutes() + 1);
        continue;
      }
      
      break;
    }
    
    return next;
  }

  private static matchesField(field: string, value: number): boolean {
    if (field === '*') return true;
    
    const parts = field.split(',');
    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number);
        if (value >= start && value <= end) return true;
      } else if (part.includes('/')) {
        const [range, stepStr] = part.split('/');
        const step = parseInt(stepStr);
        if (range === '*') {
          if (value % step === 0) return true;
        }
      } else if (parseInt(part) === value) {
        return true;
      }
    }
    return false;
  }
}

class FleetCron {
  private env: any;

  constructor(env: any) {
    this.env = env;
  }

  async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
      return new Response(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/') {
      return this.handleUI();
    }

    if (path === '/api/schedule' && request.method === 'POST') {
      return this.handleSchedule(request);
    }

    if (path === '/api/jobs' && request.method === 'GET') {
      return this.handleGetJobs();
    }

    if (path === '/api/history' && request.method === 'GET') {
      return this.handleGetHistory();
    }

    if (path.startsWith('/api/jobs/') && request.method === 'DELETE') {
      const id = path.split('/').pop();
      return id ? this.handleDeleteJob(id) : new Response('Not found', { status: 404 });
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleUI(): Promise<Response> {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fleet Cron - Scheduled Task Manager</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --dark: #0a0a0f;
            --darker: #050508;
            --accent: #059669;
            --accent-light: #10b981;
            --text: #e2e8f0;
            --text-secondary: #94a3b8;
            --border: #1e293b;
            --success: #10b981;
            --warning: #f59e0b;
            --danger: #ef4444;
            --card-bg: #111827;
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: var(--dark);
            color: var(--text);
            line-height: 1.6;
            min-height: 100vh;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 0 20px;
        }
        
        header {
            background: var(--darker);
            border-bottom: 1px solid var(--border);
            padding: 1.5rem 0;
            margin-bottom: 2rem;
        }
        
        .header-content {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .logo {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .logo-icon {
            width: 32px;
            height: 32px;
            background: linear-gradient(135deg, var(--accent), var(--accent-light));
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 18px;
        }
        
        .logo-text {
            font-size: 1.5rem;
            font-weight: 700;
            background: linear-gradient(135deg, var(--accent), var(--accent-light));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        
        .hero {
            text-align: center;
            margin-bottom: 3rem;
            padding: 2rem;
            background: var(--card-bg);
            border-radius: 12px;
            border: 1px solid var(--border);
        }
        
        .hero h1 {
            font-size: 2.5rem;
            margin-bottom: 1rem;
            background: linear-gradient(135deg, var(--accent), var(--accent-light));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        
        .hero p {
            color: var(--text-secondary);
            font-size: 1.1rem;
            max-width: 600px;
            margin: 0 auto;
        }
        
        .dashboard {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 2rem;
            margin-bottom: 3rem;
        }
        
        @media (max-width: 768px) {
            .dashboard {
                grid-template-columns: 1fr;
            }
        }
        
        .card {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 1.5rem;
        }
        
        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.5rem;
            padding-bottom: 1rem;
            border-bottom: 1px solid var(--border);
        }
        
        .card-title {
            font-size: 1.25rem;
            font-weight: 600;
            color: var(--text);
        }
        
        .btn {
            background: var(--accent);
            color: white;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 6px;
            font-family: 'Inter', sans-serif;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        
        .btn:hover {
            background: var(--accent-light);
            transform: translateY(-1px);
        }
        
        .btn-danger {
            background: var(--danger);
        }
        
        .btn-danger:hover {
            background: #dc2626;
        }
        
        .form-group {
            margin-bottom: 1rem;
        }
        
        label {
            display: block;
            margin-bottom: 0.5rem;
            color: var(--text-secondary);
            font-weight: 500;
        }
        
        input, select, textarea {
            width: 100%;
            padding: 0.75rem;
            background: var(--dark);
            border: 1px solid var(--border);
            border-radius: 6px;
            color: var(--text);
            font-family: 'Inter', sans-serif;
            font-size: 0.95rem;
        }
        
        input:focus, select:focus, textarea:focus {
            outline: none;
            border-color: var(--accent);
        }
        
        .job-list {
            display: flex;
            flex-direction: column;
            gap: 1rem;
        }
        
        .job-item {
            background: var(--dark);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 1rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .job-info h4 {
            color: var(--text);
            margin-bottom: 0.25rem;
        }
        
        .job-meta {
            display: flex;
            gap: 1rem;
            color: var(--text-secondary);
            font-size: 0.875rem;
        }
        
        .status-badge {
            padding: 0.25rem 0.75rem;
            border-radius: 999px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .status-active {
            background: rgba(16, 185, 129, 0.1);
            color: var(--success);
            border: 1px solid rgba(16, 185, 129, 0.3);
        }
        
        .status-paused {
            background: rgba(245, 158, 11, 0.1);
            color: var(--warning);
            border: 1px solid rgba(245, 158, 11, 0.3);
        }
        
        .history-item {
            background: var(--dark);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 1rem;
            margin-bottom: 0.75rem;
        }
        
        .history-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 0.5rem;
        }
        
        .history-status {
            font-weight: 600;
        }
        
        .status-success {
            color: var(--success);
        }
        
        .status-failure {
            color: var(--danger);
        }
        
        .history-time {
            color: var(--text-secondary);
            font-size: 0.875rem;
        }
        
        footer {
            text-align: center;
            padding: 2rem 0;
            margin-top: 3rem;
            border-top: 1px solid var(--border);
            color: var(--text-secondary);
            font-size: 0.875rem;
        }
        
        .footer-logo {
            color: var(--accent);
            font-weight: 700;
            margin-bottom: 0.5rem;
        }
        
        .cron-example {
            font-family: monospace;
            background: var(--dark);
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.875rem;
            color: var(--accent-light);
        }
        
        .alert {
            padding: 1rem;
            border-radius: 8px;
            margin-bottom: 1rem;
            display: none;
        }
        
        .alert-success {
            background: rgba(16, 185, 129, 0.1);
            border: 1px solid rgba(16, 185, 129, 0.3);
            color: var(--success);
        }
        
        .alert-error {
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.3);
            color: var(--danger);
        }
    </style>
</head>
<body>
    <header>
        <div class="container">
            <div class="header-content">
                <div class="logo">
                    <div class="logo-icon">F</div>
                    <div class="logo-text">Fleet Cron</div>
                </div>
                <div>
                    <span class="status-badge status-active">System Active</span>
                </div>
            </div>
        </div>
    </header>
    
    <main class="container">
        <section class="hero">
            <h1>Set it and forget it</h1>
            <p>Fleet Cron manages your scheduled tasks, recurring health checks, and batch processing with enterprise reliability.</p>
        </section>
        
        <div class="dashboard">
            <div class="card">
                <div class="card-header">
                    <h2 class="card-title">Schedule New Job</h2>
                </div>
                <form id="scheduleForm">
                    <div id="alert" class="alert"></div>
                    
                    <div class="form-group">
                        <label for="name">Job Name</label>
                        <input type="text" id="name" placeholder="Daily Health Check" required>
                    </div>
                    
                    <div class="form-group">
                        <label for="cronExpression">Cron Expression</label>
                        <input type="text" id="cronExpression" placeholder="0 9 * * *" required>
                        <small style="color: var(--text-secondary); margin-top: 0.25rem; display: block;">
                            Format: minute hour day-of-month month day-of-week<br>
                            Example: <span class="cron-example">0 9 * * *</span> (Daily at 9:00 AM)
                        </small>
                    </div>
                    
                    <div class="form-group">
                        <label for="endpoint">Endpoint URL</label>
                        <input type="url" id="endpoint" placeholder="https://api.example.com/health" required>
                    </div>
                    
                    <div class="form-group">
                        <label for="method">HTTP Method</label>
                        <select id="method">
                            <option value="GET">GET</option>
                            <option value="POST">POST</option>
                            <option value="PUT">PUT</option>
                            <option value="DELETE">DELETE</option>
                            <option value="PATCH">PATCH</option>
                        </select>
                    </div>
                    
                    <div class="form-group">
                        <label for="headers">Headers (JSON)</label>
                        <textarea id="headers" rows="3" placeholder='{"Content-Type": "application/json", "Authorization": "Bearer token"}'></textarea>
                    </div>
                    
                    <div class="form-group">
                        <label for="body">Request Body (JSON)</label>
                        <textarea id="body" rows="4" placeholder='{"action": "health_check"}'></textarea>
                    </div>
                    
                    <button type="submit" class="btn">
                        <span>Schedule Job</span>
                    </button>
                </form>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <h2 class="card-title">Active Jobs</h2>
                    <button class="btn" onclick="loadJobs()">Refresh</button>
                </div>
                <div class="job-list" id="jobsList">
                    <div style="text-align: center; padding: 2rem; color: var(--text-secondary);">
                        Loading jobs...
                    </div>
                </div>
            </div>
        </div>
        
        <div class="card">
            <div class="card-header">
                <h2 class="card-title">Execution History</h2>
            </div>
            <div id="historyList">
                <div style="text-align: center; padding: 2rem; color: var(--text-secondary);">
                    Loading history...
                </div>
            </div>
        </div>
    </main>
    
    <footer>
        <div class="container">
            <div class="footer-logo">Fleet Cron</div>
            <p>Scheduled tasks, recurring health checks, batch processing</p>
            <p style="margin-top: 1rem; font-size: 0.75rem; opacity: 0.7;">
                &copy; ${new Date().getFullYear()} Fleet Systems. All systems operational.
            </p>
        </div>
    </footer>
    
    <script>
        function showAlert(message, type = 'success') {
            const alert = document.getElementById('alert');
            alert.textContent = message;
            alert.className = 'alert ' + (type === 'success' ? 'alert-success' : 'alert-error');
            alert.style.display = 'block';
            setTimeout(() => alert.style.display = 'none', 5000);
        }
        
        async function loadJobs() {
            try {
                const response = await fetch('/api/jobs');
                const jobs = await response.json();
                
                const jobsList = document.getElementById('jobsList');
                if (jobs.length === 0) {
                    jobsList.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">No scheduled jobs</div>';
                    return;
                }
                
                jobsList.innerHTML = jobs.map(job => \`
                    <div class="job-item">
                        <div class="job-info">
                            <h4>\${job.name}</h4>
                            <div class="job-meta">
                                <span>\${job.cronExpression}</span>
                                <span>\${job.endpoint}</span>
                                <span>Next: \${new Date(job.nextRun).toLocaleString()}</span>
                            </div>
                        </div>
                        <div>
                            <span class="status-badge \${job.enabled ? 'status-active' : 'status-paused'}">
                                \${job.enabled ? 'Active' : 'Paused'}
                            </span>
                            <button class="btn btn-danger" style="margin-left: 0.5rem;" onclick="deleteJob('\${job.id}')">
                                Delete
                            </button>
                        </div>
                    </div>
                \`).join('');
            } catch (error) {
                console.error('Failed to load jobs:', error);
            }
        }
        
        async function loadHistory() {
            try {
                const response = await fetch('/api/history');
                const history = await response.json();
                
                const historyList = document.getElementById('historyList');
                if (history.length === 0) {
                    historyList.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-secondary);">No execution history</div>';
                    return;
                }
                
                historyList.innerHTML = history.slice(0, 10).map(entry => \`
                    <div class="history-item">
                        <div class="history-header">
                            <div>
                                <strong>\${entry.jobName}</strong>
                                <span class="history-status \${'status-' + entry.status}">
                                    \${entry.status.toUpperCase()}
                                </span>
                            </div>
                            <div class="history-time">
                                \${new Date(entry.timestamp).to
const sh = {"Content-Security-Policy":"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; frame-ancestors 'none'","X-Frame-Options":"DENY"};
export default { async fetch(r: Request) { const u = new URL(r.url); if (u.pathname==='/health') return new Response(JSON.stringify({status:'ok'}),{headers:{'Content-Type':'application/json',...sh}}); return new Response(html,{headers:{'Content-Type':'text/html;charset=UTF-8',...sh}}); }};