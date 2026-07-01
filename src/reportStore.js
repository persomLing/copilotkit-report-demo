export const BROKERS = ["全部", "中信证券", "华泰证券", "国泰君安", "广发证券", "招商证券", "申万宏源"];
export const RATINGS = ["全部", "强烈推荐", "超配", "买入", "增持", "中性", "减持"];
export const ORDER_FIELDS = ["date", "rating", "score", "readCount"];
export const DIRECTIONS = ["asc", "desc"];
export const PAGE_SIZES = [10, 20, 50];

// 一级/二级筛选的配置源。真实项目里这块通常来自接口或字典服务。
export const PRIMARY_FILTERS = {
  全部: ["全部"],
  股票研究: ["全部", "新能源", "人工智能", "半导体", "医药生物", "银行", "消费电子", "电力设备", "机器人"],
  基金研究: ["全部", "主动权益", "指数基金", "固收+", "FOF", "QDII", "量化策略"],
  宏观策略: ["全部", "国内宏观", "海外宏观", "资产配置", "行业比较", "市场策略"],
  债券研究: ["全部", "利率债", "信用债", "可转债", "城投债", "地产债"],
};

export const PRIMARY_OPTIONS = Object.keys(PRIMARY_FILTERS);

// 给 AI 的金融背景词典只提供“可能属于哪个一级方向”的提示，不直接暴露真实二级筛选值。
// 真实项目里这层可以来自搜索、向量召回或业务词库接口，用来决定该追问什么。
export const SECONDARY_TERM_HINTS = [
  { terms: ["可转债", "转债", "可转换债"], primaryCandidates: ["债券研究"], askLabel: "债券研究下的可转债方向" },
  { terms: ["信用债", "产业债", "信用利差"], primaryCandidates: ["债券研究"], askLabel: "债券研究下的信用债方向" },
  { terms: ["利率债", "国债", "收益率曲线"], primaryCandidates: ["债券研究"], askLabel: "债券研究下的利率债方向" },
  { terms: ["城投", "城投债", "地方债务"], primaryCandidates: ["债券研究"], askLabel: "债券研究下的城投债方向" },
  { terms: ["地产债", "房企债"], primaryCandidates: ["债券研究"], askLabel: "债券研究下的地产债方向" },
  { terms: ["新能源", "光伏", "储能", "风电"], primaryCandidates: ["股票研究"], askLabel: "股票研究下的新能源方向" },
  { terms: ["半导体", "芯片", "先进封装"], primaryCandidates: ["股票研究"], askLabel: "股票研究下的半导体方向" },
  { terms: ["人工智能", "AI", "算力", "大模型"], primaryCandidates: ["股票研究"], askLabel: "股票研究下的人工智能方向" },
  { terms: ["主动权益", "权益基金", "基金经理"], primaryCandidates: ["基金研究"], askLabel: "基金研究下的主动权益方向" },
  { terms: ["指数基金", "ETF", "宽基"], primaryCandidates: ["基金研究"], askLabel: "基金研究下的指数基金方向" },
  { terms: ["固收+", "固收加", "债券基金"], primaryCandidates: ["基金研究", "债券研究"], askLabel: "基金研究或债券研究中的固收方向" },
  { terms: ["资产配置", "股债配置", "多资产"], primaryCandidates: ["宏观策略"], askLabel: "宏观策略下的资产配置方向" },
  { terms: ["市场策略", "主题交易", "资金面"], primaryCandidates: ["宏观策略"], askLabel: "宏观策略下的市场策略方向" },
];

export function resolveSecondaryTermHint(term = "") {
  const normalizedTerm = term.trim().toLowerCase();
  if (!normalizedTerm) {
    return {
      matched: false,
      needsClarification: true,
      message: "没有收到明确的金融术语，请补充想筛选的方向。",
    };
  }

  const matchedHints = SECONDARY_TERM_HINTS.filter((hint) =>
    hint.terms.some((item) => {
      const normalizedItem = item.toLowerCase();
      return normalizedTerm.includes(normalizedItem) || normalizedItem.includes(normalizedTerm);
    }),
  );

  if (matchedHints.length === 0) {
    return {
      matched: false,
      needsClarification: true,
      message: `“${term}”可能是关键词，也可能是某个二级筛选方向。请先询问用户希望按二级筛选，还是作为关键词搜索。`,
    };
  }

  const primaryCandidates = [...new Set(matchedHints.flatMap((hint) => hint.primaryCandidates))];
  const labels = matchedHints.map((hint) => hint.askLabel);

  return {
    matched: true,
    term,
    primaryCandidates,
    labels,
    needsClarification: true,
    message: `“${term}”可能对应${labels.join("、")}。二级筛选不能直接确认，请先向用户确认是否按这个方向筛选。`,
  };
}

