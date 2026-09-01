# 传火网页版（web/）

> 平台会关停，记忆不会。——这是传火的**网页版**：浏览器打开即用，零安装、零命令行。
> 隐私承诺：**所有处理在本页内存完成，零上传，刷新即消失。** 页面无任何 CDN / 字体 / 统计外链，加载时不发出任何网络请求。

---

## 一、它是什么

一个纯静态单页（`web/index.html` + 内核编译产物 `web/app/`），四步完成记忆搬家：

1. **选来源**：ChatGPT / Claude / Character.AI / SillyTavern / 纯文本·Word / 本地网页（QQ 规划中）；平台已关停的用户走「粘贴文本」抢救路径
2. **选内容**：上传导出文件（.json / .zip / .txt / .docx / .jsonl / .html / 截图），或直接粘贴对话文本
3. **转换预览**：自动识别来源 → 内核全链（清洗/结构化/提纯）→ 消息条数、时间跨度、抽样 10 条预览
4. **下载记忆包**：三种格式（`.firelink.jsonl` / `.messages.jsonl` / `.md`），浏览器本地下载

高级设置（可选）：填入自己的 OpenAI 兼容 API Key 可启用纯文本自动分角色、记忆提纯、截图转写。Key 仅存于本页内存，不落 localStorage、不上传（请求只发往你自己填写的端点；不填 Key 全流程同样可用，相关功能自动降级）。

## 二、本地构建

网页版与 npm 包共用同一份内核源码（`src/`），构建只需 TypeScript（无打包器、零新增依赖）：

```bash
cd firelink
npm install          # 仅 TypeScript 工具链
npm run build:web    # 编译 src/ → web/app/（浏览器原生 ES Module）
```

构建原理（供维护者了解）：

- `src/io-impl.ts` 在模块加载时探测运行环境，动态 `import` 对应的边缘 IO 实现——Node 走 `io-node.ts`（node:fs 等），浏览器走 `io-browser.ts`（DecompressionStream / btoa / 纯 JS SHA-256），**浏览器模块图永远不会加载含 node: 依赖的文件**
- 浏览器直接加载 `web/app/` 下的原生 ESM 相对导入链，无需打包
- 修改内核源码后重新执行 `npm run build:web` 即可同步网页版

## 三、发布到 GitHub Pages（网页操作，约 2 分钟）

前提：`web/` 目录（含 `web/app/` 构建产物）已提交并推送到仓库 main 分支。

1. 打开仓库页面：`https://github.com/wakeupfirelink/firelink`
2. 点击顶部 **Settings**（设置）
3. 左侧栏找到 **Pages**（在 Code and automation 分组下），点进去
4. 在 **Build and deployment** 区域：
   - **Source** 选择 **Deploy from a branch**（从分支部署）
   - **Branch**：分支选 `main`，目录选 **`/ (root)` 旁边的下拉框，改成 `/web`**
   - 点 **Save**（保存）
5. 等待 1–3 分钟（页面顶部会出现绿色对勾「Your site is live」）
6. 访问：**https://wakeupfirelink.github.io/firelink/**

之后每次把更新后的 `web/` 推送到 main 分支，页面会在几分钟内自动更新。

> 说明：本目录 `web/` 不进 npm 包（package.json 的 `files` 仅含 `dist/src`），网页版与 npm 版互不影响。

## 四、常见问题

| 现象 | 处理 |
|---|---|
| 访问 404 | 检查 Pages 设置里 Branch 目录是否选了 `/web`；确认 `web/index.html` 已推送 |
| ZIP / docx 转换报「不支持 deflate 解压」 | 浏览器过旧（需 Chrome 103+ / Safari 16.4+ / Firefox 113+，对应 DecompressionStream 支持） |
| 填了 API Key 但智能功能没生效 | 该端点可能不允许浏览器直连（CORS）——换一个支持 CORS 的端点，或不用 Key 走纯本地转换 |
| 上传截图提示需要多模态 | 截图转写需在「高级设置」里填支持视觉的模型（如 gpt-4o 系列） |
| 想重新开始 | 结果页有「再搬一段记忆」按钮；或直接刷新页面（数据即消失，这正是隐私设计） |

## 五、验收口径（对齐施工案）

- [x] 浏览器网络面板零外发请求（页面自身；填 Key 后仅请求你配置的端点）
- [x] 无 Key 全流程可用（降级路径，消息全保留）
- [x] npm 包测试基线 107/103/0 零回归（`cd firelink && npm test`）
- [ ] ChatGPT / Claude / C.AI 真实导出样本浏览器内全流程（待真实导出文件实测）
- [ ] 手机浏览器可用（待 iPhone 实测）
