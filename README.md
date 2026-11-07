# 自动化客户端

## 本机一键启动（现阶段）

拿到完整 `miaoshou-auto-client/` 目录后，macOS 双击 `start.command`，Windows x64 双击 `start.cmd`。脚本优先使用已安装且版本不低于 22.19.0 的 Node.js；否则从 Node.js 官网下载固定的 22.19.0 版本到当前用户的 `.miaoshou-auto/client-runtime/node/`，核对官方 SHA-256 后使用。首次启动还会联网运行两端 `npm ci`、安装与 Playwright 1.64.0 匹配的 Chromium、构建前后端，再以本机 `127.0.0.1:3001` 提供页面并打开默认浏览器；后续启动复用依赖和浏览器，仍会重新构建。启动窗口需保持打开，结束时在窗口按 Ctrl+C；关闭网页不会停止客户端。脚本不会打开妙手或 1688 自动化浏览器窗口，仍由用户在页面点击“打开”。

首次启动创建 `~/.miaoshou-auto/client-runtime/client.env`（Windows 位于当前用户目录下），默认连接本机业务后端。连接远端账号前，在此文件填写 `BUSINESS_BACKEND_URL`，并按后端实际配置填写 `BUSINESS_BACKEND_BASIC_USERNAME`、`BUSINESS_BACKEND_BASIC_PASSWORD`；修改后重启客户端。启动脚本需要网络连接到 Node.js 官网、npm 仓库和 Playwright 浏览器下载地址，并需要 `miaoshou-auto-client/` 目录可写。这是基于完整源码目录的临时便捷运行方式，**不是免源码、离线可用的正式交付包**；干净系统的 Windows/macOS 验收仍待完成，交付规划见[在线客户端部署方案](../miaoshou-auto/docs/deployment/online-client-deployment.md)。

## Windows x64 免源码发布包

在开发机的 `miaoshou-auto-client/` 目录执行 `npm run package:win`，生成 `release/miaoshou-client-win-x64-<时间>.zip` 及同名 `.sha256`。打包命令从当前 TS 源文件单独编译后端、构建前端、安装后端生产依赖、下载并校验 Windows Node 22.19.0，并下载 Playwright 1.64.0 对应的 Windows Chromium。压缩包中没有本项目的 `src/`、TS/TSX、开发脚本或项目 source map；保留运行所需的编译后 JS、静态页面、第三方生产依赖、Node、Chromium 和启动入口。第三方依赖本身可能包含类型或测试文件。此包从 macOS 交叉组装，尚未在 Windows 实机验收。

将整个压缩包复制到 Windows x64 电脑并解压，按包内 `README.txt` 双击 `start.cmd`。首次启动会在当前用户目录创建 `client.env` 并打开记事本；填写该账号的 `BUSINESS_BACKEND_URL` 和所需凭证，保存后重新双击 `start.cmd`。之后从本机页面人工打开并登录两个自动化浏览器。发布包运行时无需安装 Node、npm 或编译，也不需要 WSL2；用户数据与发布目录分离。更新包仍须在命令安全收尾后受控替换，不能覆盖用户数据目录。

`backend/` 是本机 Fastify 服务，`frontside/` 是 React + TypeScript + Vite 页面。客户端显示妙手尺码表与通用自动化浏览器状态，并由用户点击打开可见 Chromium 窗口；妙手和 1688 均由用户在窗口内手动登录。尺码 `direct` 路径的官方参数观察和新模板网页填写已接入在线客户端命令；显式 `legacy` 已归档，业务入口返回 410。尺码命令按管理员独立配置并行执行，默认最多 3 条、可设 1–10；各命令使用独立标签和本机保存证据，其他浏览器命令等待尺码批次结束。正式保存与跨端断线恢复尚未完成端到端验收。

