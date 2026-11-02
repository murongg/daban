# 技能

[使用文档](README.md) · [English](../en/skills.md)

入口：Bot 工作区的 **技能** 面板。技能保存可复用的方法，也可以包含脚本、参考资料和模板。技能按 Bot 单独启用，不会凭说明增加工具权限。

## 内置 find-skills

系统自带 Daban 适配版 `find-skills`，默认供各 Bot 使用，可以在技能面板单独关闭。它是只读的系统技能，不需要另装命令行工具。

直接发消息，例如「帮我找一个适合处理 PDF 的技能」。Bot 可以检索 skills.sh、SkillsMP、ClawHub，或预览公开 GitHub 技能目录，说明用途、来源、版本和文件概况。确认安装后，系统保存预览中的固定内容，并为当前 Bot 启用，从下一次任务生效；其他 Bot 不会被自动启用。

拒绝安装后，同一任务不会继续对相同内容发起安装确认。安装技能不会执行脚本、钩子或依赖安装程序，也不提供平台专有工具。下载限流或网络失败时，可以稍后再试，或者使用本地导入。

## 本地导入与启用

1. 打开「导入技能」，选择技能文件夹、ZIP 或单份 `SKILL.md`。
2. 查看用途、文件列表和内容，再确认安装。安装只保存文件，不执行脚本或安装依赖。
3. 为需要的 Bot 单独启用；本地导入的自定义技能默认关闭。

各 Bot 共用已安装的技能，启用设置分别保存。编辑或替换会影响后续使用它的 Bot；已经运行的任务继续使用开始时捕获的版本。系统内置技能不允许编辑、替换或删除。

## 标准技能包

使用 [Agent Skills](https://agentskills.io/specification) 目录结构，例如：

```text
weekly-summary/
  SKILL.md
  scripts/report.py
  references/guide.md
  assets/template.csv
```

目录直接包含 `SKILL.md`，名称与 frontmatter 的 `name` 一致。可携带其他相对路径的文件，包括二进制模板。每包最多 200 个文件、解包后不超过 5 MiB，ZIP 不超过 6 MiB；不支持符号链接、特殊文件或越界路径。

```markdown
---
name: weekly-summary
description: 根据已提供的记录生成周报
license: MIT
compatibility: Python 3
metadata:
  author: example
---

先读取 references/guide.md。需要计算时准备完整目录，
从该目录运行 scripts/report.py，以便访问 assets/ 中的文件。
缺少记录时明确说明，不补造数字。
```

名称使用小写英文短名。标准包保留许可证、运行要求、元数据和 `allowed-tools` 声明，但这些声明不会自动授予权限。OpenClaw 的命名空间元数据按文件内容保留，不会自动执行其安装步骤或钩子。

## Bot 怎么使用

启用后，Bot 可以按需读取技能说明和资源，也可以准备完整目录后使用其中的脚本。Linux 中执行脚本仍使用现有命令和审批流程；缺少依赖时需要另行安装，安装后结果以执行记录为准。本机 Mac / Windows 模式提供托管资源文件供已授权的图形界面操作使用，不会因此新增宿主机 Shell 权限。

默认可按任务自动调用，也可用 `/<技能名>` 手动调用。`disable-model-invocation: true` 限制自动调用；`user-invocable: false` 限制手动入口，以面板显示为准。

## 编辑、导出与恢复

编辑 `SKILL.md` 会保留支持文件；要更新整个目录，请用「替换技能包」并核对版本。详情里可以预览或下载资源，也可以导出完整 ZIP。单独导出技能说明只包含 Markdown；分享完整技能请使用 ZIP 或[Bot 导出包](bot-transfer.md)。

移入回收站会关闭所有 Bot 对它的启用设置；恢复后需要重新启用。库中最多保留 100 份技能，含回收站，资源存储上限为 200 MiB。
