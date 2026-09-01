# 传火 Firelink

> 平台会关停，记忆不会。

**Firelink**（传火）是一个纯本地运行的开源工具：把你在各 AI 伴侣 / AI 聊天平台的聊天记录，转换成结构化的「记忆包」——在你更换平台、平台停服、或只是想给自己的数据做一份备份时，让那段记忆跟着你走。

*Firelink is a fully-local, open-source tool that converts your AI companion / AI chat platform export files into structured "memory packs" — so when a platform shuts down, your shared memories survive. No account, no cloud, no telemetry. Pure TypeScript, zero runtime dependencies, MIT licensed.*

---

## 隐私承诺（先读这个）

- **所有处理都在你的电脑上完成。** 没有账号，没有云端，没有上传。
- **零遥测。** 本工具不发送任何统计、崩溃报告或使用数据。
- **零网络行为**，除非你主动提供自己的 LLM API Key 用于可选的转写功能（见下文），且请求只发往你指定的服务商。
- 你的聊天记录属于你。我们不碰它，也碰不到它。

---

## 它能做什么

把以下来源的聊天记录解析为统一格式，经清洗、去重、提纯后，导出三种格式的「记忆包」：

| 来源 | 输入形态 | 说明 |
|------|---------|------|
| ChatGPT | 官方导出 `conversations.json` | 官方数据导出功能获取 |
| Claude | 官方导出 `conversations.json` | 官方数据导出功能获取 |
| Character.AI | 官方导出 ZIP | 官方数据导出功能获取 |
| 纯文本 / Word | `.txt` / `.docx` | 聊天记录粘贴或保存的文档；无 LLM Key 时降级为纯解析 |
| SillyTavern | `.jsonl` 聊天记录 | 社区标准格式 |
| 本地网页 | 保存的 `.html` 页面 | 浏览器「另存为」的完整页面 |
| 截图 | `.png` 等图片 | 需要 multimodal LLM（BYO Key）转写为文字 |
| QQ | 官方导出 | 规划中（NotImplemented 占位） |

**导出的记忆包包含三种格式**：机器可读的 `wakeup-mem` JSON、逐条消息 JSON、以及人类可直接阅读的 Markdown——你可以随时检查工具处理了什么，没有黑盒。

> 名词说明：`wakeup-mem` 是本项目沿用的历史包格式名，来自上游 [wake up! alive!](#项目背景) 项目。

## 快速开始

```bash
# 需要 Node.js >= 18
git clone https://github.com/wakeupfirelink/firelink.git firelink
cd firelink
npm install        # 仅安装 TypeScript 工具链，无任何运行时依赖
npm test           # 编译 + 跑全部测试（107 个，4 个依赖本地样本的用例自动跳过）
```

以编程方式使用（示例）：

```ts
import { runLiteFromSource } from 'firelink/dist/src/adapters/registry.js';

// input: 文件内容（Buffer / 字符串），会自动嗅探来源类型
const result = await runLiteFromSource({ input });
// result.l0          —— 解析出的原始消息（统一 schema）
// result.memories    —— 清洗、去重、截断后的记忆条目
// result.exports     —— 三格式记忆包
// result.adapter     —— 嗅探结果（来源名 + 置信度）
```

## 可选的 LLM 能力（BYO Key）

两个功能需要你自己的 LLM API Key（OpenAI 兼容接口即可），**不提供 Key 也能使用全部核心功能**：

- **纯文本/Word 分角色**：无明确格式时，用 LLM 判断每段话是谁说的；无 Key 时降级为按段头规则解析
- **截图转写**：把聊天截图转写为文字记录；此功能必须提供 multimodal Key（无确定性兜底，缺 Key 时明确报错）

Key 只在你本机内存中使用，不落盘、不出现在任何日志里。

## 它不是什么

- **不是爬虫。** 本项目只读取**你自己导出的、你自己账号的**数据文件。它不登录任何平台、不模拟任何客户端、不自动化抓取任何网站。
- **不是平台官方工具。** 本项目不隶属、不关联、未被授权于任何平台。
- **不替你保管数据。** 没有云端，没有备份服务——你的数据只存在于你的磁盘上。

## 免责声明

1. 本项目仅用于**用户本人账号、本人数据**的迁移与备份。
2. 各平台的数据导出格式可能随版本变化；解析失败时请提 issue 附上格式片段（记得脱敏）。
3. 你对使用本工具产生的任何数据处理行为及其后果负责。
4. 本项目按 MIT 协议提供，不提供任何担保。

## 项目承诺

- **永不加付费墙，永不搞 Pro 版功能锁定。** 本仓库的全部功能永远免费开源。
- **保持纯本地。** 任何引入网络上报、遥测、账号体系的 PR 都不会被接受。

## 项目背景

传火是 wake up! alive! 项目的记忆内核——一个为 AI 伴侣用户做的、关于「平台会停服，记忆不该陪葬」的长期计划：从聊天记录抢救（传火），到记忆引擎（提纯与反哺），到本地大脑。

取名来自那个古老的隐喻：火之将熄，传火续之。

本项目由人类主导设计、AI Agent 协作施工完成。AI 参与了代码实现，产品决策与边界由人类作者把关。

## License

[MIT](./LICENSE) · Copyright (c) 2026 传火（Firelink）项目贡献者
