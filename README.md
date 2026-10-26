# dsh-skill-manager

在 DeepSeek Harness（DSH）里管理**自定义 Skill**的插件：

- 左侧栏「SKILLS 管理」面板：查看、新建、导入、删除、查看详情。
- 会话「⋯」菜单「自定义 Skills」：查看 / 勾选 / 增删挂载到该会话的自定义 Skill。
- 对话输入框 `/mySkills`：自动列出挂载到本会话的自定义 Skill，勾选后把 `/<slug>` 插入本轮输入，随本轮对话生效。
- 输入 `/my` 即可补全出 `/mySkills`：补全行的标题是「自定义 SKILLS」，带技能图标与 `mySkills` 别名，选中或回车即打开同一个选择器。
- 对话输入框 `/` 补全：像 `/file`、`/plan` 一样，在补全菜单顶部单独分组「自定义 SKILLS」，每个自定义 Skill 带图标，选中即插入 `/<slug>`。

插件不修改 DSH 源码，所有数据放在 `~/.dsh`（或 `$DSH_HOME`）下；AI 能力直接复用 DSH 的默认模型配置，不需要填写任何令牌或 API Key。

## 安装

```bash
# 本地目录
dsh plugin --profile <profile> add /absolute/path/to/dsh-skill-manager

# 或直接从 GitHub 安装
dsh plugin --profile <profile> add git+https://github.com/Dechuan0629/dsh-skill-manager-cdc.git
```

或在 DSH Web UI 的插件市场 / `plugin_manager` 里安装本地目录。安装后插件会在 profile 的 `cordis.patch.yml` 中插入一行：

```yaml
- insert:
    - id: skill-manager
      name: dsh-skill-manager
```

重启 DSH（或重新加载 Web UI）后左侧栏出现「SKILLS 管理」。

## Skill 目录格式

```
<DSH_HOME>/skills/
└── pdf-digest-skill/          # 目录名必须以 -skill 结尾，ASCII kebab-case
    ├── SKILL.md               # 提示词正文（必须）
    └── scripts/               # 脚本目录（必须，可为空）
        └── extract.py
```

`SKILL.md` 使用 DSH 原生 frontmatter：

```markdown
---
name: pdf-digest-skill
description: 把 PDF 提取成结构化摘要
displayName: 文档速读
whenToUse: 用户要求阅读 PDF 或长文档时使用
user-invocable: true
disable-model-invocation: true
---

这里写完整的 Skill 提示词……
```

- `name`：ASCII kebab-case，且必须以 `-skill` 结尾；它就是 `/mySkills` 插入输入框的 `/name`。
- `description`：给模型看的用途说明。
- `displayName`：3–6 个汉字的显示名（面板、菜单、选择器里显示）。
- `user-invocable: true`：允许用户用 `/name` 主动调用。
- `disable-model-invocation: true`：不让模型在技能目录里自动挑选，只有用户显式调用或 `/mySkills` 勾选后才注入。

## 新建 Skill

面板里的「新建」支持两种方式：

1. **AI 生成**：输入一句话需求，调用 DSH 默认模型生成 `displayName` / `description` / `body` 草稿，可编辑后创建。
2. **手动编写**：直接填写提示词正文。

名称留空时，插件会调用一次 DSH 默认模型，阅读 `SKILL.md` 的定义并生成 3–6 个汉字的显示名；手动填写则直接使用（1–30 字）。模型不可用时自动降级为本地生成的名字，不会阻塞导入。

## 导入 Skill

支持 `.zip`、`.rar`、`.7z`、`.tar`、`.tar.gz`、`.tgz`、`.tar.bz2`、`.tar.xz` 等常见压缩包（借助系统 `bsdtar` / `unzip` 解压，不执行包内代码）。

压缩包内结构二选一：

```
# A. 带 xxx-skill 目录
demo-skill/SKILL.md
demo-skill/scripts/run.sh

# B. 压缩包根目录就是 skill 目录
SKILL.md
scripts/run.sh
```

