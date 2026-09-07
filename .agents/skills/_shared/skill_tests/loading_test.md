# Loading Test（加载测试）

验证：metadata（type/loading/priority）是否正确标记，Agent 是否按标记加载。

## 检查项

1. **主 SKILL.md**：无 metadata 标记（默认加载，热路径）
2. **技法模块**（references/*.md ≤80 行）：无 metadata（按路由加载，热路径候选）
3. **深档**（>80 行）：必须有 metadata frontmatter：
   - type: knowledge（标记为知识型，非指令型）
   - loading: on-demand（标记为按需加载，非默认加载）
   - priority: high/medium/low（优先级提示）
   - domain: [技能名]（领域标记）
   - size: 行数（供上下文预算）

## 验证方法

```bash
# 检查所有 >80 行文件是否有 metadata
for f in $(find /Users/hui/.agents/skills -name '*.md' | xargs wc -l | awk '$1 > 80 {print $2}'); do
  head -1 "$f" | grep -q '^---' && echo "OK $f" || echo "MISSING $f"
done
```

## 判定标准

- 所有深档（>80 行）都有 metadata ✅
- loading: on-demand 的深档不会被默认加载 ✅
- 主文件/模块无多余 metadata（保持轻量）✅
