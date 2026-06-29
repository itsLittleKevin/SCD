# SCD Wiki（DiskOrg Control Panel）

本目录用于沉淀本项目从需求演进到落地实现的完整过程，适配后续迁移到 Wiki.js。

## 阅读入口

1. [产品总览与范围](01-product-scope.md)
2. [规划逻辑与决策链](02-planning-logic.md)
3. [执行方案与交付路径](03-implementation-plan.md)
4. [功能清单与说明](04-feature-catalog.md)
5. [问题清单与解决方案](05-problem-log-and-solutions.md)
6. [架构与 API 总览](06-architecture-and-api.md)
7. [本地化体系与内容治理](07-localization-and-content.md)
8. [后续目标与路线图](08-roadmap.md)

## 项目代号与命名

- 产品名：DiskOrg Control Panel
- 简称：SCD

## 全局思维导图

```mermaid
mindmap
  root((SCD))
    产品定位
      本地文件治理
      搜索/压缩/查重
      风险标记与解释
    核心能力
      扫描与索引
      内容级去重
      风险识别
      压缩与归档
      智能分析(这是什么)
      Retention 自动清理
      i18n JSON 驱动
    关键约束
      默认安全优先
      敏感操作校验
      路径边界限制
      本地可恢复持久化
    当前 UI
      三栏主体
      右侧详情与这是什么同级
      4/6 比例
    下一阶段
      i18n 全量抽键
      质量与安全测试完善
      解释质量与术语统一
```

## 里程碑概览

```mermaid
flowchart LR
  A[阶段1: 扫描/索引/去重] --> B[阶段2: Insight 智能分析]
  B --> C[阶段3: Retention 自动清理]
  C --> D[阶段4: 压缩/打包能力]
  D --> E[阶段5: UI 重构与交互修正]
  E --> F[阶段6: 本地化治理与 JSON i18n]
  F --> G[阶段7: 安全加固]
  G --> H[阶段8: 品牌升级与 PRD 对齐]
```
