# Lyra 公开源码说明

本仓库保存 Lyra 当前源码、项目规格、测试代码及精确绑定的 DSH SDK 依赖包。首次公开于 2026-11-03，默认分支为 `main`。

## 安装与源码检查

使用 Node.js 24 或更新版本。

```sh
npm ci
npm run typecheck
```

Python 数据适配器位于 `adapters/`，运行对应适配器时需另行准备其 Python 依赖。例如 Baostock 适配器使用 `baostock`。

本机客户端入口为 `npm run sr:web`。需要连接自己的 PostgreSQL 数据库时，使用 `LYRA_PG_HOST`、`LYRA_PG_PORT`、`LYRA_PG_USER`、`LYRA_PG_PASSWORD` 和 `LYRA_PG_DATABASE` 配置连接。数据库密码由本机环境提供。

## 资料与验证范围

个人行情和公告原件、账户资料、研究产物、运行状态、凭据、交付记录和控制回执保存在本机。它们位于 Git 忽略的 `data/`、`var/`、`delivery/`、`.backfill/`、`.owlcoda/` 以及 `docs/handoff/` 等目录。

源码中的部分集成测试、离线演示和策略预览需要这些本地资料。首次克隆后可以安装依赖和运行类型检查，运行对应集成路径前需准备其声明的数据库和固定输入。引用上述目录的历史文档链接属于本机工程记录。

公开源码时的 L2 工作区已完成源码与隔离客户端路径验收。严格历史输入、真实 A/J 复核、个人账户输入、正式安装和效果评价仍有独立的接受条件。研究结论与原始数据继续按个人研究范围使用。

## 第三方依赖

`vendor/dsh/0.2.1-rc.1/` 保存 `package-lock.json` 所绑定的 SDK 包和间接依赖。各包声明为 MIT，许可和作者信息保留在原始压缩包内。Lyra 自有代码的公开可见性与第三方包的许可分别适用。
