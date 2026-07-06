# CopilotKit 研报工作台 Demo

这个项目演示“AI 控制已有 React 业务页面”的改造方式，适合作为旧 React 中后台项目 AI 化的参考 demo。

核心能力：

- React 页面通过 `useAgentContext` 暴露必要状态。
- 前端通过 `useFrontendTool` 注册可执行动作。
- Express 后端承载 CopilotKit Runtime 和模型密钥。
- AI 可以筛选、排序、翻页、打开详情、选择、导出。
- 二级筛选通过“金融语义识别 -> 用户确认 -> 接口请求 -> 设置筛选”的链路执行。
- 二级接口模拟了等待、失败重试和最终失败告知。
- 支持 AG-UI 打断：停止 AI 后续规划，已发出的前端请求继续完成。
- 支持两层经验沉淀：当前用户记忆 + 人工审核后的通用系统规则。

## 文档

- [技术设计](./docs/技术设计.md)
- [问题复盘与注意事项](./docs/问题复盘与注意事项.md)
- [开发日志](./docs/开发日志.md)

## 学习体系

Demo 里新增了 `src/memoryStore.js`：

- `userMemory`：记录当前用户偏好、习惯和纠错，只影响当前用户。
- `systemRules.candidates`：AI 从纠错中提炼出的待审核规则，不会自动生效。
- `systemRules.approved`：人工批准后的通用规则，全量保存在规则库。
- `retrieveRelevantRules`：按用户输入和模块召回 Top K 相关规则，再进入 `useAgentContext`，避免全量规则浪费 token。

“知识沉淀”Tab 可以查看已生效规则、待审核规则、本轮召回规则，并支持批准、驳回和重置。

## 本地开发

```bash
npm install
copy .env.example .env
npm run dev
```

开发访问：

```text
http://localhost:5174
```

Runtime：

```text
http://localhost:4000/api/copilotkit
```

健康检查：

```text
http://localhost:4000/health
```

## Docker 运行

先准备 `.env`：

```env
DEEPSEEK_API_KEY=sk-your-deepseek-key
PORT=4000
```

启动：

```bash
docker compose up --build
```

访问：

```text
http://localhost:4000
```

停止：

```bash
docker compose down
```

## 注意

- 不要提交真实 `.env`。
- Docker 镜像不会打包 `.env`、`node_modules`、`dist`。
- 真实金融系统中，删除、提交、导出等敏感动作建议统一加人工确认或审批。