const brokerCycle = BROKERS.filter((item) => item !== "全部");
const ratingCycle = RATINGS.filter((item) => item !== "全部");
const riskCycle = ["低", "中", "高"];
const analystCycle = ["陈晨", "王敏", "李想", "赵一鸣", "周宁", "孙悦", "黄璐", "刘远"];

// 用模板批量生成更接近真实业务的标题，便于测试关键词、分类和排序组合。
const titleTemplates = {
  新能源: ["储能招标放量带来的二阶机会", "光伏产业链价格触底后的弹性", "风电海缆和整机环节景气跟踪"],
  人工智能: ["算力基础设施投资机会", "端侧 AI 应用落地节奏观察", "大模型商业化与数据要素更新"],
  半导体: ["国产替代加速推进", "先进封装景气度跟踪", "设备材料订单拐点观察"],
  医药生物: ["集采常态化下的投资策略", "创新药出海交易复盘", "医疗服务需求恢复跟踪"],
  银行: ["息差企稳与资产质量改善", "高股息配置价值再评估", "零售贷款需求修复观察"],
  消费电子: ["智能手机出货量回暖", "AI 终端供应链机会", "消费电子旺季备货跟踪"],
  电力设备: ["电网投资加速与设备更新", "特高压招标节奏分析", "配网侧数字化投资机会"],
  机器人: ["人形机器人产业链拆解", "减速器与执行器供需跟踪", "工业机器人出口机会"],
  主动权益: ["基金经理调仓行为跟踪", "成长风格基金持仓复盘", "红利基金拥挤度观察"],
  指数基金: ["宽基 ETF 资金流监测", "行业 ETF 配置窗口", "Smart Beta 因子表现复盘"],
  "固收+": ["权益仓位回补观察", "低波产品收益来源拆解", "转债增强策略表现"],
  FOF: ["养老 FOF 组合再平衡", "多资产配置模型更新", "目标风险产品跟踪"],
  QDII: ["海外科技资产配置窗口", "港股高股息产品比较", "全球资产波动监测"],
  量化策略: ["指增产品超额来源拆解", "中性策略容量跟踪", "小盘风格暴露复盘"],
  国内宏观: ["复苏斜率与政策节奏", "通胀走势和库存周期", "财政发力对需求的影响"],
  海外宏观: ["美元利率路径推演", "海外需求和出口链观察", "全球流动性拐点跟踪"],
  资产配置: ["股债性价比周度更新", "多资产组合再平衡建议", "风险预算模型信号变化"],
  行业比较: ["景气度扩散方向观察", "盈利预期修正排行榜", "估值分位和交易拥挤度"],
  市场策略: ["指数震荡期的结构选择", "主题交易热度复盘", "资金面和情绪指标跟踪"],
  利率债: ["收益率曲线形态变化", "资金面宽松窗口观察", "长端利率交易策略"],
  信用债: ["信用利差压缩空间", "产业债评级迁移跟踪", "信用风险定价更新"],
  可转债: ["转债估值修复机会", "平衡型转债组合筛选", "新券上市定价复盘"],
  城投债: ["区域化债进展跟踪", "城投利差分层观察", "隐债置换影响分析"],
  地产债: ["地产链信用修复跟踪", "房企债务展期观察", "销售改善对债券定价影响"],
};

// 从二级分类反推一级分类，生成模拟数据和校验筛选合法性时都会用到。
const primaryBySecondary = Object.entries(PRIMARY_FILTERS).reduce((map, [primary, secondaryList]) => {
  secondaryList.forEach((secondary) => {
    if (secondary !== "全部") map[secondary] = primary;
  });
  return map;
}, {});

function formatDate(index) {
  const day = 28 - (index % 24);
  const month = index < 90 ? "06" : "05";
  return `2026-${month}-${String(day < 1 ? day + 24 : day).padStart(2, "0")}`;
}

// 构造一批稳定的本地模拟数据。这样前端和 Copilot action 可以像调真实接口一样工作。
function buildReports() {
  const rows = [];
  const secondaries = Object.values(PRIMARY_FILTERS)
    .flat()
    .filter((item) => item !== "全部");

  secondaries.forEach((secondaryCategory, secondaryIndex) => {
    const primaryCategory = primaryBySecondary[secondaryCategory];
    const templateList = titleTemplates[secondaryCategory] || [`${secondaryCategory}专题跟踪`];

    brokerCycle.forEach((broker, brokerIndex) => {
      ratingCycle.forEach((rating, ratingIndex) => {
        const index = rows.length;
        const title = `${secondaryCategory}：${templateList[(brokerIndex + ratingIndex) % templateList.length]}`;
        const score = 60 + ((secondaryIndex * 11 + brokerIndex * 5 + ratingIndex * 7) % 39);
        const readCount = 1200 + ((secondaryIndex * 977 + brokerIndex * 431 + ratingIndex * 263) % 8600);
        const analyst = analystCycle[(secondaryIndex + brokerIndex + ratingIndex) % analystCycle.length];

        rows.push({
          id: `r-${String(index + 1).padStart(3, "0")}`,
          date: formatDate(index),
          title,
          broker,
          rating,
          primaryCategory,
          secondaryCategory,
          analyst,
          score,
          readCount,
          risk: riskCycle[(secondaryIndex + ratingIndex) % riskCycle.length],
          summary: `${broker}${analyst}认为，${secondaryCategory}当前处于${score >= 82 ? "高景气" : score >= 72 ? "修复" : "观察"}阶段，建议结合估值分位、资金流和基本面验证信号，关注后续政策、订单和盈利预期变化。`,
        });
      });
    });
  });

  return rows;
}

