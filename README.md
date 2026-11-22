# 妙手自动化部署目录

本目录是客户端生产产物，不含业务源码或已填写的配置。
当前交付目标：Windows + WSL2；双击 install-client.cmd / run-client.cmd，卸载使用 uninstall-client.cmd。
macOS 双击 install-client.command。首次安装由管理员按项目文档手动准备依赖并输入一次性配对码。
本目录只提供运行入口，不执行源码构建、依赖下载或数据库初始化；不会启动两个业务浏览器或执行商品任务。
安装前从项目部署指南确认目标数据和现有服务；不要在业务任务执行中切换版本。
根目录无 npm 依赖；手工部署所需依赖、数据库和服务配置见 backend/README.md。
在本目录由用户手动执行：

    npm run browser-open
    npm run browser-close

启动命令依次开启两个独立浏览器，关闭命令同时关闭两个实例。端口及 profile 保持独立。
这些命令需要 backend/ 部署文件和后端依赖；仅部署前端时不可使用。
