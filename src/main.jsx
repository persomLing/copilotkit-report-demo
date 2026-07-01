import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CopilotChatConfigurationProvider, CopilotKit } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    {/* CopilotKit 前端 Provider：runtimeUrl 指向本地 Express 中间层，agent 名称要和后端注册名一致。 */}
    <CopilotKit runtimeUrl="/api/copilotkit" agent="report_agent" showDevConsole={false}>
      {/* 统一把聊天窗口初始态设为关闭，页面首屏只展示业务工作台和自定义 AI 入口。 */}
      <CopilotChatConfigurationProvider isModalDefaultOpen={false}>
        <App />
      </CopilotChatConfigurationProvider>
    </CopilotKit>
  </StrictMode>,
);
