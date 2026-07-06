const STORAGE_KEY = "copilotkit-report-demo.learning.v1";

const nowIso = () => new Date().toISOString();

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeConfidence(confidence) {
  return ["low", "medium", "high"].includes(confidence) ? confidence : "medium";
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean).map((item) => String(item).trim()).filter(Boolean))];
}

function inferRuleModule(rule) {
  const text = `${rule.abstractRule || ""} ${rule.summary || ""} ${normalizeArray(rule.examples).join(" ")}`;
  if (/基金|回撤|收益|基金经理/.test(text)) return "fund";
  if (/研报|券商|评级|二级|行业|热度|评分/.test(text)) return "report";
  return "global";
}

function inferTriggers(rule) {
  const text = `${rule.abstractRule || ""} ${normalizeArray(rule.examples).join(" ")} ${normalizeArray(rule.counterExamples).join(" ")}`;
  const candidates = [
    "评分",
    "分数",
    "不低于",
    "至少",
    "以上",
    "基金",
    "主题",
    "相关",
    "半导体",
    "新能源",
    "AI",
    "股票研究",
    "二级筛选",
    "二级",
    "一级",
    "券商",
    "评级",
    "追问",
    "确认",
    "导出",
    "打断",
  ];
  return uniqueValues(candidates.filter((item) => text.includes(item)));
}

function normalizeApprovedRule(rule) {
  const moduleId = rule.moduleId || inferRuleModule(rule);
  return {
    id: rule.id || makeId("rule"),
    scope: rule.scope || (moduleId === "global" ? "global" : "module"),
    moduleId,
    ruleType: rule.ruleType || "interaction_rule",
    priority: Number(rule.priority || (rule.confidence === "high" ? 80 : 50)),
    summary: rule.summary || rule.abstractRule || "",
    abstractRule: rule.abstractRule || rule.summary || "",
    triggers: uniqueValues(normalizeArray(rule.triggers).length ? rule.triggers : inferTriggers(rule)),
    examples: normalizeArray(rule.examples),
    counterExamples: normalizeArray(rule.counterExamples),
    confidence: normalizeConfidence(rule.confidence),
    source: rule.source || "人工审核",
    approvedAt: rule.approvedAt || nowIso(),
    hitCount: Number(rule.hitCount || 0),
    lastHitAt: rule.lastHitAt || "",
  };
}

function normalizeCandidateRule(rule) {
  const moduleId = rule.moduleId || inferRuleModule(rule);
  return {
    id: rule.id || makeId("candidate"),
    scope: rule.scope || (moduleId === "global" ? "global" : "module"),
    moduleId,
    ruleType: rule.ruleType || "interaction_rule",
    priority: Number(rule.priority || (rule.confidence === "high" ? 70 : 45)),
    summary: rule.summary || rule.abstractRule || "",
    abstractRule: rule.abstractRule || rule.summary || "",
    triggers: uniqueValues(normalizeArray(rule.triggers).length ? rule.triggers : inferTriggers(rule)),
    examples: normalizeArray(rule.examples),
    counterExamples: normalizeArray(rule.counterExamples),
    evidence: rule.evidence || "",
    confidence: normalizeConfidence(rule.confidence),
    status: rule.status || "pending",
    createdAt: rule.createdAt || nowIso(),
  };
}