本机开发时，客户端默认连接 `http://127.0.0.1:3000/`；跨机器时只需设置对应账号实例的 `BUSINESS_BACKEND_URL`（例如 `https://<入口>/<账号标识>/api/`）。业务后端须配置 `MIAOSHOU_LOGIN_ACCOUNT`。公网入口已有 Basic 认证时，客户端需设置 `BUSINESS_BACKEND_BASIC_USERNAME` 和 `BUSINESS_BACKEND_BASIC_PASSWORD`。客户端主动建立 WebSocket，每 10 秒读取本机妙手浏览器登录账号并发送状态；连接失败或确认超时则用 HTTP 报到，约 30 秒后重试 WebSocket。后端严格匹配账号才显示在线，未登录、断线或停止报到后转离线。同一客户端在两种通道间切换不重复计数；同账号多个客户端在线时，新命令交给首个有效报到且仍在线的客户端，已发命令不跨客户端重试。客户端仅依赖报告的妙手账号匹配，不能证明报告来源，公网使用时应结合已有入口访问控制。连接承载尺码及其他浏览器命令，优先 WebSocket，HTTP 领取和回传兜底。命令和结果保存在 `MIAOSHOU_RUNTIME_DIR/online-client/commands.sqlite`（默认 `~/.miaoshou-auto/online-client/commands.sqlite`）；重启后只读命令可重排队，执行中的网页写入记为未知，不自动重做。队列绑定业务后端地址与妙手账号，有未确认命令时拒绝切换。状态命令收到后端确认后清理，业务命令保留记录。后端未决命令仍在内存，后端重启后的未知结果须人工对账。完整边界见[迁移文档](../miaoshou-auto/docs/design/automation-browser-client-migration.md)。

本机开发可向业务后端 `POST /online-client/test-observe/<taskId>` 只读观察官方参数，或向 `POST /online-client/test-fill/<taskId>` 验证已保存任务的历史尺码填表计划。试填经在线命令通道下发并由客户端 SQLite 队列按尺码并发额度执行；每项在独立浏览器标签选类目、填参数与尺码行，回读后点击取消并关闭标签，结果经在线通道回传后端。不会点击保存或改写任务。测试接口只允许回环请求，生产环境关闭，不能代替正式尺码任务执行。本地五路验收脚本为 `../miaoshou-auto/backend/poc/size-template-five-preview.mjs`，运行时临时将尺码并发设为 5，结束后恢复原值。

需要 Node.js 22.19.0 或更新版本。先分别在 `backend/` 和 `frontside/` 执行 `npm ci`，再在 `backend/` 执行 `npm run browser:install` 安装与当前 Playwright 版本匹配的 Chromium；仅安装 npm 依赖不会安装浏览器二进制文件。客户端和业务后端的 Playwright 固定为 `1.64.0`，对应 Chromium revision `1248`，更新时须同时核对依赖锁文件和浏览器安装。在 `miaoshou-auto-client/` 下的两个终端分别执行 `npm run dev:backend` 和 `npm run dev:frontside`，打开 `http://127.0.0.1:5175`。服务默认只监听本机 `127.0.0.1:3001`；前端开发代理转发状态接口。`npm run typecheck` 和 `npm run build` 检查两端。

后端配置可从 `backend/.env.example` 复制到 `backend/.env`。`HOST`、`PORT` 控制监听地址和端口；`SIZE_TEMPLATE_BROWSER_CDP_URL` 与 `AUTOMATION_BROWSER_CDP_URL` 默认分别为本机 9223、9224。可见窗口仅支持本机默认 CDP 端口，沿用 `MIAOSHOU_RUNTIME_DIR`（默认 `~/.miaoshou-auto`）中的两个独立 profile；窗口与原无头实例不能同时占用同一 profile。若端口已运行无头实例，先确认任务空闲，再由用户执行同级业务仓库根目录的 `npm run browser-close`；页面随后可分别打开可见窗口。页面不会自动关闭运行中的浏览器，也不会自动填写账号或验证码。

点击“打开”后，妙手浏览器进入尺码表管理页，通用浏览器进入 1688 登录页。用户直接在对应窗口完成账号、扫码或短信验证；“收起”仅最小化窗口，不结束浏览器进程、CDP 连接或登录态，再点“打开”恢复窗口。客户端每 3 秒只读核验妙手会话并显示实际账号；1688 登录状态沿用登录页跳转至 1688 站点的判定，仅显示“已登录”，不保证商品页免验证。状态待确认时不推断已登录。原业务后端的 1688 登录入口、妙手显式登录及测试入口暂时停用，后台不再自动填写妙手登录表单；商品任务遇到未登录状态会失败，需由用户手动登录后决定是否重试任务。手动登录结束后可继续使用可见浏览器进行自动化作业，关闭窗口前应等待任务结束。
