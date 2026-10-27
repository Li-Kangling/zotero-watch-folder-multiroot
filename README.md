# Watch Folder 多目录

让多个本地 PDF 文件夹与 Zotero 分类保持对应。每个监控目录独立绑定一个顶层分类，子目录按原层级映射。

基于 [Jose Siqueira / Zotero Watch Folder v2.8.6](https://github.com/josesiqueira/zotero-watch-folder)，由 Li-Kangling 维护，采用 **GPL-3.0-only**。这是独立衍生版本，非上游官方版本。[上游及修改声明](UPSTREAM.md) · [完整使用说明](MULTIROOT.md)

## 下载与安装

1. 从 [本项目 Releases](https://github.com/Li-Kangling/zotero-watch-folder-multiroot/releases/latest) 下载 `zotero-watch-folder-multiroot-*.xpi`。不要下载上游单目录版。
2. Zotero → 工具 → 插件 → 齿轮 → 从文件安装插件。
3. 停用原版 Watch Folder，以及其他会自动移动同一批附件的插件规则。
4. 设置 → Watch Folder 多目录 → 添加本地目录。先用少量测试 PDF 验证。

发布版面向 **Zotero 10.x**；实际测试环境为 Windows、Zotero 10.0.6。未承诺 macOS/Linux、网络盘、云盘占位文件或数万文件规模兼容。

## 能做什么

- 多个独立监控目录，各自建顶层分类，保留完整子目录结构。
- 本地 PDF 以链接附件导入；不同位置的相同副本各自独立管理。
- 分类与目录双向改名、移动；跨根迁移保留附件 key 和批注。
- 可选择仅导入、双向镜像不联动删除、双向镜像并可恢复删除。
- 单文件删除自动联动；多个文件或整个目录的删除需要确认。
- 暂停/恢复、重新定位、解除绑定；冲突隔离，不确定时停止相关对象。
- 使用元数据命名模板，恢复文件也遵循当前自动命名设置。

## 使用前注意

**镜像和删除联动会修改磁盘文件及 Zotero 条目。请先备份目录和 Zotero 数据目录。**

- 只监控专门的论文目录，不要选整个磁盘、下载目录或含代码/临时文件的总目录。
- 链接附件不通过 Zotero Storage / WebDAV 同步文件，跨设备需单独同步本地目录；不要把 Zotero 数据库放进网盘实时同步。
- Zotero → 本地删除保留在 `.zotero-watch-trash`；本地外部删除的恢复位置由 Windows/删除工具决定，插件不能找回被外部永久删除的文件。
- 旧的内部存储附件可能保留 storage 原件和本地镜像副本；新导入的本地链接附件直接使用原文件。
- 跨盘迁移的源备份保留在源根回收区，会额外占用空间。
- 解除绑定保留两端内容；有未完成迁移时不能解除绑定。

## 从本地版本升级

插件 ID 保持 `watch-folder-multiroot@local.zotero`，现有配置与映射保留。旧的 2.8.6.3 本地版没有本项目更新源，需手动安装一次新版；之后从本仓库检查更新。

## 开发与验证

```sh
npm ci
npm test
npm run build
npm run source
```

安装包和对应源码包生成在工程父目录。`npm run build` 只构建，不上传；`npm run release` 会先测试和构建，再调用已登录的 GitHub CLI 发布。

2026-10-27 重新运行：**1062 项自动测试，30 个文件全部通过**。2026-10-26 的 2.8.6.3 在独立 Zotero 合成文库中通过 **33 项实测**；本次发布仅调整文档、构建和更新配置，不修改同步核心。历史实测不等于所有环境均已验证。

问题与反馈：[Issues](https://github.com/Li-Kangling/zotero-watch-folder-multiroot/issues)。提交日志前请删除个人路径和敏感信息。

## 许可证

[GNU GPL v3 only](LICENSE)。保留上游作者及版权声明。发布修改后的安装包时，应按许可证提供相应源码及构建材料。