导入分两步：先上传到暂存区做结构与 frontmatter 校验并返回预览，确认后再写入 `~/.dsh/skills/<slug>`；暂存 30 分钟过期，最多 5 份。压缩包内可以包含其它文件（如 `README.md`、`assets/`），插件只读取并导入 `SKILL.md` 与 `scripts/`，其余文件会被忽略并在预览里给出 warning。

## 会话挂载与 /mySkills

- 挂载关系保存在 `~/.dsh/skill-manager/state.json`（按会话 ID 记录 slug 列表），删除 Skill 时会自动从所有会话挂载中移除。
- `/mySkills` 在输入框输入时触发选择器，默认勾选本会话已挂载的全部自定义 Skill；确认后输入框出现 `/<slug>`，DSH 原生 skill 机制会把这些 Skill 的提示词注入本轮对话。
- 也可以在输入框键入 `/my`，在补全菜单里选「自定义 SKILLS · /mySkills」打开同一个选择器；它注册为 client 命令（`commandUi`），所以补全行会像 `/plan` 一样显示标题与别名。命令路径与输入手势分享同一个草稿写入通道，选中后同样只改草稿、不发送。
- 会话「⋯」→「自定义 Skills」弹窗在勾选发生变化前，「保存挂载」保持禁用，避免误点把已挂载项清空。
- 会话「⋯」菜单 →「自定义 Skills」可随时增删挂载。
- `/` 补全里的「自定义 SKILLS」分组只负责插入 `/<slug>`；它与 DSH 自带的「技能」分组一样走 `dsh-tool-skill` 的 `/slug` 手势，不发送消息、不改写草稿里的其它内容。

## HTTP 接口

所有接口都在 `webServer` 上注册为精确路径，只接受同源（loopback）请求：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-skill-manager/state` | 技能列表、无效目录、模型状态、限制 |
| GET | `/dsh-skill-manager/session?sessionId=` | 某会话的挂载与可用技能 |
| POST | `/dsh-skill-manager/import` | 原始压缩包字节；`x-skill-manager-filename` 头携带文件名 |
| POST | `/dsh-skill-manager/action` | `generate` / `generate-name` / `create` / `create-imported` / `discard-import` / `delete` / `content` / `mounts` |

错误统一为 `{ "ok": false, "error": { "code": "...", "message": "..." } }`，状态码见 `lib/errors.js`。

## 限制

| 项 | 上限 |
| --- | --- |
| 压缩包 | 32 MB |
| 解压总量 | 64 MB |
| 解压文件数 | 500 |
| 单文件 | 10 MB |
| `SKILL.md` | 2 MB |
| 单会话挂载数 | 100 |
| 暂存份数 / 有效期 | 5 / 30 分钟 |

## 目录结构

```
dsh-skill-manager/
├── index.js                 # Host 入口：注入 webServer，注册 4 条路由
├── client.js                # Client 入口：面板、会话菜单、/mySkills 选择器
├── cordis.patch.yml         # bundle 补丁：插入 skill-manager 行
├── icon.svg
├── package.json
├── lib/
│   ├── archive.js           # bsdtar/unzip 解压、路径校验、limits
│   ├── catalog.js           # ~/.dsh/skills 的扫描 / 读写 / 删除
│   ├── errors.js            # SkillError + 状态码映射
│   ├── http.js              # 同源校验、请求体读取、JSON 响应
│   ├── llm.js               # 走 DSH 默认模型：起名 / 生成草稿
│   ├── manifest.js          # SKILL.md frontmatter 解析与序列化
│   ├── naming.js            # 显示名 / slug 规则、AI 结果归一化
│   ├── paths.js             # ~/.dsh 布局、slug 与路径安全
│   ├── staging.js           # 导入暂存（TTL / 数量上限）
│   └── store.js             # 会话挂载状态持久化
└── test/                    # node --test（unit / archive / llm / host）
```

## 开发

```bash
# 语法检查
node --check index.js && node --check client.js

# 测试（需要 DSH 自带的 node）
node --test test/*.test.mjs
```

测试使用临时 `DSH_HOME`，不会读写真实的 `~/.dsh/skills`。
