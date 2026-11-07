妙手在线自动化客户端 - Windows x64

1. 将整个 miaoshou-client-win-x64 文件夹解压到本机磁盘，不要只复制 start.cmd。
2. 双击 start.cmd。首次运行会打开配置文件：
   %USERPROFILE%\.miaoshou-auto\client-runtime\client.env
3. 填写 BUSINESS_BACKEND_URL=https://<入口>/<账号标识>/api/
   如果业务后端要求令牌或 Basic 认证，再填写相应配置。保存并关闭记事本。
4. 再次双击 start.cmd。默认浏览器会打开 http://127.0.0.1:3001/。
5. 在页面中分别点击“打开”，在对应窗口人工登录妙手和 1688。

保持启动命令窗口打开；需要停止客户端时在窗口按 Ctrl+C。关闭网页不会停止客户端。
包内已包含 Node 和 Chromium；用户电脑不需要 Node、npm、WSL2 或项目源文件。
配置和浏览器登录资料保存在当前 Windows 用户目录，不在发布包中。

如需核对包完整性，压缩包旁的 .sha256 文件记录了 ZIP 的 SHA-256；包内 SHA256SUMS.txt 记录逐文件摘要。
