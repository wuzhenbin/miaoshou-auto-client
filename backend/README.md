# 后端部署产物

需要 Node.js >=22.19.0（建议 24 LTS）、PostgreSQL + pgvector、curl 及 Chromium 系统依赖。
在本目录执行 npm ci --omit=dev，首次复制 .env.example 为 .env 并填写服务器业务配置。
执行 npm run db:migrate 后，使用 npm start 启动。配置和已有业务数据须独立保留。
客户电脑可另运行 npm run local:http，在 localhost:8080 提供相邻 frontside/ 静态资源并转发 API；LOCAL_HTTP_PORT 可调整入口端口。
Playwright 浏览器由用户安装（Linux 可运行 npx playwright install --with-deps chromium）。
两个专用浏览器由用户在上级项目目录手动运行 npm run browser-open，统一关闭用 npm run browser-close。
本目录同样使用 npm run browser-open 和 npm run browser-close。
本包 JavaScript 已混淆，不含 source map、本地凭证、业务数据、node_modules 或 TypeScript 源码。
