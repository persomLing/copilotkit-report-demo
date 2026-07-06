import { useMemo, useRef, useState } from "react";
import {
  CopilotPopup,
  UseAgentUpdate,
  useAgent,
  useAgentContext,
  useDefaultRenderTool,
  useFrontendTool,
} from "@copilotkit/react-core/v2";
import { z } from "zod";
import {
  BROKERS,
  ANALYSTS,
  DIRECTIONS,
  ORDER_FIELDS,
  PAGE_SIZES,
  PRIMARY_OPTIONS,
  RATINGS,
  RISKS,
  delay,
  getSecondaryOptions,
  normalizeFilter,
  queryReports,
  requestSecondaryOptions,
  resolveReportFilterIntent,
  resolveSecondaryTermHint,
} from "./reportStore.js";
import {
  addRuleCandidate,
  addUserMemory,
  approveRuleCandidate,
  dismissRuleCandidate,
  extractRuleCandidateFromFeedback,
  forgetUserMemory,
  loadKnowledgeBase,
  recordLearningCase,
  resetKnowledgeBase,
  saveKnowledgeBase,
  summarizeKnowledgeForAgent,
} from "./memoryStore.js";

// 页面筛选条件的唯一默认值。所有“清空条件”和首次加载都从这里恢复，避免手动维护多份默认状态。
const defaultFilter = normalizeFilter({
  keyword: "",
  broker: "全部",
  rating: "全部",
  risk: "全部",
  analyst: "全部",
  primaryCategory: "全部",
  secondaryCategory: "全部",
  dateFrom: "",
  dateTo: "",
  scoreMin: "",
  readCountMin: "",
  orderBy: "date",
  direction: "desc",
  page: 1,
  pageSize: 10,
});

const ratingClass = {
  强烈推荐: "rating rating-strong",
  超配: "rating rating-strong",
  买入: "rating rating-buy",
  增持: "rating rating-add",
  中性: "rating rating-neutral",
  减持: "rating rating-reduce",
};

const primaryEnum = z.enum(PRIMARY_OPTIONS);
const brokerEnum = z.enum(BROKERS);
const ratingEnum = z.enum(RATINGS);
const riskEnum = z.enum(RISKS);
const analystEnum = z.enum(ANALYSTS);
const orderFieldEnum = z.enum(ORDER_FIELDS);
const directionEnum = z.enum(DIRECTIONS);

