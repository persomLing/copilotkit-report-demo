import { useMemo, useRef, useState } from "react";
import { CopilotPopup, useAgentContext, useDefaultRenderTool, useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import {
  BROKERS,
  DIRECTIONS,
  ORDER_FIELDS,
  PAGE_SIZES,
  PRIMARY_OPTIONS,
  RATINGS,
  delay,
  getSecondaryOptions,
  normalizeFilter,
  queryReports,
  requestSecondaryOptions,
  resolveSecondaryTermHint,
} from "./reportStore.js";

// 页面筛选条件的唯一默认值。所有“清空条件”和首次加载都从这里恢复，避免手动维护多份默认状态。
const defaultFilter = normalizeFilter({
  keyword: "",
  broker: "全部",
  rating: "全部",
  primaryCategory: "全部",
  secondaryCategory: "全部",
  dateFrom: "",
  dateTo: "",
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
  const [copilotStarted, setCopilotStarted] = useState(false);

  const activeReport = reports.find((item) => item.id === activeReportId) || null;
  const showSecondaryFilter = filter.primaryCategory !== "全部";

  // 页面操作流水只保留最近几条，用来观察 AI 和人工操作到底执行了什么。
  function pushActivity(message) {
    setActivity((items) => [message, ...items].slice(0, 8));
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
    setSecondaryLoading(true);
    pushActivity(`请求二级筛选接口：一级=${safePrimary}${reason ? `，原因=${reason}` : ""}`);

    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          pushActivity(`等待二级筛选接口返回：第 ${attempt} 次请求`);
          const nextOptions = await requestSecondaryOptions(safePrimary, { attempt, simulateRequestCase });
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

          pushActivity(`二级筛选已加载：${nextOptions.join(" / ")}`);
          return {
            ok: true,
            primaryCategory: safePrimary,
            secondaryOptions: nextOptions,
            attempts: attempt,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt === 1) {
            pushActivity(`二级筛选接口失败：${message}，自动重试一次`);
            continue;
          }

          pushActivity(`二级筛选接口连续失败：${message}`);
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
  async function loadReportsWithCurrentFilter(reason = "刷新列表") {
    setLoading(true);
    pushActivity(`开始加载研报：${reason}`);
    await delay(420);
    const result = queryReports(filterRef.current);
    applyQueryResult(result);
    setLoading(false);
    pushActivity(`加载完成：共 ${result.total} 条，当前第 ${result.page}/${result.totalPages} 页`);
    return result;
  }

  // 清空条件的业务语义是“回到全部数据”，所以会同时重置一级/二级筛选和分页。
  async function clearFiltersAndLoad(reason = "清空条件后加载全部数据") {
    const defaultSecondaryOptions = getSecondaryOptions("全部");
    secondaryOptionsRef.current = defaultSecondaryOptions;
    setSecondaryOptions(defaultSecondaryOptions);
    setCurrentFilter(defaultFilter);
    pushActivity("清空筛选条件");
    return loadReportsWithCurrentFilter(reason);
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
        primaryCategory: item.primaryCategory,
        secondaryCategory: item.secondaryCategory,
        analyst: item.analyst,
        score: item.score,
        readCount: item.readCount,
        date: item.date,
      })),
      selectedIds,
      activeReportId,
      requiredWorkflowForSecondaryFilter: [
        "先调用 resolveSecondaryFilterIntent 判断疑似二级词属于哪个一级方向，并追问用户确认",
        "用户确认后再调用 loadSecondaryFilterOptions，传入一级筛选 primaryCategory",
        "等待 loadSecondaryFilterOptions 返回；如果 ok=false，不要继续设置二级筛选，应告知用户接口失败",
        "拿到接口返回候选项后，调用 setReportFilter 设置 secondaryCategory，并传入 secondaryConfirmedByUser=true",
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
    [activeReportId, filter, loading, pagination, reports, secondaryLoading, selectedIds, showSecondaryFilter],
  );

  useAgentContext({
    description:
      "研报工作台当前状态。注意：如果用户提到疑似二级筛选，例如新能源、半导体、主动权益、利率债、可转债，不能直接确认二级值；必须先调用 resolveSecondaryFilterIntent 生成金融语义判断和追问，等用户确认后，再调用 loadSecondaryFilterOptions 模拟接口请求二级候选项，最后才能 setReportFilter 和 loadReports。",
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

  // AI 可调用动作 0：用金融相似词典做意图提示，但不直接确认二级筛选。
  useFrontendTool({
    name: "resolveSecondaryFilterIntent",
    description:
      "当用户直接说可转债、新能源、半导体、主动权益、固收+等疑似二级筛选词时，先调用本工具。它只返回可能的一级方向和追问建议，不能直接确认二级筛选值。",
    parameters: z.object({
      term: z.string().describe("用户提到的疑似二级筛选词或金融术语。"),
      userText: z.string().optional().describe("用户完整原话，便于审计。"),
    }),
    handler: async ({ term }) => {
      const result = resolveSecondaryTermHint(term);
      pushActivity(`识别疑似二级筛选：${term}`);
      return {
        ...result,
        rule: "二级筛选必须先追问用户确认；确认后再调用 loadSecondaryFilterOptions 请求候选项，然后 setReportFilter 时传 secondaryConfirmedByUser=true。",
      };
    },
  });

  // AI 可调用动作 1：先加载某个一级分类下的二级候选项。
  useFrontendTool({
    name: "loadSecondaryFilterOptions",
    description:
      "根据一级筛选模拟接口请求二级筛选候选项。用户提到疑似二级条件时，必须先调用 resolveSecondaryFilterIntent 并追问确认，再调用本工具。",
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
        nextStep: "只有用户已经明确确认要按某个二级方向筛选时，才可以调用 setReportFilter 设置 secondaryCategory，并传入 secondaryConfirmedByUser=true，然后调用 loadReports。",
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
      primaryCategory: primaryEnum.optional().describe("一级筛选。切换一级筛选后建议先调用 loadSecondaryFilterOptions。"),
      secondaryCategory: z.string().optional().describe("二级筛选，必须是当前一级筛选返回的候选项。"),
      secondaryConfirmedByUser: z
        .boolean()
        .optional()
        .describe("只有用户已经明确确认要按该二级方向筛选时才传 true。没有确认时禁止设置具体二级筛选。"),
      dateFrom: z.string().optional().describe("开始日期，格式 YYYY-MM-DD。"),
      dateTo: z.string().optional().describe("结束日期，格式 YYYY-MM-DD。"),
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

      // 一级分类变化后，旧二级分类通常已经不属于新的一级分类，先归回“全部”。
      if (params.primaryCategory && params.primaryCategory !== filterRef.current.primaryCategory) {
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

      pushActivity(`更新筛选条件：${JSON.stringify(nextFilter)}`);
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
      const result = await loadReportsWithCurrentFilter(reason || "AI 请求刷新列表");
      return `已加载 ${result.rows.length} 条当前页数据，总计 ${result.total} 条。`;
    },
  });

  // AI 可调用动作 4：清空条件并加载全部数据。
  useFrontendTool({
    name: "clearReportFilter",
    description: "清空所有筛选条件，并恢复默认按日期降序、第 1 页、每页 10 条，然后加载全部研报数据。",
    parameters: z.object({}),
    handler: async () => {
      const result = await clearFiltersAndLoad("AI 清空条件后加载全部数据");
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
      pushActivity(`打开详情：${target.title}`);
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
      pushActivity(`选中 ${validIds.length} 篇研报`);
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
      pushActivity(`已确认导出：${selectedReports.length} 篇，格式 ${format}`);
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
      pushActivity(`AI 导出当前页面表格：${currentReports.length} 条，格式 ${format}`);
      return `已导出当前页面 ${currentReports.length} 条研报为 ${format.toUpperCase()}。`;
    },
  });

  // 手动切换一级筛选时只加载二级候选项，不自动查表，用户可以继续补充其他条件后再加载。
  async function updatePrimaryCategory(value) {
    await fetchSecondaryOptions(value, "手动切换一级筛选");
  }

  // 所有筛选控件共用的更新函数。除翻页外，任何条件变化都会回到第一页。
  function updateFilterField(key, value) {
    const nextValue = key === "pageSize" ? Number(value) : value;
    setCurrentFilter({ ...filterRef.current, [key]: nextValue, page: key === "page" ? Number(value) : 1 });
  }

  async function loadManually() {
    await loadReportsWithCurrentFilter("手动加载");
  }

  async function clearManually() {
    await clearFiltersAndLoad("手动清空后加载全部数据");
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
      pushActivity("导出表格失败：当前表格无数据");
      return;
    }

    downloadReportTableCsv(currentReports, makeReportCsvFilename());
    pushActivity(`导出当前表格：${currentReports.length} 条`);
  }

  async function goToPage(page) {
    setCurrentFilter({ ...filterRef.current, page });
    await loadReportsWithCurrentFilter(`翻到第 ${page} 页`);
  }

  function toggleSelected(id) {
    setSelectedIds((ids) => {
      const nextIds = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
      selectedIdsRef.current = nextIds;
      return nextIds;
    });
  }

  // 排序放在表头中，点击同一列会在升序/降序之间切换。
  async function sortByColumn(orderBy) {
    const direction = filter.orderBy === orderBy && filter.direction === "desc" ? "asc" : "desc";
    setCurrentFilter({ ...filterRef.current, orderBy, direction, page: 1 });
    await loadReportsWithCurrentFilter(`按${orderBy}表头排序`);
  }

  function renderSortLabel(orderBy) {
    if (filter.orderBy !== orderBy) return "";
    return filter.direction === "asc" ? " ↑" : " ↓";
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
            开始日期
            <input type="date" value={filter.dateFrom} onChange={(event) => updateFilterField("dateFrom", event.target.value)} />
          </label>
          <label>
            结束日期
            <input type="date" value={filter.dateTo} onChange={(event) => updateFilterField("dateTo", event.target.value)} />
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
                        <button className="link-button" onClick={() => setActiveReportId(report.id)}>
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
