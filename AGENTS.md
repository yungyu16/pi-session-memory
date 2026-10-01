# pi-session-memory 维护指引

- 本仓库是公开的 Pi extension package，使用 MIT 许可证；以 Git 包安装，暂不发布 npm，保留 `private: true`。
- 扩展入口为 `src/index.ts`，由 `package.json` 的 `pi.extensions: ["./src/index.ts"]` 显式注册；不依赖 my-pi 或个人配置仓库。
- Pi 核心包由宿主提供，保留为 peer dependencies；devDependencies 固定验证版本。
- 使用 `.nvmrc` 声明的 Node.js 版本；修改后执行 `npm run check && npm test`，包清单或资源变化后执行 `npm pack --dry-run`，核验 loader 与资源完整性。
- 使用说明维护在 `README.md`，实现和设计说明维护在 `docs/`；公开内容不得包含真实凭据、个人绝对路径或内部项目信息。
- 不通过嵌套 PTY 启动 Pi；真实交互和视觉效果在本机 Pi 中重载后人工确认。
- 每个独立需求单独提交，使用中文 Conventional Commits；只暂存本次任务路径。