export function createDefaultKnowledgeBase() {
  return {
    userMemory: {
      preferences: [
        {
          id: "pref-default-avoid-needless-clarify",
          key: "clarification_style",
          value: "对可撤销的筛选/排序请求，倾向先按高概率执行，再说明假设，减少无意义追问。",
          evidence: "用户反馈：一直追问会觉得不如自己手操。",
          confidence: "high",
          updatedAt: nowIso(),
        },
      ],
      corrections: [],
      habits: [],
    },
    systemRules: {
      approved: [
        {
          id: "rule-score-min",
          scope: "module",
          moduleId: "report",
          ruleType: "parsing_rule",
          priority: 95,
          summary: "评分阈值表达进入 scoreMin，不要误用评级 rating。",
          triggers: ["评分", "分数", "不低于", "至少", "以上"],
          abstractRule: "出现“评分不低于/评分至少/N分以上”等表达时，应解析为最低分数 scoreMin，而不是评级 rating。",
          examples: ["评分不低于80 半导体相关的基金"],
          counterExamples: ["评级买入以上"],
          confidence: "high",
          source: "开发复盘",
          approvedAt: nowIso(),
        },
        {
          id: "rule-theme-fund",
          scope: "module",
          moduleId: "fund",
          ruleType: "domain_rule",
          priority: 90,
          summary: "主题相关基金进入基金研究，主题词作为 keyword。",
          triggers: ["基金", "主题", "相关", "半导体", "新能源", "AI"],
          abstractRule: "“某主题相关的基金”优先表示一级分类=基金研究，主题词进入 keyword，不要按股票研究二级行业追问。",
          examples: ["半导体相关的基金", "新能源相关基金", "AI 主题基金"],
          counterExamples: ["股票研究里的半导体报告"],
          confidence: "high",
          source: "开发复盘",
          approvedAt: nowIso(),
        },
        {
          id: "rule-explicit-primary-secondary",
          scope: "module",
          moduleId: "report",
          ruleType: "workflow_rule",
          priority: 88,
          summary: "用户已明确一级和二级意图时，请求二级候选项后执行，不要重复追问。",
          triggers: ["一级", "二级", "二级筛选", "股票研究", "先加载"],
          abstractRule:
            "用户同一句话已经指定一级分类，并要求先加载该一级二级筛选，再指定二级值时，视为二级意图已确认；应请求二级候选项后执行，不要再次追问。",
          examples: ["先加载股票研究的二级筛选，再只看电力设备里华泰证券的买入报告"],
          counterExamples: ["只看电力设备"],
          confidence: "high",
          source: "开发复盘",
          approvedAt: nowIso(),
        },
      ],
      candidates: [],
      caseLog: [],
    },
  };
}

export function loadKnowledgeBase() {
  if (typeof window === "undefined") return createDefaultKnowledgeBase();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultKnowledgeBase();
    const parsed = JSON.parse(raw);
    const fallback = createDefaultKnowledgeBase();
    return {
      userMemory: {
        preferences: normalizeArray(parsed?.userMemory?.preferences),
        corrections: normalizeArray(parsed?.userMemory?.corrections),
        habits: normalizeArray(parsed?.userMemory?.habits),
      },
      systemRules: {
        approved: normalizeArray(parsed?.systemRules?.approved).length
          ? normalizeArray(parsed?.systemRules?.approved).map(normalizeApprovedRule)
          : fallback.systemRules.approved.map(normalizeApprovedRule),
        candidates: normalizeArray(parsed?.systemRules?.candidates).map(normalizeCandidateRule),
        caseLog: normalizeArray(parsed?.systemRules?.caseLog),
      },
    };
  } catch {
    return createDefaultKnowledgeBase();
  }
}

export function saveKnowledgeBase(knowledgeBase) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(knowledgeBase));
}

export function resetKnowledgeBase() {
  const next = createDefaultKnowledgeBase();
  saveKnowledgeBase(next);
  return next;
}

function upsertByKey(items, nextItem) {
  const existingIndex = items.findIndex((item) => item.key === nextItem.key);
  if (existingIndex < 0) return [nextItem, ...items].slice(0, 30);
  return items.map((item, index) => (index === existingIndex ? { ...item, ...nextItem, id: item.id } : item));
}

export function addUserMemory(knowledgeBase, { type, key, value, evidence, confidence = "medium" }) {
  const bucketName = type === "correction" ? "corrections" : type === "habit" ? "habits" : "preferences";
  const item = {
    id: makeId(type || "memory"),
    key: key || "general",
    value,
    evidence: evidence || "",
    confidence,
    updatedAt: nowIso(),
  };
  return {
    ...knowledgeBase,
    userMemory: {
      ...knowledgeBase.userMemory,
      [bucketName]: upsertByKey(knowledgeBase.userMemory[bucketName], item),
    },
  };
}

export function forgetUserMemory(knowledgeBase, id) {
  return {
    ...knowledgeBase,
    userMemory: {
      preferences: knowledgeBase.userMemory.preferences.filter((item) => item.id !== id),
      corrections: knowledgeBase.userMemory.corrections.filter((item) => item.id !== id),
      habits: knowledgeBase.userMemory.habits.filter((item) => item.id !== id),
    },
  };
}