export const REPORTS = buildReports();

const ratingRank = {
  强烈推荐: 6,
  超配: 5,
  买入: 4,
  增持: 3,
  中性: 2,
  减持: 1,
};

// 根据一级筛选返回二级候选项。旧项目改造时，这里可以替换为真实的二级筛选接口。
export function getSecondaryOptions(primaryCategory) {
  return PRIMARY_FILTERS[primaryCategory] || PRIMARY_FILTERS.全部;
}

export async function requestSecondaryOptions(primaryCategory, { attempt = 1, simulateRequestCase = "normal" } = {}) {
  await delay(650 + attempt * 220);

  if (simulateRequestCase === "retrySuccess" && attempt === 1) {
    throw new Error("二级筛选接口临时超时");
  }

  if (simulateRequestCase === "retryFail") {
    throw new Error("二级筛选接口连续不可用");
  }

  return getSecondaryOptions(primaryCategory);
}

// 所有入口都先走 normalize，保证非法参数不会进入查询逻辑。
// 这对 AI 调用尤其重要，因为模型可能给出缺失字段或不在枚举里的值。
export function normalizeFilter(input = {}) {
  const primaryCategory = PRIMARY_OPTIONS.includes(input.primaryCategory) ? input.primaryCategory : "全部";
  const availableSecondary = getSecondaryOptions(primaryCategory);
  const secondaryCategory = availableSecondary.includes(input.secondaryCategory) ? input.secondaryCategory : "全部";

  return {
    keyword: typeof input.keyword === "string" ? input.keyword : "",
    broker: BROKERS.includes(input.broker) ? input.broker : "全部",
    rating: RATINGS.includes(input.rating) ? input.rating : "全部",
    primaryCategory,
    secondaryCategory,
    dateFrom: typeof input.dateFrom === "string" ? input.dateFrom : "",
    dateTo: typeof input.dateTo === "string" ? input.dateTo : "",
    orderBy: ORDER_FIELDS.includes(input.orderBy) ? input.orderBy : "date",
    direction: DIRECTIONS.includes(input.direction) ? input.direction : "desc",
    page: Number.isInteger(input.page) && input.page > 0 ? input.page : 1,
    pageSize: PAGE_SIZES.includes(input.pageSize) ? input.pageSize : 10,
  };
}

// 本地版查询服务：按筛选条件过滤、按表头排序、最后分页。
// 接真实后端时，函数签名可以保持不变，内部改成请求 API 即可。
export function queryReports(filter) {
  const normalized = normalizeFilter(filter);
  const {
    keyword,
    broker,
    rating,
    primaryCategory,
    secondaryCategory,
    dateFrom,
    dateTo,
    orderBy,
    direction,
    page,
    pageSize,
  } = normalized;
  const normalizedKeyword = keyword.trim().toLowerCase();

  let rows = REPORTS.filter((report) => {
    if (broker !== "全部" && report.broker !== broker) return false;
    if (rating !== "全部" && report.rating !== rating) return false;
    if (primaryCategory !== "全部" && report.primaryCategory !== primaryCategory) return false;
    if (secondaryCategory !== "全部" && report.secondaryCategory !== secondaryCategory) return false;
    if (dateFrom && report.date < dateFrom) return false;
    if (dateTo && report.date > dateTo) return false;
    if (!normalizedKeyword) return true;

    return [
      report.title,
      report.summary,
      report.primaryCategory,
      report.secondaryCategory,
      report.broker,
      report.rating,
      report.analyst,
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedKeyword);
  });

  rows = rows.sort((a, b) => {
    const multiplier = direction === "asc" ? 1 : -1;
    if (orderBy === "rating") return ((ratingRank[a.rating] || 0) - (ratingRank[b.rating] || 0)) * multiplier;
    if (orderBy === "score") return (a.score - b.score) * multiplier;
    if (orderBy === "readCount") return (a.readCount - b.readCount) * multiplier;
    return a.date.localeCompare(b.date) * multiplier;
  });

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;

  return {
    rows: rows.slice(start, start + pageSize),
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}

// 用于模拟接口耗时，让 loading 和动作审计更接近真实交互。
export function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
