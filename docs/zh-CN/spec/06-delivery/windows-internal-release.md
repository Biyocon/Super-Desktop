# Windows Super-Desktop 内部候选

> **翻译说明：** 本页是与 [英文源规格](/spec/06-delivery/windows-internal-release) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

## 身份与兼容性

候选为 `0.15.7-super.1`，仅 Windows x64。发布**等待用户验收**；源代码合并不等于安装验收。

| 项目 | Windows 规范 |
| --- | --- |
| 应用 / AUMID / NSIS 升级身份 | `io.github.biyocon.super-desktop` |
| 包 / 可执行文件 | `super-desktop` / `Super-Desktop.exe` |
| 产品 / 快捷方式 / 卸载显示名 | `Super-Desktop` |
| 正式数据 | `~/.super-desktop` |
| 开发数据 | `~/.super-desktop-dev` |
| Electron 正式 / 开发 userData | `<appData>/Super-Desktop` / `<appData>/Super-Desktop Dev` |
| 更新资源 / 发布链接 | `Biyocon/Super-Desktop` |
| 内部 `-super.` 更新模式 | 禁用检查、下载、安装与调度 |
| 卸载策略 | 保留数据，移除所属程序、快捷方式及安装注册 |

在获取 Electron 的 userData 范围单实例锁和启动子进程前设置名称、配置目录及 AUMID。
第二次启动同一配置时聚焦已有实例并退出。显式 `--user-data-dir` 优先；
`PI_DESKTOP_DATA_DIR` 保留原有独立测试时不获取单实例锁的行为。构建显式选择 Windows overlay。
macOS/Linux 的标识符、目录及更新策略不变。

不自动导入或迁移 PI-Desktop 或既有分支开发数据。这是独立 Windows 安装，不替换上游。
见[身份 ADR](../../../adr/windows-super-desktop-identity.md)。

## 构建与本地验收

复用现有兼容 Node/pnpm/Rust。JS、runtime bundle 与静态 CRT x64 host 的可变输出属于任务。
在 `apps/desktop` 执行：

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
pnpm.cmd exec electron-builder --config electron-builder.windows.cjs --win nsis --x64 --publish never
```

绝不在工作主机运行安装或卸载程序。`node scripts/e2e-windows-package.mjs` 仅启动解包可执行文件，
隔离 HOME/USERPROFILE、userData、代理注册及 runtime 代理数据；检查真实包字节、版本、沙箱 preload、
host 握手、设置/会话/宠物选择的重启保留、单实例及禁用更新。现有 capture 模式仅在退出前启用，
不在启动时启用，只抑制应用自身退出确认；不代表安装程序或 Windows 警告验收。不会调用模型、语音、图像或麦克风。

记录源 commit/tree、工具链、安装文件名/大小/SHA-256、Authenticode 与 PE 版本、资源哈希、截图及清理。
私有证据和二进制不进入源 Git。不发布 Release、标签、安装资产或更新源，也不启动发布工作流。
`release.mjs <prerelease> --offline` 仅离线准备版本；稳定版本或 `--tag` 与 `--offline` 组合在写入前拒绝。
稳定形式 `0.15.7` 的 changelog 是候选预览文档，不表示已公开发布。

## 必须的虚拟机验收

只允许一个新建、任务所有的 Hyper-V 客体及**已有合法 Windows 镜像**。不下载 ISO、不购买许可，
不修改主机功能、网络或安全策略，不重启主机。只共享任务安装文件及无敏感数据的 fixtures。

1. 记录同一新身份的较低基线版本及来源；合成基线必须标明，不能冒充公开历史发布。
2. 安装并启动，检查 UI、文件、快捷方式、注册及进程。
3. 写入无敏感设置、会话/历史行和宠物选择，记录 ID 与哈希。
4. 使用最终安装文件或经证明字节相同的候选升级，验证身份/内容保留及仅一个安装。
5. 卸载后验证程序、快捷方式、注册移除，数据保留，所属进程结束，并保存各阶段截图。

候选未签名（`NotSigned`），Windows 可能显示未知发布者、SmartScreen 或 UAC 警告。
不得禁用或绕过。必要用户操作缺失时仍阻塞。本次没有已知合法镜像，安装/升级/卸载
**阻塞、未验证**；不得改为主机安装，不得称安装已验收。

真实听写、实际生成宠物/动画质量仍**未验收**；实体多显示器/断开测试推迟。
完整 Windows 测试限制保留在[失败矩阵](../../../project/windows-internal-release/failure-matrix.md)。
