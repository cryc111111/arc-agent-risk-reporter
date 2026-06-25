# ARC Agent Risk Reporter

ARC Agent Risk Reporter 是一个运行在 ARC Testnet 上的加密市场风险分析项目。它可以生成 BTC/ETH 行情分析报告，提供公开市场摘要，并通过 Circle Gateway x402 提供付费高级报告。

## 功能

- BTC/ETH 多数据源行情分析
- 支持 Binance、Coinbase、Kraken、CoinGecko 数据
- 可选 DeepSeek AI 生成增强分析
- Express API 服务
- 前端行情仪表盘
- Circle Gateway x402 付费报告接口
- Buyer Agent 自动判断是否购买付费报告
- 基础安全头、限流、管理员状态接口保护

## 文件结构

```text
server.js         # API 服务和前端页面服务
agent.js          # x402 buyer agent，自动购买付费报告
research.js       # 行情数据采集和分析逻辑
public/           # 前端页面
package.json      # 项目脚本和依赖
