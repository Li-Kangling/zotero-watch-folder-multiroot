# 上游与许可证

本项目由 Li-Kangling 维护，是 Jose Siqueira 的 [Zotero Watch Folder](https://github.com/josesiqueira/zotero-watch-folder) 的衍生版本。

- 上游基线：v2.8.6，提交 `32bc412`。
- 许可证：GPL-3.0-only，完整文本见 [LICENSE](LICENSE)。保留原作者版权和许可证声明。
- 修改日期：2026-10-23 至 2026-10-27。
- 改动：独立的多目录配置与界面、每根隔离的同步引擎、跨根及跨盘迁移、删除与恢复映射修复、恢复文件命名、独立发布与更新源。
- 原单目录入口和内部模块仍保留，供核心复用与上游行为回归；分发包的启动入口是 `bootstrap-multiroot.js`。

本项目不是上游官方版本。请在本仓库提交多目录版本的问题，不要将本项目的问题提交给原作者。

构建命令：`npm ci`、`npm test`、`npm run build`。对应源码包含构建脚本和锁定依赖文件；XPI 与源码包在同一 Release 提供。
