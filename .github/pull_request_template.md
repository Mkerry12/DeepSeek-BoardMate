## 改了什么

<!-- 一两句话说明这个 PR 做了什么、为什么。关联 issue：Closes #123 -->

## 类型

- [ ] feat 新功能
- [ ] fix 修 bug
- [ ] refactor / chore / docs / test / ci

## 怎么测的

<!-- 本地跑了哪些命令、手动验证了哪些操作；界面改动请附截图或 GIF -->

- [ ] `client`: `npm run lint` / `npm run format:check` / `npm test`
- [ ] `server`: `ruff check .` / `ruff format --check .` / `pytest`
- [ ] `npm start` 手动试过相关功能

## 检查清单

- [ ] 没有提交 `.env`、令牌、API Key 等机密
- [ ] 改情绪标签 / 人设时，客户端与服务端两份保持一致
- [ ] 新增配置项已更新 `server/.env.example` 或文档
- [ ] 需要验证 Windows 打包时已加 `build` 标签
