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

安装
npm install

环境变量
请在服务器本地创建 .env 文件，不要上传到 GitHub
PORT=3000
HOST=0.0.0.0
RPC_URL=https://rpc.testnet.arc.network
CHAIN_ID=5042002

SELLER_RECEIPT_ADDRESS=0xYourSellerReceiptAddress
X402_PRICE=$0.1
GATEWAY_FACILITATOR_URL=https://gateway-api-testnet.circle.com

ADMIN_STATUS_TOKEN=change-this-token

CIRCLE_API_KEY=your-circle-api-key
CIRCLE_ENTITY_SECRET=your-circle-entity-secret
CIRCLE_BUYER_WALLET_ID=your-circle-wallet-id
CIRCLE_BUYER_ADDRESS=0xYourBuyerWalletAddress

DEEPSEEK_API_KEY=your-deepseek-api-key

运行
npm run seller
npm run buyer
npm run check

API
GET /：前端页面
GET /health：健康检查
GET /api/market/summary：公开行情摘要
GET /api/gateway/balance?address=0x...：查询 Gateway 余额
GET /api/premium/x402/market-analysis：x402 付费高级报告
GET /api/status：管理员状态接口，需要 token

安全提醒
不要提交 .env
不要公开 Circle API Key、Entity Secret、钱包私钥、GitHub Token
如果密钥误传，立即删除公开内容并轮换密钥
正式公开部署前，请设置强 ADMIN_STATUS_TOKEN
测试钱包只放实验所需金额

License
ISC
