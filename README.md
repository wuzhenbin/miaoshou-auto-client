# 妙手自动化部署目录

将本目录内容上传到目标项目目录，包含 package.json、deployment-manifest.json、frontside/ 和 backend/。
根目录无依赖，无需 npm install；在 backend/ 执行 npm ci --omit=dev 安装后端依赖。
业务配置、数据库迁移、Chromium 安装及静态服务配置见 backend/README.md 和项目部署文档。
在本目录由用户手动执行：

    npm run browser-open
    npm run browser-close

启动命令依次开启两个独立浏览器，关闭命令同时关闭两个实例。端口及 profile 保持独立。
这些命令需要 backend/ 部署文件和后端依赖；仅部署前端时不可使用。