export function addRuleCandidate(knowledgeBase, candidate) {
  const nextCandidate = normalizeCandidateRule({ ...candidate, id: makeId("candidate"), createdAt: nowIso() });
  return {
    ...knowledgeBase,
    systemRules: {
      ...knowledgeBase.systemRules,
      candidates: [nextCandidate, ...knowledgeBase.systemRules.candidates].slice(0, 30),
    },
  };
}

export function approveRuleCandidate(knowledgeBase, candidateId) {
  const candidate = knowledgeBase.systemRules.candidates.find((item) => item.id === candidateId);
  if (!candidate) return knowledgeBase;
  const approved = {
    id: candidate.id.replace("candidate", "rule"),
    scope: candidate.scope,
    moduleId: candidate.moduleId,
    ruleType: candidate.ruleType,
    priority: candidate.priority,
    summary: candidate.summary,
    abstractRule: candidate.abstractRule,
    triggers: candidate.triggers,
    examples: candidate.examples,
    counterExamples: candidate.counterExamples,
    confidence: candidate.confidence,
    source: candidate.evidence || "人工审核",
    approvedAt: nowIso(),
  };
  return {
    ...knowledgeBase,
    systemRules: {
      ...knowledgeBase.systemRules,
      approved: [approved, ...knowledgeBase.systemRules.approved].slice(0, 50),
      candidates: knowledgeBase.systemRules.candidates.filter((item) => item.id !== candidateId),
    },
  };
}

export function dismissRuleCandidate(knowledgeBase, candidateId) {
  return {
    ...knowledgeBase,
    systemRules: {
      ...knowledgeBase.systemRules,
      candidates: knowledgeBase.systemRules.candidates.filter((item) => item.id !== candidateId),
    },
  };
}

export function extractRuleCandidateFromFeedback({ userText = "", aiBehavior = "", userFeedback = "", finalFix = "" }) {
  const text = `${userText} ${aiBehavior} ${userFeedback} ${finalFix}`;

  if (/不低于|至少|以上/.test(text) && /评分|分数/.test(text)) {
    return {
      scope: "module",
      moduleId: "report",
      ruleType: "parsing_rule",
      priority: 85,
      summary: "分数阈值表达进入数值阈值字段。",
      triggers: ["评分", "分数", "不低于", "至少", "以上"],
      abstractRule: "分数阈值表达应进入 scoreMin/readCountMin 等数值阈值字段，不应误判为评级或风险词。",
      examples: [userText || "评分不低于80"],
      counterExamples: ["评级买入以上"],
      evidence: userFeedback || aiBehavior,
      confidence: "high",
    };
  }

  if (/基金/.test(text) && /相关|主题|方向/.test(text)) {
    return {
      scope: "module",
      moduleId: "fund",
      ruleType: "domain_rule",
      priority: 85,
      summary: "主题相关基金进入基金研究，主题词作为关键词。",
      triggers: ["基金", "主题", "相关", "半导体", "新能源", "AI"],
      abstractRule: "用户说“某主题相关的基金”时，先按基金研究处理，主题词作为关键词；只有用户明确股票研究时才走股票二级分类。",
      examples: [userText || "半导体相关的基金"],
      counterExamples: ["股票研究里的半导体报告"],
      evidence: userFeedback || aiBehavior,
      confidence: "high",
    };
  }

  if (/追问|确认|不如自己|别问|不用问/.test(text)) {
    return {
      scope: "global",
      moduleId: "global",
      ruleType: "interaction_rule",
      priority: 65,
      summary: "可撤销动作中置信度先执行并说明假设，低置信才追问。",
      triggers: ["追问", "确认", "筛选", "排序"],
      abstractRule: "对筛选、排序、翻页这类可撤销动作，中等置信度应先执行并说明假设；只有低置信度或不可逆动作才追问。",
      examples: [userText || "看半导体"],
      counterExamples: ["删除这些数据"],
      evidence: userFeedback || aiBehavior,
      confidence: "medium",
    };
  }

  return {
    scope: "global",
    moduleId: "global",
    ruleType: "interaction_rule",
    priority: 35,
    summary: "低置信纠错案例，需要人工补充抽象规则。",
    triggers: [],
    abstractRule: "从本次纠错中提炼通用规则前，需要人工补充更抽象的适用边界。",
    examples: [userText].filter(Boolean),
    counterExamples: [],
    evidence: userFeedback || aiBehavior,
    confidence: "low",
  };
}

