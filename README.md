# 医疗放射治疗剂量计划验证与器官风险评估系统

本项目使用 React + Vite + TypeScript + Node.js + Fastify，提供专业分析工作流、参数计算、复核门禁和结果追踪。

```bash
npm install
npm run build
npm run dev
```

后端端口：6202；前端通过 Vite 代理访问 `/api`。

签发与放行共用同一门禁判定（剂量约束、最新 QA、同行复核清单、未关闭高等级偏差）；任一阻断存在时签发与放行均被拒绝并记入审计，重复请求幂等。端到端一致性验证（需先启动 API）：

```bash
npm run dev   # 或 npm start
npm run verify
```
