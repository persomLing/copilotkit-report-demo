const STORAGE_KEY = "copilotkit-report-demo.learning.v1";

const nowIso = () => new Date().toISOString();

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
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
          ruleType: "parsing_rule",
          abstractRule: "出现“评分不低于/评分至少/N分以上”等表达时，应解析为最低分数 scoreMin，而不是评级 rating。",
          examples: ["评分不低于80 半导体相关的基金"],
          counterExamples: ["评级买入以上"],
          confidence: "high",
          source: "开发复盘",
          approvedAt: nowIso(),
        },
        {
          id: "rule-theme-fund",
          ruleType: "domain_rule",
          abstractRule: "“某主题相关的基金”优先表示一级分类=基金研究，主题词进入 keyword，不要按股票研究二级行业追问。",
          examples: ["半导体相关的基金", "新能源相关基金", "AI 主题基金"],
          counterExamples: ["股票研究里的半导体报告"],
          confidence: "high",
          source: "开发复盘",
          approvedAt: nowIso(),
        },
        {
          id: "rule-explicit-primary-secondary",
          ruleType: "workflow_rule",
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
          ? normalizeArray(parsed?.systemRules?.approved)
          : fallback.systemRules.approved,
        candidates: normalizeArray(parsed?.systemRules?.candidates),
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
  const nextCandidate = {
    id: makeId("candidate"),
    ruleType: candidate.ruleType || "interaction_rule",
    abstractRule: candidate.abstractRule,
    examples: normalizeArray(candidate.examples),
    counterExamples: normalizeArray(candidate.counterExamples),
    evidence: candidate.evidence || "",
    confidence: candidate.confidence || "medium",
    status: "pending",
    createdAt: nowIso(),
  };
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
    ruleType: candidate.ruleType,
    abstractRule: candidate.abstractRule,
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
      ruleType: "parsing_rule",
      abstractRule: "分数阈值表达应进入 scoreMin/readCountMin 等数值阈值字段，不应误判为评级或风险词。",
      examples: [userText || "评分不低于80"],
      counterExamples: ["评级买入以上"],
      evidence: userFeedback || aiBehavior,
      confidence: "high",
    };
  }

  if (/基金/.test(text) && /相关|主题|方向/.test(text)) {
    return {
      ruleType: "domain_rule",
      abstractRule: "用户说“某主题相关的基金”时，先按基金研究处理，主题词作为关键词；只有用户明确股票研究时才走股票二级分类。",
      examples: [userText || "半导体相关的基金"],
      counterExamples: ["股票研究里的半导体报告"],
      evidence: userFeedback || aiBehavior,
      confidence: "high",
    };
  }

  if (/追问|确认|不如自己|别问|不用问/.test(text)) {
    return {
      ruleType: "interaction_rule",
      abstractRule: "对筛选、排序、翻页这类可撤销动作，中等置信度应先执行并说明假设；只有低置信度或不可逆动作才追问。",
      examples: [userText || "看半导体"],
      counterExamples: ["删除这些数据"],
      evidence: userFeedback || aiBehavior,
      confidence: "medium",
    };
  }

  return {
    ruleType: "interaction_rule",
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

export function summarizeKnowledgeForAgent(knowledgeBase) {
  return {
    userMemoryPolicy: "只影响当前用户偏好和习惯；不能覆盖 approvedSystemRules 和工具返回的事实。",
    systemRulePolicy: "approvedSystemRules 可以作为通用规则执行；pendingRuleCandidates 只能用于提醒和人工审核，不能当事实直接执行。",
    userPreferences: knowledgeBase.userMemory.preferences.slice(0, 8),
    userCorrections: knowledgeBase.userMemory.corrections.slice(0, 8),
    userHabits: knowledgeBase.userMemory.habits.slice(0, 8),
    approvedSystemRules: knowledgeBase.systemRules.approved.slice(0, 12),
    pendingRuleCandidates: knowledgeBase.systemRules.candidates.slice(0, 5),
    recentLearningCases: knowledgeBase.systemRules.caseLog.slice(0, 5),
  };
}
