export const scenes = [
  {
    id: "overview",
    title: "场景1：总览开场",
    description: "聚焦主标题和摘要区域，建立页面认知。",
    run: async (ctx) => {
      await ctx.waitForAppReady();
      await ctx.highlight(
        "header.hero",
        {
          zh: "这里是 SCD 的总览区：上方给出产品定位，下方四张卡片展示当前数据规模与风险概况。",
          en: "This is the SCD overview area: product positioning is shown at the top, and four metric cards summarize size and risk status.",
        },
      );
    },
  },
  {
    id: "language-switch",
    title: "场景2：语言切换",
    description: "切换英文再切回中文，演示本地化能力。",
    run: async (ctx) => {
      await ctx.waitForAppReady();
      await ctx.highlight(
        ".hero-actions-stack",
        {
          zh: "这一区域用于切换语言/日期/时间格式。接下来会通过页面内下拉框中英来回切换两次，并在英文界面额外停留，便于现场展示。",
          en: "This area controls language/date/time format. We will switch the in-app dropdown between Chinese and English twice, with longer pauses in English for clearer visual effect.",
        },
      );

      await ctx.selectLanguage("en");
      await ctx.wait(2400);

      await ctx.selectLanguage("zh");
      await ctx.wait(900);

      await ctx.selectLanguage("en");
      await ctx.wait(2200);

      await ctx.selectLanguage("zh");
      await ctx.wait(800);
    },
  },
  {
    id: "search-and-scroll",
    title: "场景3：搜索与滚动",
    description: "在搜索框输入关键字并滚动索引列表。",
    run: async (ctx) => {
      await ctx.waitForAppReady();
      await ctx.highlight(
        ".table-panel",
        {
          zh: "中间是索引主表。这里演示搜索关键字与滚动查看，突出数据探索能力。",
          en: "The center area is the index table. This scene demonstrates keyword search and table scrolling for data exploration.",
        },
      );
      await ctx.typeInInputByPlaceholder("regex", "json");
      await ctx.wait(700);
      await ctx.scroll(".table-wrap", 420);
      await ctx.wait(800);
      await ctx.scroll(".table-wrap", 0);
      await ctx.clearInputByPlaceholder("regex");
    },
  },
  {
    id: "select-detail",
    title: "场景4：选择并查看详情",
    description: "选中一行，展示右侧详情模块变化。",
    run: async (ctx) => {
      await ctx.waitForAppReady();
      await ctx.clickFirst("tbody tr:not(.spacer-row)");
      await ctx.wait(900);
      await ctx.highlight(
        ".detail-panel",
        {
          zh: "右上是详情模块：路径、大小、类型、时间和状态会随选中项即时更新。",
          en: "Top-right is the detail panel: path, size, type, timestamps, and status update immediately with the selected row.",
        },
      );
      await ctx.wait(900);
    },
  },
  {
    id: "insight",
    title: "场景5：这是什么分析",
    description: "触发分析按钮，展示可解释建议区域。",
    run: async (ctx) => {
      await ctx.waitForAppReady();
      await ctx.highlight(
        ".insight-panel",
        {
          zh: "右下是“这是什么”模块。点击分析后会给出建议、置信度和影响说明（演示环境为沙盒结果）。",
          en: "Bottom-right is the \"What is this\" insight panel. Clicking Analyze returns recommendation, confidence, and impact notes (sandbox demo result).",
        },
      );
      await ctx.clickByText("button", "分析", "Analyze");
      await ctx.wait(1400);
    },
  },
  {
    id: "compression-tab",
    title: "场景6：压缩配置区",
    description: "切换到压缩配置并展示模式选择。",
    run: async (ctx) => {
      await ctx.waitForAppReady();
      await ctx.clickByText("button", "压缩", "Compression");
      await ctx.wait(900);
      await ctx.highlight(
        ".llm-settings-footer",
        {
          zh: "底部是压缩/打包配置区，可选择模式、输出路径和参数（沙盒中不会执行真实写入）。",
          en: "The bottom section is for compression/packaging settings, including mode, output path, and parameters (sandbox does not write real files).",
        },
      );
      await ctx.wait(1000);
    },
  },
];
