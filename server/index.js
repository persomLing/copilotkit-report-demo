import "dotenv/config";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createOpenAI } from "@ai-sdk/openai";
import { BuiltInAgent, CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotExpressHandler } from "@copilotkit/runtime/v2/express";

const port = Number(process.env.PORT || 4000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistDir = path.resolve(__dirname, "../dist");
const clientIndexHtml = path.join(clientDistDir, "index.html");

// CopilotKit Runtime 只需要一个 AI SDK model 实例。这里优先走 DeepSeek，没配置时再回退 OpenAI。
function createModel() {
  if (process.env.DEEPSEEK_API_KEY) {
    const deepseek = createOpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com",
    });
    return deepseek.chat("deepseek-v4-flash");
  }

  if (process.env.OPENAI_API_KEY) {
    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    return openai("gpt-4.1-mini");
  }

  console.warn(
    "[copilotkit-report-demo] No DEEPSEEK_API_KEY or OPENAI_API_KEY found. Chat requests will fail until .env is configured.",
  );
  const fallback = createOpenAI({ apiKey: "missing-api-key" });
  return fallback("gpt-4.1-mini");
}

// BuiltInAgent 是后端侧的“智能体壳”：模型负责理解意图，前端 useFrontendTool 负责真正改页面状态。
const agent = new BuiltInAgent({
  model: createModel(),
  instructions: [
    "你是研报工作台里的操作型助手。",
    "优先使用前端提供的工具改变页面，而不是只用文字解释。",
    "涉及筛选、排序、加载、打开详情、选中、导出时，调用对应工具。",
    "用户提到疑似二级筛选词时，例如可转债、新能源、半导体、主动权益、固收+，不要直接设置二级筛选；先调用 resolveSecondaryFilterIntent，根据金融背景判断可能一级方向，然后追问用户确认。",
    "二级筛选候选项属于接口数据，不能假装已经知道；用户确认后，先调用 loadSecondaryFilterOptions 请求候选项，再调用 setReportFilter，并传 secondaryConfirmedByUser=true。",
    "调用 loadSecondaryFilterOptions 后必须等待工具返回。该工具会在接口失败时自动重试一次；如果返回 ok=false，不要继续 setReportFilter，应明确告诉用户二级筛选接口暂时不可用。",
    "导出属于敏感动作，必须调用导出工具，由前端执行确认。",
    "如果用户说“第一篇”“当前结果”“可见报告”，根据页面上下文理解。",
  ].join("\n"),
});

// agent 名称需要和前端 <CopilotKit agent="report_agent"> 保持一致。
const runtime = new CopilotRuntime({
  agents: {
    report_agent: agent,
  },
});

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// single-route 模式把 CopilotKit 所有运行时请求收敛到 /api/copilotkit，方便旧项目做代理转发。
app.use(
  createCopilotExpressHandler({
    runtime,
    basePath: "/api/copilotkit",
    mode: "single-route",
    cors: true,
  }),
);

if (existsSync(clientIndexHtml)) {
  app.use(express.static(clientDistDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(clientIndexHtml);
  });
} else {
  console.warn("[copilotkit-report-demo] dist not found. Run npm run build before using production/static mode.");
}

app.listen(port, () => {
  console.log(`CopilotKit runtime: http://localhost:${port}/api/copilotkit`);
  if (existsSync(clientIndexHtml)) {
    console.log(`CopilotKit report demo: http://localhost:${port}`);
  }
});
