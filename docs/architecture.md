# DiskOrg Control Panel（SCD）技术方案（阶段 1）

## 技术栈

- Runtime: Node.js + TypeScript
- CLI: commander
- 数据库: SQL.js（SQLite 引擎）
- 测试: Vitest

## 模块划分

- scanner: 目录遍历、元数据采集、流式事件
- filter: 大小范围、黑白名单、缓存目录、OneDrive 跳过
- dedupe: 分层哈希（size -> quick -> full）
- risk: 加密、不可读、路径异常、OneDrive、损坏标记
- storage: SQLite schema、写入、查询、快照
- export: CSV/JSON 导出
- cli: 任务启动、暂停（当前先实现停止）、进度输出、导出命令

## 并发模型

- 扫描采用异步迭代器输出事件。
- 单线程为默认模式，后续可升级为 worker pool。
- 去重阶段按大小分桶后再执行哈希，降低 IO。

## 平台适配

- Windows: 处理路径长度、OneDrive 目录特征、权限拒绝错误。
- Linux: 兼容 EXT4 目录遍历与权限处理。
- 文件系统差异通过统一的文件信息模型封装。

## 错误策略

- 任何单文件错误都写入风险表，不中断全局任务。
- 不可读取/加密/受限文件统一标记为 skipped with reason。
