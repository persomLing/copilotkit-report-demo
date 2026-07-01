import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/copilotkit": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