// 导出当前表格页为 CSV。这里加 BOM 是为了 Excel 直接打开中文不乱码。
function downloadCsv(filename, rows) {
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const initialResult = queryReports(defaultFilter);
  const [filter, setFilter] = useState(defaultFilter);

  // Copilot action 的 handler 是异步闭包，直接读 React state 容易拿到旧值。
  // 所以筛选条件和二级候选项各保留一份 ref，作为 action 执行时的最新事实源。
  const filterRef = useRef(defaultFilter);
  const reportsRef = useRef(initialResult.rows);
  const [secondaryOptions, setSecondaryOptions] = useState(getSecondaryOptions(defaultFilter.primaryCategory));
  const secondaryOptionsRef = useRef(getSecondaryOptions(defaultFilter.primaryCategory));
  const [loading, setLoading] = useState(false);
  const [secondaryLoading, setSecondaryLoading] = useState(false);
  const [reports, setReports] = useState(initialResult.rows);
  const [pagination, setPagination] = useState({
    total: initialResult.total,
    page: initialResult.page,
    pageSize: initialResult.pageSize,
    totalPages: initialResult.totalPages,
  });
  const [selectedIds, setSelectedIds] = useState([]);
  const selectedIdsRef = useRef([]);
  const [activeReportId, setActiveReportId] = useState(initialResult.rows[0]?.id || null);
  const [activity, setActivity] = useState(["初始化加载：展示全部研报前 10 条"]);
  const initialOperationLogRef = useRef([
    {
      id: "op-init",
      actor: "system",
      type: "loadReports",
      status: "completed",
      summary: "初始化加载：展示全部研报前 10 条",
      payload: { total: initialResult.total, page: initialResult.page },
      createdAt: new Date().toISOString(),
    },
  ]);
  const operationLogRef = useRef(initialOperationLogRef.current);
  const [operationLog, setOperationLog] = useState(initialOperationLogRef.current);
  const [knowledgeBase, setKnowledgeBase] = useState(() => loadKnowledgeBase());
  const knowledgeBaseRef = useRef(knowledgeBase);
  const [copilotStarted, setCopilotStarted] = useState(false);
  const [activeTab, setActiveTab] = useState("workbench");
  const { agent } = useAgent({
    agentId: "report_agent",
    updates: [UseAgentUpdate.OnRunStatusChanged],
  });
  const activeOperationRef = useRef(null);
  const [activeOperation, setActiveOperation] = useState(null);

  const activeReport = reports.find((item) => item.id === activeReportId) || null;
  const canInterrupt = agent.isRunning || Boolean(activeOperation);
  const showSecondaryFilter = filter.primaryCategory !== "全部";

  function formatOperationLog(entry) {
    const actorName = {
      ai: "AI",
      user: "用户",
      system: "系统",
    }[entry.actor] || entry.actor;
    const statusName = {
      running: "开始",
      completed: "完成",
      failed: "失败",
      interrupted: "打断",
    }[entry.status] || entry.status;
    return `${actorName} ${statusName}：${entry.summary}`;
  }

  function recordOperation({ actor = "system", type = "activity", status = "completed", summary, payload = {} }) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      actor,
      type,
      status,
      summary,
      payload,
      createdAt: new Date().toISOString(),
    };
    const nextLog = [entry, ...operationLogRef.current].slice(0, 40);
    operationLogRef.current = nextLog;
    setOperationLog(nextLog);
    setActivity(nextLog.slice(0, 10).map(formatOperationLog));
    return entry;
  }

  // 页面操作流水同时服务 UI 审计和 Copilot 上下文，避免 AI 只靠对话历史猜测用户做过什么。
  function pushActivity(message, metadata = {}) {
    recordOperation({ summary: message, ...metadata });
  }

  function updateKnowledgeBase(updater, summary, payload = {}) {
    const nextKnowledgeBase = updater(knowledgeBaseRef.current);
    knowledgeBaseRef.current = nextKnowledgeBase;
    setKnowledgeBase(nextKnowledgeBase);
    saveKnowledgeBase(nextKnowledgeBase);
    pushActivity(summary, {
      actor: "system",
      type: "learningMemory",
      status: "completed",
      payload,
    });
    return nextKnowledgeBase;
  }

  function startTrackedOperation(label) {
    const operation = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      label,
      startedAt: Date.now(),
    };

    activeOperationRef.current = operation;
    setActiveOperation({ id: operation.id, label, startedAt: operation.startedAt });

    return {
      finish: () => {
        if (activeOperationRef.current?.id === operation.id) {
          activeOperationRef.current = null;
          setActiveOperation(null);
        }
      },
    };
  }

  function interruptCurrentOperation() {
    if (agent.isRunning) agent.abortRun();
    pushActivity("打断 AI 后续操作，已发出的前端请求继续完成", {
      actor: "user",
      type: "interruptAgentRun",
      status: "interrupted",
      payload: { activeOperation: activeOperationRef.current?.label || null },
    });
  }

  function setCurrentFilter(nextFilter) {
    const normalized = normalizeFilter(nextFilter);
    filterRef.current = normalized;
    setFilter(normalized);
    return normalized;
  }

  // 二级筛选必须跟随一级筛选重新加载；切换一级后如果原二级不合法，需要自动重置。
  async function fetchSecondaryOptions(primaryCategory, reason = "用户切换一级筛选", options = {}) {
    const safePrimary = PRIMARY_OPTIONS.includes(primaryCategory) ? primaryCategory : "全部";
    const simulateRequestCase = options.simulateRequestCase || "normal";
    const actor = options.actor || "system";
    const operation = startTrackedOperation(`二级筛选接口：${safePrimary}`);
    setSecondaryLoading(true);
    pushActivity(`请求二级筛选接口：一级=${safePrimary}${reason ? `，原因=${reason}` : ""}`, {
      actor,
      type: "loadSecondaryOptions",
      status: "running",
      payload: { primaryCategory: safePrimary, reason },
    });

    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          pushActivity(`等待二级筛选接口返回：第 ${attempt} 次请求`, {
            actor: "system",
            type: "secondaryOptionsRequest",
            status: "running",
            payload: { primaryCategory: safePrimary, attempt },
          });
          const nextOptions = await requestSecondaryOptions(safePrimary, {
            attempt,
            simulateRequestCase,
          });
          secondaryOptionsRef.current = nextOptions;
          setSecondaryOptions(nextOptions);

          const current = filterRef.current;
          if (current.primaryCategory !== safePrimary || !nextOptions.includes(current.secondaryCategory)) {
            setCurrentFilter({
              ...current,
              primaryCategory: safePrimary,
              secondaryCategory: "全部",
              page: 1,
            });
          }

          pushActivity(`二级筛选已加载：${nextOptions.join(" / ")}`, {
            actor: "system",
            type: "secondaryOptionsRequest",
            status: "completed",
            payload: { primaryCategory: safePrimary, secondaryOptions: nextOptions, attempts: attempt },
          });
          return {
            ok: true,
            primaryCategory: safePrimary,
            secondaryOptions: nextOptions,
            attempts: attempt,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt === 1) {
            pushActivity(`二级筛选接口失败：${message}，自动重试一次`, {
              actor: "system",
              type: "secondaryOptionsRequest",
              status: "failed",
              payload: { primaryCategory: safePrimary, attempt, error: message, willRetry: true },
            });
            continue;
          }

          pushActivity(`二级筛选接口连续失败：${message}`, {
            actor: "system",
            type: "secondaryOptionsRequest",
            status: "failed",
            payload: { primaryCategory: safePrimary, attempt, error: message, willRetry: false },
          });
          return {
            ok: false,
            primaryCategory: safePrimary,
            secondaryOptions: [],
            attempts: attempt,
            error: message,
          };
        }
      }
    } finally {
      setSecondaryLoading(false);
      operation.finish();
    }

    return {
      ok: false,
      primaryCategory: safePrimary,
      secondaryOptions: [],
      attempts: 2,
      error: "二级筛选接口没有返回结果",
    };
  }

  // 表格每次重新查询后，选中态和详情态都要同步到新的结果集，避免选中已不可见的数据。
  function applyQueryResult(result) {
    reportsRef.current = result.rows;
    setReports(result.rows);
    setPagination({
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    });
    selectedIdsRef.current = [];
    setSelectedIds([]);
    setActiveReportId(result.rows[0]?.id || null);
    setCurrentFilter({ ...filterRef.current, page: result.page, pageSize: result.pageSize });
  }

  // 所有入口都复用这一条加载链路：手动按钮、排序、翻页和 Copilot action。
  async function loadReportsWithCurrentFilter(reason = "刷新列表", options = {}) {
    const actor = options.actor || "system";
    const operation = startTrackedOperation(`加载研报：${reason}`);
    setLoading(true);
    pushActivity(`开始加载研报：${reason}`, {
      actor,
      type: "loadReports",
      status: "running",
      payload: { reason, filter: filterRef.current },
    });

    try {
      await delay(420);
      const result = queryReports(filterRef.current);
      applyQueryResult(result);
      pushActivity(`加载完成：共 ${result.total} 条，当前第 ${result.page}/${result.totalPages} 页`, {
        actor: "system",
        type: "loadReports",
        status: "completed",
        payload: { total: result.total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages },
      });
      return result;
    } catch (error) {
      throw error;
    } finally {
      setLoading(false);
      operation.finish();
    }
  }

  // 清空条件的业务语义是“回到全部数据”，所以会同时重置一级/二级筛选和分页。
  async function clearFiltersAndLoad(reason = "清空条件后加载全部数据", options = {}) {
    const defaultSecondaryOptions = getSecondaryOptions("全部");
    secondaryOptionsRef.current = defaultSecondaryOptions;
    setSecondaryOptions(defaultSecondaryOptions);
    setCurrentFilter(defaultFilter);
    pushActivity("清空筛选条件", {
      actor: options.actor || "system",
      type: "clearFilter",
      status: "completed",
      payload: { filter: defaultFilter },
    });
    return loadReportsWithCurrentFilter(reason, options);
  }

  // 暴露给 Copilot 的页面上下文。LLM 会根据这些状态理解“当前结果”“再按热度排”等相对指令。
  const contextValue = useMemo(
    () => ({
      page: "ReportWorkbench",
      filter,
      secondaryOptionsStatus: {
        loadedForPrimaryCategory: filter.primaryCategory,
        visibleInUi: showSecondaryFilter,
        requestPolicy: "调用 loadSecondaryFilterOptions 后必须等待工具返回；如果第一次接口失败，工具会自动重试一次；如果 ok=false，必须告知用户失败并停止后续筛选动作。",
        source: "二级筛选候选项只允许通过 loadSecondaryFilterOptions 模拟接口请求获取，不在页面上下文中直接暴露给 AI。",
      },
      loading,
      secondaryLoading,
      totalReportCount: pagination.total,
      currentPage: pagination.page,
      totalPages: pagination.totalPages,
      visibleReportCount: reports.length,
      visibleReports: reports.map((item, index) => ({
        position: index + 1,
        id: item.id,
        title: item.title,
        broker: item.broker,
        rating: item.rating,
        risk: item.risk,
        primaryCategory: item.primaryCategory,
        secondaryCategory: item.secondaryCategory,
        analyst: item.analyst,
        score: item.score,
        readCount: item.readCount,
        date: item.date,
      })),
      selectedIds,
      activeReportId,
      recentOperations: operationLog.slice(0, 20).map((entry) => ({
        actor: entry.actor,
        type: entry.type,
        status: entry.status,
        summary: entry.summary,
        payload: entry.payload,
        createdAt: entry.createdAt,
      })),
      interrupt: {
        agentRunning: agent.isRunning,
        localOperation: activeOperation?.label || null,
        canInterrupt,
        policy: "用户打断只停止 AI 继续输出和继续规划后续工具调用；已经发出的前端业务请求会继续完成，并照常更新共享页面状态。",
      },
      learningMemory: summarizeKnowledgeForAgent(knowledgeBase),
      requiredWorkflowForSecondaryFilter: [
        "筛选类自然语言优先调用 resolveReportFilterIntent 解析整体意图；返回 execute 直接执行，execute_with_note 先执行并说明假设，clarify 才追问",
        "不要因为出现疑似二级词就默认追问；对可撤销的筛选动作，中置信度应先执行再允许用户纠正",
        "如果用户说“半导体相关的基金”“新能源相关基金”“AI 主题基金”，基金优先表示一级分类=基金研究，行业/主题词作为 keyword，不要按股票研究二级筛选追问",
        "如果用户说评分不低于、评分至少、80分以上，使用 scoreMin 参数，不要误用评级 rating",
        "如果用户只说疑似二级词，先调用 resolveSecondaryFilterIntent 判断可能一级方向，并追问用户确认",
        "如果用户同一句话已经明确指定一级分类，并要求先加载该一级的二级筛选，再指定二级值，则视为用户已确认二级筛选意图，不要再次追问",
        "已确认二级意图后，调用 loadSecondaryFilterOptions，传入一级筛选 primaryCategory",
        "等待 loadSecondaryFilterOptions 返回；如果 ok=false，不要继续设置二级筛选，应告知用户接口失败",
        "拿到接口返回候选项后，如果候选项包含用户指定的二级值，调用 setReportFilter 设置 secondaryCategory，并传入 secondaryConfirmedByUser=true",
        "最后调用 loadReports 刷新列表",
      ],
      availableWorkflows: [
        "按一级分类和二级分类联动筛选",
        "按券商、评级、日期区间、关键词组合筛选",
        "按日期、评级、热度或内部分数排序",
        "翻页并调整每页数量",
        "打开某篇研报详情",
        "直接导出当前页面可见表格，使用 exportVisibleReports",
        "选择并导出当前可见研报，导出前需要人工确认",
      ],
    }),
    [
      activeOperation,
      activeReportId,
      agent.isRunning,
      canInterrupt,
      filter,
      loading,
      knowledgeBase,
      operationLog,
      pagination,
      reports,
      secondaryLoading,
      selectedIds,
      showSecondaryFilter,
    ],
  );

  useAgentContext({
    description:
      "研报工作台当前状态。recentOperations 是用户、AI 和系统请求的结构化操作日志，回答“刚才做了什么”时必须优先依据它。learningMemory 中 userPreferences/userCorrections/userHabits 是当前用户记忆，只作为个人偏好参考；approvedSystemRules 是可执行的通用规则；pendingRuleCandidates 只能提示人工审核，不能当事实执行。筛选类自然语言优先调用 resolveReportFilterIntent 解析整体意图；返回 execute 直接执行，execute_with_note 先执行并说明假设，clarify 才追问。不要因为出现疑似二级词就默认追问；对筛选、排序、关键词检索这类可撤销动作，中置信度应先执行再允许用户纠正。注意：如果用户说“半导体相关的基金”“新能源相关基金”“AI 主题基金”，基金优先表示一级分类=基金研究，行业/主题词作为 keyword，不要按股票研究二级筛选追问；如果用户说评分不低于、评分至少、80分以上，使用 scoreMin 参数。若用户同一句话已经明确指定一级分类并要求先加载该一级的二级筛选，再指定二级值，例如“先加载股票研究的二级筛选，再只看电力设备”，则视为用户已确认二级筛选意图，不要再次追问；应先调用 loadSecondaryFilterOptions，等待接口返回候选项，确认包含该二级值后再 setReportFilter，并传 secondaryConfirmedByUser=true，最后 loadReports。用户明确纠错或表达偏好时，调用 recordLearningCase、recordUserMemory 或 proposeSystemRule 沉淀经验。",
    value: contextValue,
  });

  // 统一渲染 Copilot 工具调用结果，方便在对话里看到每个 action 的入参和返回值。
  useDefaultRenderTool({
    render: ({ name, status, parameters, result }) => (
      <div className="tool-call">
        <div>
          <strong>{status === "complete" ? "已执行" : "执行中"}</strong>
          <span>{name}</span>
        </div>
        {parameters && <code>{JSON.stringify(parameters)}</code>}
        {result && <small>{typeof result === "string" ? result : JSON.stringify(result)}</small>}
      </div>
    ),
  });

  // AI 可调用学习动作：保存当前用户的偏好、习惯或纠错。它只影响当前用户，不直接升级为全局规则。
  useFrontendTool({
    name: "recordUserMemory",
    description:
      "当用户明确表达个人偏好、习惯或对 AI 行为的纠正时调用。该记忆只影响当前用户，不代表所有用户的通用规则。",
    parameters: z.object({
      type: z.enum(["preference", "correction", "habit"]).describe("记忆类型。preference=偏好，correction=纠错，habit=行为习惯。"),
      key: z.string().describe("稳定的记忆键，例如 clarification_style、export_format、fund_theme_preference。"),
      value: z.string().describe("要保存的记忆内容，尽量具体但不要泄露敏感信息。"),
      evidence: z.string().optional().describe("来自用户原话或本次对话的证据。"),
      confidence: z.enum(["low", "medium", "high"]).optional().describe("置信度。"),
    }),
    handler: async (params) => {
      updateKnowledgeBase(
        (current) => addUserMemory(current, params),
        `记录用户记忆：${params.key}`,
        { type: params.type, key: params.key, value: params.value },
      );
      return `已记录当前用户记忆：${params.key}。`;
    },
  });

  // AI 可调用学习动作：把一次具体纠错变成案例，同时用启发式规则生成一个“待审核规则候选”。
  useFrontendTool({
    name: "recordLearningCase",
    description:
      "当用户指出 AI 判断不合理、追问过多、字段解析错误或工作流错误时调用。工具会记录案例，并提炼一个待人工审核的通用规则候选。",
    parameters: z.object({
      userText: z.string().describe("触发问题的用户原话。"),
      aiBehavior: z.string().describe("AI 当时做了什么，例如错误追问、误用字段、未调用接口。"),
      userFeedback: z.string().describe("用户反馈或纠错内容。"),
      finalFix: z.string().optional().describe("最终修正方式。"),
    }),
    handler: async (params) => {
      const candidate = extractRuleCandidateFromFeedback(params);
      updateKnowledgeBase(
        (current) => addRuleCandidate(recordLearningCase(current, params), candidate),
        `记录学习案例并生成规则候选：${candidate.ruleType}`,
        { case: params, candidate },
      );
      return {
        saved: true,
        candidate,
        nextStep: "候选规则不会自动生效，需要人工调用 approveSystemRule 或在界面上确认后才进入 approvedSystemRules。",
      };
    },
  });

  // AI 可调用学习动作：当模型能抽象出可复用规则时，先提交为候选，不自动生效。
  useFrontendTool({
    name: "proposeSystemRule",
    description:
      "把多次用户反馈中可复用的经验提炼成通用规则候选。候选规则默认 pending，不能直接覆盖当前工具事实或业务接口结果。",
    parameters: z.object({
      ruleType: z.enum(["parsing_rule", "domain_rule", "workflow_rule", "interaction_rule", "safety_rule"]).describe("规则类型。"),
      abstractRule: z.string().describe("抽象后的规则，必须说明适用边界。"),
      examples: z.array(z.string()).optional().describe("正例。"),
      counterExamples: z.array(z.string()).optional().describe("反例或不适用场景。"),
      evidence: z.string().optional().describe("来源证据。"),
      confidence: z.enum(["low", "medium", "high"]).optional().describe("置信度。"),
    }),
    handler: async (params) => {
      updateKnowledgeBase(
        (current) => addRuleCandidate(current, params),
        `生成待审核系统规则：${params.ruleType}`,
        { rule: params },
      );
      return "已生成待审核系统规则。该规则尚未生效，需要人工审核。";
    },
  });

  useFrontendTool({
    name: "approveSystemRule",
    description: "人工确认某条待审核规则后调用，使它进入 approvedSystemRules 并在后续对话中生效。",
    parameters: z.object({
      candidateId: z.string().describe("待审核规则 id。"),
    }),
    handler: async ({ candidateId }) => {
      updateKnowledgeBase(
        (current) => approveRuleCandidate(current, candidateId),
        `批准系统规则：${candidateId}`,
        { candidateId },
      );
      return `已批准规则 ${candidateId}。`;
    },
  });

  useFrontendTool({
    name: "dismissSystemRule",
    description: "人工驳回某条待审核规则候选时调用。",
    parameters: z.object({
      candidateId: z.string().describe("待审核规则 id。"),
    }),
    handler: async ({ candidateId }) => {
      updateKnowledgeBase(
        (current) => dismissRuleCandidate(current, candidateId),
        `驳回系统规则候选：${candidateId}`,
        { candidateId },
      );
      return `已驳回规则候选 ${candidateId}。`;
    },
  });

  useFrontendTool({
    name: "forgetUserMemory",
    description: "删除某条当前用户记忆。",
    parameters: z.object({
      memoryId: z.string().describe("用户记忆 id。"),
    }),
    handler: async ({ memoryId }) => {
      updateKnowledgeBase(
        (current) => forgetUserMemory(current, memoryId),
        `删除用户记忆：${memoryId}`,
        { memoryId },
      );
      return `已删除用户记忆 ${memoryId}。`;
    },
  });

  // AI 可调用动作 0：先做整体意图解析，用置信度决定直接执行、边执行边说明，还是追问。
  useFrontendTool({
    name: "resolveReportFilterIntent",
    description:
      "解析用户筛选类自然语言，返回 filterPatch、confidence 和 action。高置信 execute 直接 setReportFilter+loadReports；中置信 execute_with_note 先执行并说明假设；低置信 clarify 才追问。",
    parameters: z.object({
      userText: z.string().describe("用户完整原话。"),
    }),
    handler: async ({ userText }) => {
      const result = resolveReportFilterIntent(userText);
      pushActivity(`解析筛选意图：${userText}`, {
        actor: "ai",
        type: "resolveReportFilterIntent",
        status: "completed",
        payload: result,
      });
      return result;
    },
  });

  // AI 可调用动作 1：用金融相似词典做二级词提示，但不直接确认二级筛选。
  useFrontendTool({
    name: "resolveSecondaryFilterIntent",
    description:
      "当用户直接说可转债、新能源、电力设备、半导体、主动权益、固收+等疑似二级筛选词时，先调用本工具。它只返回可能的一级方向和追问建议，不能直接确认二级筛选值；但如果用户原话已经明确一级分类，可传 explicitPrimaryCategory，此时工具会判断是否已经不需要追问。",
    parameters: z.object({
      term: z.string().describe("用户提到的疑似二级筛选词或金融术语。"),
      userText: z.string().optional().describe("用户完整原话，便于审计。"),
      explicitPrimaryCategory: primaryEnum.optional().describe("用户原话中已经明确指定的一级分类，例如 股票研究。"),
    }),
    handler: async ({ term, explicitPrimaryCategory }) => {
      const result = resolveSecondaryTermHint(term, explicitPrimaryCategory);
      pushActivity(`识别疑似二级筛选：${term}`, {
        actor: "ai",
        type: "resolveSecondaryFilterIntent",
        status: "completed",
        payload: { term, result },
      });
      return {
        ...result,
        rule: result.needsClarification
          ? "二级筛选必须先追问用户确认；确认后再调用 loadSecondaryFilterOptions 请求候选项，然后 setReportFilter 时传 secondaryConfirmedByUser=true。"
          : "用户已在原话中明确一级分类和二级筛选意图，不需要再次追问；请调用 loadSecondaryFilterOptions，请求成功且候选项包含该二级值后，setReportFilter 时传 secondaryConfirmedByUser=true。",
      };
    },
  });

  // AI 可调用动作 1：先加载某个一级分类下的二级候选项。
  useFrontendTool({
    name: "loadSecondaryFilterOptions",
    description:
      "根据一级筛选模拟接口请求二级筛选候选项。用户只提到疑似二级条件时，必须先调用 resolveSecondaryFilterIntent 并追问确认，再调用本工具；如果用户原话已经明确一级分类并要求加载二级筛选，可直接调用本工具。",
    parameters: z.object({
      primaryCategory: primaryEnum.describe("一级筛选：全部、股票研究、基金研究、宏观策略、债券研究。"),
      reason: z.string().optional().describe("加载二级筛选的原因。"),
      simulateRequestCase: z
        .enum(["normal", "retrySuccess", "retryFail"])
        .optional()
        .describe("Demo 测试用：normal 正常；retrySuccess 第一次失败后重试成功；retryFail 两次都失败。"),
    }),
    handler: async ({ primaryCategory, reason, simulateRequestCase = "normal" }) => {
      const result = await fetchSecondaryOptions(primaryCategory, reason || "AI 需要二级筛选候选项", {
        simulateRequestCase,
        actor: "ai",
      });
      if (!result.ok) {
        return {
          ok: false,
          primaryCategory: result.primaryCategory,
          attempts: result.attempts,
          error: result.error,
          nextStep: "二级筛选接口重试后仍失败。请告知用户当前无法获取二级筛选项，不要继续 setReportFilter。",
        };
      }

      return {
        ok: true,
        primaryCategory: result.primaryCategory,
        secondaryOptions: result.secondaryOptions,
        attempts: result.attempts,
        nextStep: "如果用户已经明确确认要按某个二级方向筛选，且该二级值出现在 secondaryOptions 中，可以调用 setReportFilter 设置 secondaryCategory，并传入 secondaryConfirmedByUser=true，然后调用 loadReports。",
      };
    },
  });

  // AI 可调用动作 2：只更新筛选/排序/分页状态，不直接查表，便于组合多步操作。
  useFrontendTool({
    name: "setReportFilter",
    description:
      "设置研报筛选、排序和分页条件。若设置具体 secondaryCategory，必须确保它来自当前 primaryCategory 的二级候选项，并且用户已经明确确认 secondaryConfirmedByUser=true。",
    parameters: z.object({
      keyword: z.string().optional().describe("关键词，例如 储能、AI、ETF、利率。空字符串表示不按关键词筛选。"),
      broker: brokerEnum.optional().describe("券商筛选。"),
      rating: ratingEnum.optional().describe("评级筛选。"),
      risk: riskEnum.optional().describe("风险等级筛选：全部、低、中、高。"),
      analyst: analystEnum.optional().describe("分析师筛选。"),
      primaryCategory: primaryEnum.optional().describe("一级筛选。切换一级筛选后建议先调用 loadSecondaryFilterOptions。"),
      secondaryCategory: z.string().optional().describe("二级筛选，必须是当前一级筛选返回的候选项。"),
      secondaryConfirmedByUser: z
        .boolean()
        .optional()
        .describe("只有用户已经明确确认要按该二级方向筛选时才传 true。没有确认时禁止设置具体二级筛选。"),
      dateFrom: z.string().optional().describe("开始日期，格式 YYYY-MM-DD。"),
      dateTo: z.string().optional().describe("结束日期，格式 YYYY-MM-DD。"),
      scoreMin: z.union([z.number(), z.string()]).optional().describe("最低内部分数。"),
      readCountMin: z.union([z.number(), z.string()]).optional().describe("最低热度/阅读量。"),
      orderBy: orderFieldEnum.optional().describe("排序字段：date/rating/score/readCount。"),
      direction: directionEnum.optional().describe("排序方向：asc 升序，desc 降序。"),
      page: z.number().int().positive().optional().describe("页码，从 1 开始。"),
      pageSize: z.union([z.literal(10), z.literal(20), z.literal(50), z.enum(["10", "20", "50"])]).optional().describe("每页条数。"),
    }),
    handler: async (params) => {
      const { secondaryConfirmedByUser, ...filterParams } = params;
      const pageSize = params.pageSize ? Number(params.pageSize) : undefined;
      const primaryCategory = params.primaryCategory || filterRef.current.primaryCategory;
      const availableSecondary = secondaryOptionsRef.current;
      let secondaryCategory = params.secondaryCategory;

      if (params.secondaryCategory && params.secondaryCategory !== "全部" && !secondaryConfirmedByUser) {
        return `二级筛选「${params.secondaryCategory}」不能直接确认。请先向用户追问是否按该二级方向筛选；用户确认后，再请求二级候选项并传 secondaryConfirmedByUser=true。`;
      }

      // 一级分类变化后，旧二级分类通常已经不属于新的一级分类；但如果本次同时传入了已确认且合法的新二级值，应保留它。
      if (
        params.primaryCategory &&
        params.primaryCategory !== filterRef.current.primaryCategory &&
        (!params.secondaryCategory || params.secondaryCategory === "全部")
      ) {
        secondaryCategory = "全部";
      }

      // 如果 AI 直接给了二级分类，但前端还没加载对应候选项，就拒绝执行并提示先取候选项。
      if (secondaryCategory && !availableSecondary.includes(secondaryCategory)) {
        return `二级筛选「${secondaryCategory}」不在当前一级「${primaryCategory}」的候选项中，请先调用 loadSecondaryFilterOptions。`;
      }

      const nextFilter = setCurrentFilter({
        ...filterRef.current,
        ...filterParams,
        pageSize: pageSize || filterRef.current.pageSize,
        primaryCategory,
        secondaryCategory: secondaryCategory ?? filterRef.current.secondaryCategory,
        page: params.page || 1,
      });

      pushActivity(`更新筛选条件：${JSON.stringify(nextFilter)}`, {
        actor: "ai",
        type: "setReportFilter",
        status: "completed",
        payload: { filter: nextFilter },
      });
      return `筛选条件已更新为 ${JSON.stringify(nextFilter)}`;
    },
  });

  // AI 可调用动作 3：按当前条件刷新列表。
  useFrontendTool({
    name: "loadReports",
    description: "按当前筛选条件加载研报列表。设置筛选后通常应调用此工具刷新表格。",
    parameters: z.object({
      reason: z.string().optional().describe("本次加载原因，便于审计展示。"),
    }),
    handler: async ({ reason }) => {
      const result = await loadReportsWithCurrentFilter(reason || "AI 请求刷新列表", { actor: "ai" });
      return `已加载 ${result.rows.length} 条当前页数据，总计 ${result.total} 条。`;
    },
  });

  // AI 可调用动作 4：清空条件并加载全部数据。
  useFrontendTool({
    name: "clearReportFilter",
    description: "清空所有筛选条件，并恢复默认按日期降序、第 1 页、每页 10 条，然后加载全部研报数据。",
    parameters: z.object({}),
    handler: async () => {
      const result = await clearFiltersAndLoad("AI 清空条件后加载全部数据", { actor: "ai" });
      return `筛选条件已清空，已加载全部研报数据，总计 ${result.total} 条。`;
    },
  });

  // AI 可调用动作 5：打开当前可见列表中的某篇研报详情。
  useFrontendTool({
    name: "openReportDetail",
    description: "打开某篇研报详情。可以通过 reportId 打开，也可以通过 position 打开当前可见列表中的第几篇。",
    parameters: z.object({
      reportId: z.string().optional().describe("研报 id，例如 r-001。"),
      position: z.number().int().positive().optional().describe("当前可见列表中的序号，从 1 开始。"),
    }),
    handler: async ({ reportId, position }) => {
      const currentReports = reportsRef.current;
      const target = reportId ? currentReports.find((item) => item.id === reportId) : currentReports[(position || 1) - 1];
      if (!target) return "没有找到对应研报，请先加载列表或换一个序号。";
      setActiveReportId(target.id);
      pushActivity(`打开详情：${target.title}`, {
        actor: "ai",
        type: "openReportDetail",
        status: "completed",
        payload: { reportId: target.id, title: target.title },
      });
      return `已打开「${target.title}」`;
    },
  });

  // AI 可调用动作 6：选择当前页研报，为后续导出等敏感动作做准备。
  useFrontendTool({
    name: "selectReports",
    description: "选中研报。可以选中所有当前可见研报，也可以按 ids 精确选中。",
    parameters: z.object({
      mode: z.enum(["allVisible", "ids"]).describe("allVisible 表示选中当前所有可见报告，ids 表示按 reportIds 选择。"),
      reportIds: z.array(z.string()).optional().describe("mode=ids 时使用的研报 id 列表。"),
    }),
    handler: async ({ mode, reportIds = [] }) => {
      const currentReports = reportsRef.current;
      const ids = mode === "allVisible" ? currentReports.map((item) => item.id) : reportIds;
      const validIds = ids.filter((id) => currentReports.some((item) => item.id === id));
      selectedIdsRef.current = validIds;
      setSelectedIds(validIds);
      pushActivity(`选中 ${validIds.length} 篇研报`, {
        actor: "ai",
        type: "selectReports",
        status: "completed",
        payload: { mode, reportIds: validIds },
      });
      return `已选中 ${validIds.length} 篇研报`;
    },
  });

  // AI 可调用动作 7：导出前必须让用户确认，避免 AI 直接执行敏感动作。
  useFrontendTool({
    name: "exportSelectedReports",
    description: "导出当前选中的研报。这是敏感动作，前端会要求用户确认。",
    parameters: z.object({
      format: z.enum(["csv"]).default("csv").describe("导出格式。当前 Demo 实际下载 CSV。"),
    }),
    handler: async ({ format }) => {
      const selectedIdsSnapshot = selectedIdsRef.current;
      const selectedReports = reportsRef.current.filter((item) => selectedIdsSnapshot.includes(item.id));
      if (selectedIdsSnapshot.length === 0) return "没有选中的研报，无法导出。";
      if (selectedReports.length === 0) return "选中的研报不在当前可见页，请重新选择当前页研报后再导出。";
      const ok = window.confirm(`确认导出 ${selectedReports.length} 篇研报为 ${format.toUpperCase()} 吗？`);
      if (!ok) return "用户取消导出。";
      downloadReportTableCsv(selectedReports, makeReportCsvFilename("选中项"));
      pushActivity(`已确认导出：${selectedReports.length} 篇，格式 ${format}`, {
        actor: "ai",
        type: "exportSelectedReports",
        status: "completed",
        payload: { format, count: selectedReports.length },
      });
      return `已导出 ${selectedReports.length} 篇研报为 ${format.toUpperCase()}。`;
    },
  });

  // AI 可调用动作 8：用户说“导出当前页/当前表格”时，直接导出当前可见数据，不需要先选中。
  useFrontendTool({
    name: "exportVisibleReports",
    description: "直接导出当前页面、当前页或当前可见表格里的研报。用户要求导出当前页面数据时优先调用本工具，不要先调用 selectReports。",
    parameters: z.object({
      format: z.enum(["csv"]).default("csv").describe("导出格式。当前 Demo 实际下载 CSV。"),
    }),
    handler: async ({ format }) => {
      const currentReports = reportsRef.current;
      if (currentReports.length === 0) return "当前页面没有可导出的研报。";
      downloadReportTableCsv(currentReports, makeReportCsvFilename("当前页"));
      pushActivity(`AI 导出当前页面表格：${currentReports.length} 条，格式 ${format}`, {
        actor: "ai",
        type: "exportVisibleReports",
        status: "completed",
        payload: { format, count: currentReports.length },
      });
      return `已导出当前页面 ${currentReports.length} 条研报为 ${format.toUpperCase()}。`;
    },
  });

  // 手动切换一级筛选时只加载二级候选项，不自动查表，用户可以继续补充其他条件后再加载。
  async function updatePrimaryCategory(value) {
    await fetchSecondaryOptions(value, "手动切换一级筛选", { actor: "user" });
  }

  // 所有筛选控件共用的更新函数。除翻页外，任何条件变化都会回到第一页。
  function updateFilterField(key, value) {
    const nextValue = key === "pageSize" ? Number(value) : value;
    const nextFilter = setCurrentFilter({ ...filterRef.current, [key]: nextValue, page: key === "page" ? Number(value) : 1 });
    pushActivity(`手动更新筛选字段：${key}=${nextValue}`, {
      actor: "user",
      type: "setFilterField",
      status: "completed",
      payload: { key, value: nextValue, filter: nextFilter },
    });
  }

  async function loadManually() {
    await loadReportsWithCurrentFilter("手动加载", { actor: "user" });
  }

  async function clearManually() {
    await clearFiltersAndLoad("手动清空后加载全部数据", { actor: "user" });
  }

  // 导出动作复用同一套 CSV 生成逻辑，避免手动导出和 AI 导出字段不一致。
  function downloadReportTableCsv(sourceReports, filename, pageInfo = filterRef.current) {
    const header = ["序号", "日期", "标题", "券商", "一级分类", "二级分类", "评级", "分数", "热度", "分析师", "风险"];
    const body = sourceReports.map((report, index) => [
      (pageInfo.page - 1) * pageInfo.pageSize + index + 1,
      report.date,
      report.title,
      report.broker,
      report.primaryCategory,
      report.secondaryCategory,
      report.rating,
      report.score,
      report.readCount,
      report.analyst,
      report.risk,
    ]);

    downloadCsv(filename, [header, ...body]);
  }

  function makeReportCsvFilename(scope = "当前页") {
    return `研报表格_${scope}_第${filterRef.current.page}页_${new Date().toISOString().slice(0, 10)}.csv`;
  }

  function exportVisibleTable() {
    const currentReports = reportsRef.current;
    if (currentReports.length === 0) {
      pushActivity("导出表格失败：当前表格无数据", {
        actor: "user",
        type: "exportVisibleReports",
        status: "failed",
        payload: { count: 0 },
      });
      return;
    }

    downloadReportTableCsv(currentReports, makeReportCsvFilename());
    pushActivity(`导出当前表格：${currentReports.length} 条`, {
      actor: "user",
      type: "exportVisibleReports",
      status: "completed",
      payload: { count: currentReports.length },
    });
  }

  async function goToPage(page) {
    setCurrentFilter({ ...filterRef.current, page });
    await loadReportsWithCurrentFilter(`翻到第 ${page} 页`, { actor: "user" });
  }

  function toggleSelected(id) {
    const wasSelected = selectedIdsRef.current.includes(id);
    const nextIds = wasSelected ? selectedIdsRef.current.filter((item) => item !== id) : [...selectedIdsRef.current, id];
    selectedIdsRef.current = nextIds;
    setSelectedIds(nextIds);
    pushActivity(`手动${wasSelected ? "取消选中" : "选中"}研报：${id}`, {
      actor: "user",
      type: "toggleReportSelection",
      status: "completed",
      payload: { reportId: id, selectedIds: nextIds },
    });
  }

  // 排序放在表头中，点击同一列会在升序/降序之间切换。
  async function sortByColumn(orderBy) {
    const direction = filter.orderBy === orderBy && filter.direction === "desc" ? "asc" : "desc";
    setCurrentFilter({ ...filterRef.current, orderBy, direction, page: 1 });
    await loadReportsWithCurrentFilter(`按${orderBy}表头排序`, { actor: "user" });
  }

  function renderSortLabel(orderBy) {
    if (filter.orderBy !== orderBy) return "";
    return filter.direction === "asc" ? " ↑" : " ↓";
  }

  function approveCandidateFromPanel(candidateId) {
    updateKnowledgeBase(
      (current) => approveRuleCandidate(current, candidateId),
      `界面批准系统规则：${candidateId}`,
      { candidateId },
    );
  }

  function dismissCandidateFromPanel(candidateId) {
    updateKnowledgeBase(
      (current) => dismissRuleCandidate(current, candidateId),
      `界面驳回系统规则候选：${candidateId}`,
      { candidateId },
    );
  }

  function resetLearningPanel() {
    const next = resetKnowledgeBase();
    knowledgeBaseRef.current = next;
    setKnowledgeBase(next);
    pushActivity("重置用户记忆与规则库", {
      actor: "user",
      type: "resetLearningMemory",
      status: "completed",
      payload: { approvedRules: next.systemRules.approved.length },
    });
  }

  return (
    <div className="app-shell">
      <div className="workspace">
        <div className="brand-row">
          <div>
            <h1>研报工作台</h1>
            <p>CopilotKit 状态派 Demo：复杂筛选、二级联动、分页与动作审计</p>
          </div>
          <span className="runtime-pill">AG-UI Runtime</span>
        </div>

        <nav className="page-tabs" aria-label="页面切换">
          <button
            type="button"
            className={activeTab === "workbench" ? "active" : ""}
            onClick={() => setActiveTab("workbench")}
          >
            研报工作台
          </button>
          <button
            type="button"
            className={activeTab === "learning" ? "active" : ""}
            onClick={() => setActiveTab("learning")}
          >
            知识沉淀
            <span>{knowledgeBase.systemRules.candidates.length}</span>
          </button>
        </nav>

        {activeTab === "workbench" && (
          <>
            {canInterrupt && (
              <section className="interrupt-strip" aria-live="polite">
                <div>
                  <strong>{agent.isRunning ? "AI 正在执行" : "操作执行中"}</strong>
                  <span>{activeOperation?.label || "等待模型响应或工具返回"}</span>
                </div>
                <button type="button" onClick={interruptCurrentOperation}>
                  打断当前操作
                </button>
              </section>
            )}

            <section className={`toolbar toolbar-advanced ${showSecondaryFilter ? "has-secondary" : "no-secondary"}`}>
          <label className="filter-keyword">
            关键词
            <input
              value={filter.keyword}
              onChange={(event) => updateFilterField("keyword", event.target.value)}
              placeholder="储能 / ETF / 利率 / AI"
            />
          </label>
          <label className="filter-primary">
            一级分类
            <select value={filter.primaryCategory} onChange={(event) => updatePrimaryCategory(event.target.value)}>
              {PRIMARY_OPTIONS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          {showSecondaryFilter && (
            <label className="filter-secondary">
              二级分类
              <select
                value={filter.secondaryCategory}
                onChange={(event) => updateFilterField("secondaryCategory", event.target.value)}
                disabled={secondaryLoading}
              >
                {secondaryOptions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            券商
            <select value={filter.broker} onChange={(event) => updateFilterField("broker", event.target.value)}>
              {BROKERS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            评级
            <select value={filter.rating} onChange={(event) => updateFilterField("rating", event.target.value)}>
              {RATINGS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            风险
            <select value={filter.risk} onChange={(event) => updateFilterField("risk", event.target.value)}>
              {RISKS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            分析师
            <select value={filter.analyst} onChange={(event) => updateFilterField("analyst", event.target.value)}>
              {ANALYSTS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            开始日期
            <input type="date" value={filter.dateFrom} onChange={(event) => updateFilterField("dateFrom", event.target.value)} />
          </label>
          <label>
            结束日期
            <input type="date" value={filter.dateTo} onChange={(event) => updateFilterField("dateTo", event.target.value)} />
          </label>
          <label>
            最低评分
            <input
              type="number"
              min="0"
              max="100"
              value={filter.scoreMin}
              onChange={(event) => updateFilterField("scoreMin", event.target.value)}
              placeholder="如 80"
            />
          </label>
          <label>
            最低热度
            <input
              type="number"
              min="0"
              value={filter.readCountMin}
              onChange={(event) => updateFilterField("readCountMin", event.target.value)}
              placeholder="如 5000"
            />
          </label>
          <label>
            每页
            <select value={filter.pageSize} onChange={(event) => updateFilterField("pageSize", event.target.value)}>
              {PAGE_SIZES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <div className="filter-actions">
            <button className="filter-clear" onClick={clearManually} disabled={loading || secondaryLoading}>
              清空
            </button>
            <button className="filter-export" onClick={exportVisibleTable} disabled={loading || reports.length === 0}>
              导出表格
            </button>
            <button className="filter-submit" onClick={loadManually} disabled={loading || secondaryLoading}>
              {loading ? "加载中" : "加载"}
            </button>
          </div>
            </section>

            <section className="status-strip">
          <div>
            <strong>{pagination.total}</strong>
            <span>匹配研报</span>
          </div>
          <div>
            <strong>{reports.length}</strong>
            <span>当前页</span>
          </div>
          <div>
            <strong>{selectedIds.length}</strong>
            <span>已选中</span>
          </div>
          <div>
            <strong>{filter.primaryCategory}</strong>
            <span>{secondaryLoading ? "二级加载中" : filter.secondaryCategory}</span>
          </div>
            </section>

            <main className="content-grid">
          <section className="table-wrap">
            {loading ? (
              <div className="loading-box">正在加载研报数据...</div>
            ) : reports.length === 0 ? (
              <div className="empty-box">暂无数据。可以调整筛选条件，或让 Copilot 帮你重新加载。</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>选择</th>
                    <th>
                      <button className="th-sort" onClick={() => sortByColumn("date")}>
                        日期{renderSortLabel("date")}
                      </button>
                    </th>
                    <th>标题</th>
                    <th>券商</th>
                    <th>分类</th>
                    <th>
                      <button className="th-sort" onClick={() => sortByColumn("rating")}>
                        评级{renderSortLabel("rating")}
                      </button>
                    </th>
                    <th>
                      <button className="th-sort" onClick={() => sortByColumn("score")}>
                        分数{renderSortLabel("score")}
                      </button>
                    </th>
                    <th>
                      <button className="th-sort" onClick={() => sortByColumn("readCount")}>
                        热度{renderSortLabel("readCount")}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((report, index) => (
                    <tr key={report.id} className={activeReportId === report.id ? "active-row" : ""}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(report.id)}
                          onChange={() => toggleSelected(report.id)}
                        />
                      </td>
                      <td>{report.date}</td>
                      <td>
                        <button
                          className="link-button"
                          onClick={() => {
                            setActiveReportId(report.id);
                            pushActivity(`手动打开详情：${report.title}`, {
                              actor: "user",
                              type: "openReportDetail",
                              status: "completed",
                              payload: { reportId: report.id, title: report.title },
                            });
                          }}
                        >
                          {(pagination.page - 1) * pagination.pageSize + index + 1}. {report.title}
                        </button>
                        <div className="row-subtitle">{report.analyst} · 风险{report.risk}</div>
                      </td>
                      <td>{report.broker}</td>
                      <td>
                        {report.primaryCategory}
                        <div className="row-subtitle">{report.secondaryCategory}</div>
                      </td>
                      <td>
                        <span className={ratingClass[report.rating] || "rating"}>{report.rating}</span>
                      </td>
                      <td>{report.score}</td>
                      <td>{report.readCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="pagination-bar">
              <button onClick={() => goToPage(Math.max(1, pagination.page - 1))} disabled={loading || pagination.page <= 1}>
                上一页
              </button>
              <span>
                第 {pagination.page} / {pagination.totalPages} 页
              </span>
              <button
                onClick={() => goToPage(Math.min(pagination.totalPages, pagination.page + 1))}
                disabled={loading || pagination.page >= pagination.totalPages}
              >
                下一页
              </button>
            </div>
          </section>

          <section className="detail-panel">
            <h2>研报详情</h2>
            {activeReport ? (
              <>
                <div className="detail-meta">
                  <span>{activeReport.date}</span>
                  <span>{activeReport.broker}</span>
                  <span>{activeReport.analyst}</span>
                </div>
                <h3>{activeReport.title}</h3>
                <div className="detail-tags">
                  <span className={ratingClass[activeReport.rating] || "rating"}>{activeReport.rating}</span>
                  <span>{activeReport.primaryCategory}</span>
                  <span>{activeReport.secondaryCategory}</span>
                  <span>分数 {activeReport.score}</span>
                </div>
                <p>{activeReport.summary}</p>
              </>
            ) : (
              <p className="muted">尚未打开研报。可以让 Copilot “打开第一篇报告详情”。</p>
            )}
          </section>
            </main>

            <section className="activity-log">
              <h2>动作审计</h2>
              {activity.map((item, index) => (
                <div key={`${item}-${index}`}>{item}</div>
              ))}
            </section>
          </>
        )}

        {activeTab === "learning" && (
          <section className="learning-panel">
          <div className="section-title-row">
            <div>
              <h2>知识沉淀</h2>
              <p>用户记忆影响当前用户；已批准系统规则才会作为通用规则进入 Copilot 上下文。</p>
            </div>
            <button type="button" className="ghost-button" onClick={resetLearningPanel}>
              重置
            </button>
          </div>

          <div className="learning-grid">
            <article>
              <strong>用户记忆</strong>
              <span>
                {knowledgeBase.userMemory.preferences.length + knowledgeBase.userMemory.corrections.length + knowledgeBase.userMemory.habits.length} 条
              </span>
              {[...knowledgeBase.userMemory.preferences, ...knowledgeBase.userMemory.corrections, ...knowledgeBase.userMemory.habits]
                .slice(0, 4)
                .map((item) => (
                  <p key={item.id}>{item.value}</p>
                ))}
            </article>

            <article>
              <strong>已生效系统规则</strong>
              <span>{knowledgeBase.systemRules.approved.length} 条</span>
              {knowledgeBase.systemRules.approved.slice(0, 4).map((item) => (
                <p key={item.id}>{item.abstractRule}</p>
              ))}
            </article>

            <article>
              <strong>待审核规则</strong>
              <span>{knowledgeBase.systemRules.candidates.length} 条</span>
              {knowledgeBase.systemRules.candidates.slice(0, 3).map((item) => (
                <div className="candidate-rule" key={item.id}>
                  <p>{item.abstractRule}</p>
                  <div>
                    <button type="button" onClick={() => approveCandidateFromPanel(item.id)}>
                      批准
                    </button>
                    <button type="button" onClick={() => dismissCandidateFromPanel(item.id)}>
                      驳回
                    </button>
                  </div>
                </div>
              ))}
              {knowledgeBase.systemRules.candidates.length === 0 && <p>暂无待审核规则。</p>}
            </article>
          </div>
          </section>
        )}
      </div>

      {copilotStarted ? (
        <CopilotPopup
          defaultOpen={true}
          labels={{
            modalHeaderTitle: "研报 Copilot",
            welcomeMessageText:
              "我可以控制当前研报工作台。试试：先加载股票研究的二级筛选，再只看电力设备里华泰证券的买入报告，按热度降序。",
          }}
        />
      ) : (
        // CopilotPopup 在当前版本会默认展示欢迎窗，所以首屏先只挂载一个自定义入口。
        // 用户点击后再挂载真正的 CopilotPopup，既保留功能，也避免遮挡业务区。
        <button
          className="copilot-launcher"
          type="button"
          title="打开研报 Copilot"
          aria-label="打开研报 Copilot"
          onClick={() => setCopilotStarted(true)}
        >
          AI
        </button>
      )}
    </div>
  );
}
