# AGENTS.md — 给 agent 的固定上下文

## 工作前

1. 读 `STATUS.md` 的 `next` 字段
2. 读 `README.md` 了解项目用途
3. `git status` 确认工作区干净

## 常用命令

```bash
# 安装
# 运行
# 测试
```

## 约定

- 不要提交 `.env`、`node_modules/`、`.venv/`、构建产物
- 修改行为/接口时同步更新 `README.md`
- 每轮结束更新 `STATUS.md` 的 `updated` 与 `next`

## 完成标准（agent 收尾，不需要人参与）

1. 代码已提交并推送：`git status` 干净、分支有 upstream 且无未推送提交
2. `README.md` 里有结论 / 用法
3. `STATUS.md` 改为 `status: done`（`updated` 同步）
4. 跑 `dev done <slug>`：校验提交/推送、标记 done、刷新索引；有问题会**非零退出**，修完重跑
5. **不要自行 `dev archive`**：归档会移动目录、让 DSH 工作区绑定失效，留给人在终端做

> 中途每轮结束：更新 `STATUS.md` 的 `updated` 与 `next`，顺手跑 `dev index` 刷新根索引；不用跑 `dev done`。