export function recordLearningCase(knowledgeBase, learningCase) {
  const caseItem = {
    id: makeId("case"),
    userText: learningCase.userText || "",
    aiBehavior: learningCase.aiBehavior || "",
    userFeedback: learningCase.userFeedback || "",
    finalFix: learningCase.finalFix || "",
    createdAt: nowIso(),
  };
  return {
    ...knowledgeBase,
    systemRules: {
      ...knowledgeBase.systemRules,
      caseLog: [caseItem, ...knowledgeBase.systemRules.caseLog].slice(0, 50),
    },
  };
}

function compactRule(rule, score = 0) {
  return {
    id: rule.id,
    scope: rule.scope,
    moduleId: rule.moduleId,
    ruleType: rule.ruleType,
    priority: rule.priority,
    score,
    summary: rule.summary || rule.abstractRule,
    triggers: normalizeArray(rule.triggers).slice(0, 8),
    counterExamples: normalizeArray(rule.counterExamples).slice(0, 2),
  };
}

function scoreRule(rule, query, moduleId) {
  const safeQuery = query || "";
  const ruleText = `${rule.summary || ""} ${rule.abstractRule || ""} ${normalizeArray(rule.examples).join(" ")} ${normalizeArray(rule.triggers).join(" ")}`;
  let score = Math.min(Number(rule.priority || 0) / 10, 10);

  if (rule.scope === "global") score += 3;
  if (moduleId && rule.moduleId === moduleId) score += 8;
  if (moduleId && rule.moduleId && rule.moduleId !== "global" && rule.moduleId !== moduleId) score -= 10;

  for (const trigger of normalizeArray(rule.triggers)) {
    if (trigger && safeQuery.includes(trigger)) score += 9;
  }

  const words = uniqueValues(safeQuery.split(/[\s,，。；;、/]+/));
  for (const word of words) {
    if (word.length >= 2 && ruleText.includes(word)) score += 2;
  }

  if (rule.confidence === "high") score += 3;
  if (rule.confidence === "low") score -= 2;
  return score;
}

export function retrieveRelevantRules(knowledgeBase, { query = "", moduleId = "report", topK = 5 } = {}) {
  const approvedRules = knowledgeBase.systemRules.approved.map(normalizeApprovedRule);
  const scoredRules = approvedRules
    .map((rule) => ({ rule, score: scoreRule(rule, query, moduleId) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.rule.priority - left.rule.priority)
    .slice(0, topK)
    .map(({ rule, score }) => compactRule(rule, Number(score.toFixed(2))));

  return {
    query,
    moduleId,
    topK,
    totalApprovedRules: approvedRules.length,
    returnedRules: scoredRules.length,
    rules: scoredRules,
    policy: "只把 rules 放进本轮上下文；全量 approvedRules 留在规则库，不直接塞给模型。",
  };
}

export function summarizeKnowledgeForAgent(knowledgeBase, relevantRuleContext = null) {
  const relevantRules = relevantRuleContext?.rules || [];
  return {
    userMemoryPolicy: "只影响当前用户偏好和习惯；不能覆盖 approvedSystemRules 和工具返回的事实。",
    systemRulePolicy:
      "全量 approvedSystemRules 不直接进入上下文；先调用 retrieveRelevantRules 按 query/moduleId 召回 Top K，只有 relevantRules 可以作为本轮通用规则参考。",
    ruleCounts: {
      approved: knowledgeBase.systemRules.approved.length,
      pending: knowledgeBase.systemRules.candidates.length,
      recentLearningCases: knowledgeBase.systemRules.caseLog.length,
    },
    activeRuleContext: relevantRuleContext
      ? {
          query: relevantRuleContext.query,
          moduleId: relevantRuleContext.moduleId,
          returnedRules: relevantRuleContext.returnedRules,
        }
      : null,
    userPreferences: knowledgeBase.userMemory.preferences.slice(0, 8),
    userCorrections: knowledgeBase.userMemory.corrections.slice(0, 8),
    userHabits: knowledgeBase.userMemory.habits.slice(0, 8),
    relevantRules,
    pendingRuleCandidates: knowledgeBase.systemRules.candidates.slice(0, 5),
    recentLearningCases: knowledgeBase.systemRules.caseLog.slice(0, 5),
  };
}
