-- Echo Newsletter v1.0.0 Schema

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT,
  from_name TEXT NOT NULL DEFAULT 'Newsletter',
  from_email TEXT,
  reply_to TEXT,
  logo_url TEXT,
  brand_color TEXT DEFAULT '#14b8a6',
  max_subscribers INTEGER DEFAULT 1000,
  max_sends_per_day INTEGER DEFAULT 500,
  plan TEXT DEFAULT 'starter',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  subscriber_count INTEGER DEFAULT 0,
  double_optin INTEGER DEFAULT 1,
  welcome_email_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  status TEXT DEFAULT 'pending',
  confirmed_at TEXT,
  custom_fields TEXT DEFAULT '{}',
  source TEXT DEFAULT 'api',
  ip_address TEXT,
  unsubscribed_at TEXT,
  bounce_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, email)
);

CREATE TABLE IF NOT EXISTS list_subscribers (
  list_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  added_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(list_id, subscriber_id)
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT,
  subject_line TEXT NOT NULL,
  preview_text TEXT,
  content_html TEXT NOT NULL,
  content_text TEXT,
  status TEXT DEFAULT 'draft',
  scheduled_at TEXT,
  sent_at TEXT,
  list_id TEXT,
  total_sent INTEGER DEFAULT 0,
  total_opened INTEGER DEFAULT 0,
  total_clicked INTEGER DEFAULT 0,
  total_unsubscribed INTEGER DEFAULT 0,
  total_bounced INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sends (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  sent_at TEXT,
  opened_at TEXT,
  clicked_at TEXT,
  bounced_at TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(issue_id, subscriber_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  issue_id TEXT,
  subscriber_id TEXT,
  event_type TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  html TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_config TEXT DEFAULT '{}',
  steps TEXT DEFAULT '[]',
  status TEXT DEFAULT 'inactive',
  total_enrolled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS automation_enrollments (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  current_step INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  next_step_at TEXT,
  enrolled_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE(automation_id, subscriber_id)
);

CREATE TABLE IF NOT EXISTS analytics_daily (
  tenant_id TEXT NOT NULL,
  date TEXT NOT NULL,
  subscribers_total INTEGER DEFAULT 0,
  subscribers_new INTEGER DEFAULT 0,
  subscribers_unsubscribed INTEGER DEFAULT 0,
  emails_sent INTEGER DEFAULT 0,
  emails_opened INTEGER DEFAULT 0,
  emails_clicked INTEGER DEFAULT 0,
  emails_bounced INTEGER DEFAULT 0,
  UNIQUE(tenant_id, date)
);

CREATE INDEX IF NOT EXISTS idx_subscribers_tenant ON subscribers(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_issues_tenant ON issues(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_sends_issue ON sends(issue_id, status);
CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_id, event_type);
CREATE INDEX IF NOT EXISTS idx_automations_tenant ON automations(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_enrollments_next ON automation_enrollments(status, next_step_at);
