# DiskOrg Control Panel (SCD)

DiskOrg Control Panel（SCD）是一个面向大规模本地存储整理的扫描、索引、去重和风险标记工具。

## 已实现能力

- NTFS/EXT4 场景的通用扫描逻辑
- 流式扫描事件输出
- 大小范围、路径黑白名单、glob 过滤
- OneDrive 占位文件跳过
- 分层去重（size -> quick hash -> full hash）
- 加密 ZIP、加密 PDF、长路径、可疑损坏标记
- SQLite 持久化（SQL.js）
- CSV/JSON/SQLite 快照导出
- CLI 查询排序与过滤
- 任务状态保存与恢复

## 快速开始

```bash
npm install
npm run build
npm test
```

## 扫描示例

```bash
npm run dev -- scan \
  --roots D:\\Archive,D:\\Projects \
  --min-size 1024 \
  --max-size 10737418240 \
  --exclude "**/*.tmp,**/*.log" \
  --csv out/files.csv \
  --json out/files.json \
  --db out/files.sqlite \
  --save-state out/state.json
```

## 恢复扫描示例

```bash
npm run dev -- scan \
  --roots D:\\Archive \
  --resume-state out/state.json
```

## 查询示例

```bash
npm run dev -- query \
  --input out/files.json \
  --sort-by size \
  --order desc \
  --contains ".psd" \
  --limit 50
```
