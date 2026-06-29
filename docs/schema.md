# 数据库 Schema（阶段 1）

## 核心表

### scan_task
- id TEXT PRIMARY KEY
- started_at TEXT
- finished_at TEXT
- status TEXT
- roots_json TEXT
- config_json TEXT

### file_record
- id TEXT PRIMARY KEY
- task_id TEXT
- path TEXT
- parent_path TEXT
- name TEXT
- ext TEXT
- size INTEGER
- ctime_ms INTEGER
- mtime_ms INTEGER
- atime_ms INTEGER
- fs_type TEXT
- platform TEXT
- is_dir INTEGER
- scan_status TEXT

### fingerprint
- file_id TEXT PRIMARY KEY
- quick_hash TEXT
- full_hash TEXT
- hash_algo TEXT

### risk_flag
- id TEXT PRIMARY KEY
- task_id TEXT
- file_path TEXT
- kind TEXT
- detail TEXT
- stage TEXT
- created_at TEXT

### duplicate_group
- id TEXT PRIMARY KEY
- task_id TEXT
- full_hash TEXT
- total_size INTEGER
- member_count INTEGER

### duplicate_member
- group_id TEXT
- file_id TEXT
- path TEXT
- size INTEGER

### scan_event
- id TEXT PRIMARY KEY
- task_id TEXT
- kind TEXT
- payload_json TEXT
- created_at TEXT
