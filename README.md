# 妙手自动化部署目录

本目录是客户端生产产物，不含业务源码或已填写的配置。
Windows + WSL2 双击 install-client.cmd / run-client.cmd；系统依赖通过 WSL root 准备，对应卸载入口为 uninstall-client.cmd。原生 Windows 双击 install-client-native.cmd / run-client-native.cmd，要求 Windows Node.js、PostgreSQL + pgvector 和可用的 pg_isready/psql，依赖安装在 Windows 完成，对应卸载入口为 uninstall-client-native.cmd。两个入口互不混用，卸载默认保留业务数据。
macOS 双击 install-client.command。首次安装只输入管理员生成的一次性配对码。
安装脚本检查并安装运行依赖，在客户电脑生成私有配置和数据库角色；不会启动两个业务浏览器或执行商品任务。
安装前从项目部署指南确认目标数据和现有服务；不要在业务任务执行中切换版本。
根目录无 npm 依赖；手工部署所需依赖、数据库和服务配置见 backend/README.md。
在本目录由用户手动执行：

    npm run browser-open
    npm run browser-close

启动命令依次开启两个独立浏览器，关闭命令同时关闭两个实例。端口及 profile 保持独立。
这些命令需要 backend/ 部署文件和后端依赖；仅部署前端时不可使用。
