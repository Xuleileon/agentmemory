# AgentMemory 生产 Fork 与向量索引可靠性设计

日期：2026-08-11

## 目标

建立由 `Xuleileon/agentmemory` 维护的生产 fork，并将其克隆到
`E:\agentmemory`。生产实例固定运行该 fork 的构建产物，纳入已经完成的
时间戳、项目最新状态召回和 Cursor hooks 修改，同时修复批量回填时向量
只进入内存、未可靠落盘的问题。

完成后的可观察成功标准：

1. GitHub fork 的 `main` 包含全部定制提交，`upstream` 指向官方仓库。
2. AgentMemory 的实际 worker 与 CLI 来自同一个 fork、同一个提交。
3. memory、observation 和 import 三条写入路径都同时更新 BM25 与 Vector。
4. 并发写入不会并发保存多个完整索引；保存期间的新写入不会丢失。
5. 保存失败会保留 dirty 状态、暴露错误并可重试，不会被报告为持久化成功。
6. 可查询内存与磁盘的 BM25/Vector 数量、向量维度和最后保存状态。
7. 使用 `qwen3-embedding:4b`、2560 维重建全部可搜索记录并成功落盘。
8. AgentMemory 重启前后向量数量一致，跨语言召回结果仍包含目标记忆。

## 当前问题

当前启动器来自工作区 0.9.29，但生成的 `iii-config.yaml` 实际执行全局 npm
目录中的 0.9.28 worker。现有 Claude Code 回填通过 `remember` 生成向量并写入
进程内存，随后使用 `import` 修正源时间戳。0.9.28 对每条 memory import 都尝试
完整保存 BM25 与 Vector；16 并发造成大量重叠保存。审计显示最后一次向量
manifest 成功提交发生在 16:04:22，此后 1432 条 memory import 没有新的索引
提交。

`RERANK_ENABLED=true` 还会用本地分类模型的输出覆盖原始融合分数。当前输出
大量饱和为 1，因此 `score=1` 既不能判断向量通道是否参与，也会损伤排序的
可解释性。

## 仓库和发布模型

- GitHub 生产仓库：`Xuleileon/agentmemory`。
- 本地生产目录：`E:\agentmemory`。
- `origin` 指向用户 fork，`upstream` 指向 `rohitg00/agentmemory`。
- 用户 fork 的 `main` 是生产分支，直接包含已经完成的本地提交及本设计的
  后续实现提交。
- 生产配置使用绝对路径指向 `E:\agentmemory\dist\index.mjs`，不再引用全局
  npm 包。
- `.env`、API key、运行状态和备份不会提交到 Git。
- 同步官方更新时先合并 `upstream/main`，运行完整验证，再更新生产实例。

## 索引写入设计

### 统一写入入口

`remember`、`observe/compress`、export/import 和 JSONL replay 均通过共享的
索引函数写入 BM25 和 Vector。共享入口负责：

- 只索引可搜索且 `isLatest !== false` 的记录；
- 对 embedding 输入做长度限制；
- 校验 embedding 数量与维度；
- 单条失败只跳过该条并记录结构化错误；
- 批量路径使用 `embedBatch`，避免逐条网络往返。

KV 数据写入成功但 embedding 失败时，业务记录仍保留；索引状态将显示缺口，
完整 rebuild 可以补齐。

### 单飞持久化协调器

`IndexPersistence` 维护以下状态：

- `dirtyGeneration`：最近一次索引变更代次；
- `persistedGeneration`：最近一次成功落盘代次；
- `savePromise`：当前唯一的保存任务；
- `lastSuccessAt`、`lastErrorAt`、`lastError`；
- 内存与最近一次磁盘快照的 BM25/Vector 数量和向量维度。

每次索引新增、替换或删除只标记 dirty 并触发 debounce。若保存已在运行，新的
调用复用同一个 promise，不再启动第二次完整序列化。当前保存结束后，如果
`dirtyGeneration > persistedGeneration`，协调器再保存一次最新快照。

