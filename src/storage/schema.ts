export const schemaSql = `
CREATE TABLE IF NOT EXISTS scan_task (
  id TEXT PRIMARY KEY,
  started_at TEXT,
  finished_at TEXT,
  status TEXT,
  roots_json TEXT,
  config_json TEXT
);

CREATE TABLE IF NOT EXISTS file_record (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  path TEXT,
  parent_path TEXT,
  name TEXT,
  ext TEXT,
  size INTEGER,
  ctime_ms INTEGER,
  mtime_ms INTEGER,
  atime_ms INTEGER,
  fs_type TEXT,
  platform TEXT,
  is_dir INTEGER,
  scan_status TEXT
);

CREATE TABLE IF NOT EXISTS risk_flag (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  file_path TEXT,
  kind TEXT,
  detail TEXT,
  stage TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS duplicate_group (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  full_hash TEXT,
  total_size INTEGER,
  member_count INTEGER,
  explanation TEXT
);

CREATE TABLE IF NOT EXISTS duplicate_member (
  group_id TEXT,
  file_id TEXT,
  path TEXT,
  size INTEGER
);

CREATE TABLE IF NOT EXISTS scan_event (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  kind TEXT,
  payload_json TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS file_analysis_cache (
  path TEXT PRIMARY KEY,
  size INTEGER,
  mtime_ms REAL,
  ctime_ms REAL,
  quick_hash TEXT,
  quick_hash_bytes INTEGER,
  full_hash TEXT,
  risk_descriptors_json TEXT,
  updated_at TEXT
);
`;
