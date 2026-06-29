# 执行方案与交付路径

## 1. 端到端执行框架

```mermaid
sequenceDiagram
  participant U as User
  participant UI as React UI
  participant API as API Server
  participant DB as SQLite
  participant TOOLS as ffmpeg/gs/tar

  U->>UI: 配置扫描/筛选
  UI->>API: /api/scan/start
  API->>DB: 持久化任务与事件
  API-->>UI: 实时状态与记录
  U->>UI: 选择重复组/文件
  UI->>API: /api/insight/analyze
  API-->>UI: 建议/置信度/影响
  U->>UI: 发起压缩/打包
  UI->>API: /api/compress/run 或 /api/compress/batch
  API->>TOOLS: 调用外部工具
  API-->>UI: 输出结果与失败列表
```

## 2. 分层方案

1. UI 层：筛选、列表、详情、分析与压缩交互。
2. API 层：扫描任务、分析、压缩、删除/复制、安全校验。
3. 核心层：扫描、去重、风险识别规则。
4. 存储层：SQLite（任务、文件、重复组、风险、缓存）。
5. 外部工具层：ffmpeg/ffprobe、Ghostscript、tar、zip。

## 3. 交付节奏建议

1. 功能迭代：按“扫描主干 -> 分析 -> 压缩 -> 安全 -> i18n”推进。
2. 质量闸门：每轮至少通过 `npm run build` 与 `npm run build:ui`。
3. 文档同步：PRD 与 Wiki 在每次里程碑后更新。

## 4. 验证策略

1. 构建验证：TypeScript 与 Vite 打包。
2. API 验证：关键接口请求/响应与失败路径验证。
3. 交互验证：选择语义、提示层层级、本地化回归。