普通实时写入使用 debounce；批量 import/replay 在整个请求完成后调用一次显式
flush。进程正常退出前执行最终 flush。保存失败不得推进
`persistedGeneration`，dirty 状态保持，后续 debounce、显式 flush 或维护任务
可以重试。

### 原子快照

沿用现有分片加 manifest 的代际提交机制：先写新一代全部分片，全部成功后再
发布 manifest，最后清理旧代分片。BM25 与 Vector 分别有 manifest；状态接口
只有在两者均完成时才把本轮整体标为成功。任一失败都保留上一代可启动快照。

## 索引维护与可观测性

增加内部函数和受现有鉴权保护的 REST/MCP 入口：

- `index-status`：返回内存/磁盘 BM25 数量、内存/磁盘 Vector 数量、活动维度、
  dirty 状态、当前是否保存、最后成功时间与最后错误。
- `index-flush`：等待当前单飞保存并确保调用时的代次已持久化。
- `index-rebuild`：遍历 memory 与 observation，重新生成 BM25 和 Vector，使用
  临时索引构建；完整成功后替换活动索引并强制 flush。

rebuild 支持批大小配置和进度统计。单批 embedding 失败时记录失败 ID；存在
失败则不以“完整成功”结束，也不覆盖已持久化的可用快照。重跑对 KV 数据是
幂等的。

## Reranker 设计

混合检索继续保留 BM25、Vector 和 Graph 的原始分项分数及 RRF 融合分数。
reranker 只负责重排候选，不破坏这些诊断字段。

在应用 reranker 结果前检查：数量匹配、值有限、分数存在有效方差。输出全部
相同、近似饱和或格式不符合模型约定时，记录一次限流警告并回退原始 RRF
顺序。针对模型 label 的含义编写真实形状测试，避免把“不相关”类别的置信度
直接当相关度。

## 数据迁移和生产切换

1. 等待用户控制的当前回填进程结束，并记录最终导入数量。
2. 停止新的 hook 写入，等待在途请求完成。
3. 创建 `state_store.db` 的带时间戳备份并校验备份可读。
4. 构建 `E:\agentmemory`，生成固定指向该目录的 iii 配置。
5. 停止旧 worker，启动 fork worker，确认版本、提交和 embedding 配置。
6. 以 `qwen3-embedding:4b`、2560 维执行完整 rebuild。
7. 显式 flush，确认内存/磁盘向量数相等且 manifest 时间更新。
8. 记录一组中英文验收查询及结果，然后正常重启 worker。
9. 重启后再次确认数量、维度和查询结果一致。
10. 恢复 hooks，并验证一条新 observation 和一条新 memory 能在 debounce 后
    落盘，第二次重启后仍可召回。

任何阶段失败都停止切换并保留备份；不删除原数据库，也不以空索引覆盖最后
成功快照。

## 测试策略

所有行为修改遵循测试先行：

- import memory/observation 会生成对应向量；
- 每种新增、更新和删除路径都会标记索引 dirty；
- 多个并发 flush 只运行一个保存任务；
- 保存期间发生写入会自动追加一次最新代保存；
- 保存失败不推进 persisted generation，后续重试可以成功；
- rebuild 失败不会替换活动索引或发布新 manifest；
- rebuild 成功后序列化、反序列化数量与维度一致；
- reranker 输出饱和或 label 错误时回退 RRF；
- CLI 生成的 iii 配置与当前 fork 构建路径和版本一致。

验证层级依次为目标单测、相关测试集合、完整测试、TypeScript 构建、真实 Ollama
embedding、真实数据库重建、强制落盘和重启后召回。

## 非目标

- 不修改 embedding 模型或 2560 维配置。
- 不把运行数据或密钥纳入 Git。
- 不删除现有 memory、observation、graph 或 lessons。
- 不在本次工作中重构与索引生命周期无关的 AgentMemory 功能。
