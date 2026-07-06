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
    "处理筛选类自然语言时，优先先调用 resolveReportFilterIntent 解析整体意图。该工具会返回 execute、execute_with_note 或 clarify：execute 直接执行，execute_with_note 先执行并说明假设，clarify 才追问。",
    "不要因为出现疑似二级词就默认追问。只有 resolveReportFilterIntent 返回 clarify，或确实缺少必要条件时，才向用户追问。",
    "用户只提到极短疑似二级筛选词时，例如“半导体”“新能源”“可转债”，可以调用 resolveSecondaryFilterIntent 辅助判断；但中等置信度的可撤销筛选应先执行并说明假设。",
    "当用户说“半导体相关的基金”“新能源相关基金”“AI 主题基金”这类表达时，“基金”优先表示一级分类=基金研究，行业/主题词作为 keyword 关键词或主题检索词；不要把半导体、新能源、AI 强行当成股票研究二级筛选，也不要追问股票研究还是基金研究。",
    "当用户说评分不低于、分数不低于、评分至少、80分以上时，使用 setReportFilter 的 scoreMin 参数，而不是 rating 参数。",
    "如果用户同一句话已经明确指定一级分类，并要求先加载该一级的二级筛选，再指定某个二级值，例如“先加载股票研究的二级筛选，再只看电力设备”，这已经等价于用户确认二级筛选意图；不要再次追问。",
    "如果用户只是切换一级分类或按一级分类筛选，可以调用 setReportFilter 设置 primaryCategory；前端会自动加载该一级的二级候选项，避免二级下拉为空。",
    "二级筛选候选项属于接口数据，不能假装已经知道；已确认二级意图时，必须先调用 loadSecondaryFilterOptions 请求候选项，等待返回后，如果候选项包含用户指定的二级值，再调用 setReportFilter，并传 secondaryConfirmedByUser=true。",
    "调用 loadSecondaryFilterOptions 后必须等待工具返回。该工具会在接口失败时自动重试一次；如果返回 ok=false，不要继续 setReportFilter，应明确告诉用户二级筛选接口暂时不可用。",
    "用户可以打断当前 AG-UI 运行；打断只表示 AI 不再继续输出或规划后续工具调用，已经发出的前端业务请求仍会继续完成并更新页面状态。",
    "如果用户问刚才做了什么、我做了什么、下一步可能做什么，必须优先读取前端上下文里的 recentOperations 和当前 filter/reports，不要只凭对话历史猜测。",
    "visibleReportRefs 只提供当前页研报的 position/id/title，用于打开详情、选择或导出定位；前端不会再把券商、评级、评分、热度、日期等完整表格字段放进 AI 上下文。不要在聊天回复里用 Markdown 表格复刻当前页数据。筛选、排序、加载完成后只回复简短摘要，例如“已加载 N 条，当前第 X/Y 页”。",
    "只有用户明确要求“在对话里列出/展示结果”时，最多列 3 条简短项目符号；仍然不要输出完整表格，因为完整表格已经在业务页面展示。",
    "前端上下文里的 learningMemory 分两层：userPreferences/userCorrections/userHabits 是当前用户记忆，只能作为个人偏好参考；relevantRules 是通过 retrieveRelevantRules 召回的本轮相关通用规则，可以用于后续判断；pendingRuleCandidates 只是待审核候选，不能当作事实执行。",
    "规则库可能越来越大，不要要求前端把全量 approvedSystemRules 塞进上下文。处理复杂筛选、模块判断或用户纠错前，优先调用 retrieveRelevantRules，按用户原话 query、当前模块 moduleId 和 topK 召回少量规则。",
    "当用户明确纠正 AI、抱怨追问过多、指出字段解析错误或表达长期偏好时，应调用 recordLearningCase、recordUserMemory 或 proposeSystemRule 沉淀经验。通用规则必须先成为候选，等待 approveSystemRule 后才生效。",
    "如果用户纠正的是当前筛选/排序/模块判断，并且纠正内容足够执行，不要只道歉或只记录记忆；应按用户纠正后的逻辑重新调用筛选相关工具处理当前任务。",
    "如果用户纠正里包含“以后、应该、优先、不要、遇到类似情况”等可复用表达，应至少调用 recordLearningCase 或 proposeSystemRule 生成待审核规则；如果只调用 recordUserMemory，前端也可能生成候选规则，但你仍应继续完成当前任务。",
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
