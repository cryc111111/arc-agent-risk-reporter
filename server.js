import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { createMarketReport, summarizeMarketReport } from './research.js';

dotenv.config();

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.disable('x-powered-by');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const RPC_URL = process.env.RPC_URL || 'https://rpc.testnet.arc.network';
const EXPECTED_CHAIN_ID = BigInt(process.env.CHAIN_ID || '5042002');
const SELLER_RECEIPT_ADDRESS = process.env.SELLER_RECEIPT_ADDRESS;
const ADMIN_STATUS_TOKEN = process.env.ADMIN_STATUS_TOKEN || process.env.GATEWAY_ACCESS_TOKEN;
const X402_PRICE = process.env.X402_PRICE || '$0.1';
const ARC_CHAIN_NAME = 'arcTestnet';
const ARC_NETWORK = `eip155:${EXPECTED_CHAIN_ID.toString()}`;
const GATEWAY_FACILITATOR_URL = process.env.GATEWAY_FACILITATOR_URL || 'https://gateway-api-testnet.circle.com';
const REPORT_CACHE_MS = Number(process.env.REPORT_CACHE_MS || 5 * 60 * 1000);
const API_RATE_LIMIT = Number(process.env.API_RATE_LIMIT_PER_MINUTE || 60);
const PREMIUM_RATE_LIMIT = Number(process.env.PREMIUM_RATE_LIMIT_PER_MINUTE || 10);

const provider = new ethers.JsonRpcProvider(RPC_URL, Number(EXPECTED_CHAIN_ID));
let reportCache = null;
let reportCacheCreatedAt = 0;
let reportPromise = null;
const rateBuckets = new Map();
const rateCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}, 60000);
rateCleanupTimer.unref();

if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
}

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '5m' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

function nowIso() {
  return new Date().toISOString();
}

function createRateLimiter(prefix, limit) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${prefix}:${req.ip}`;
    const current = rateBuckets.get(key);
    if (!current && rateBuckets.size >= 10000) {
      return res.status(429).json({ error: 'Rate limiter capacity reached' });
    }
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + 60000 } : current;
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    if (bucket.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}

app.use('/api', createRateLimiter('api', API_RATE_LIMIT));
app.use('/api/premium', createRateLimiter('premium', PREMIUM_RATE_LIMIT));
app.use('/health', createRateLimiter('health', 30));

function secretsEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function getMarketReport() {
  if (reportCache && Date.now() - reportCacheCreatedAt < REPORT_CACHE_MS) {
    return reportCache;
  }
  if (!reportPromise) {
    reportPromise = createMarketReport()
      .then((report) => {
        reportCache = report;
        reportCacheCreatedAt = Date.now();
        return report;
      })
      .finally(() => { reportPromise = null; });
  }
  return reportPromise;
}

function validateStartupConfig() {
  const problems = [];

  if (!ethers.isAddress(SELLER_RECEIPT_ADDRESS || '')) {
    problems.push('SELLER_RECEIPT_ADDRESS must be a valid EVM address.');
  }

  if (!RPC_URL.startsWith('http')) {
    problems.push('RPC_URL must be an HTTP(S) endpoint.');
  }

  if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
    problems.push('PORT must be a valid TCP port.');
  }

  return problems;
}

async function getArcNetworkStatus() {
  const network = await provider.getNetwork();
  const blockNumber = await provider.getBlockNumber();
  const chainMatches = network.chainId === EXPECTED_CHAIN_ID;

  return {
    ok: chainMatches,
    chainId: network.chainId.toString(),
    expectedChainId: EXPECTED_CHAIN_ID.toString(),
    blockNumber,
    network: ARC_CHAIN_NAME
  };
}

async function attachCircleGatewayRoutes() {
  try {
    const { createGatewayMiddleware } = await import('@circle-fin/x402-batching/server');
    const gateway = createGatewayMiddleware({
      sellerAddress: SELLER_RECEIPT_ADDRESS,
      facilitatorUrl: GATEWAY_FACILITATOR_URL,
      networks: ARC_NETWORK
    });

    const preparePaidReport = async (req, res, next) => {
      try {
        req.marketReport = await getMarketReport();
        next();
      } catch (error) {
        console.error(`[${nowIso()}] paid market report unavailable: ${error.message}`);
        res.status(503).json({ error: 'Multi-source market report unavailable; no payment was requested.' });
      }
    };
    const sendPaidReport = async (req, res) => {
      res.json({
        status: 'success',
        network: ARC_CHAIN_NAME,
        settlement: 'circle-gateway-x402',
        data: { report: req.marketReport }
      });
    };

    app.get('/api/premium/x402/market-analysis', preparePaidReport, gateway.require(X402_PRICE), sendPaidReport);

    console.log(`[${nowIso()}] Circle x402 route enabled: GET /api/premium/x402/market-analysis (${X402_PRICE}, ${ARC_CHAIN_NAME})`);
    console.log(`[${nowIso()}] Circle facilitator: ${GATEWAY_FACILITATOR_URL} (${ARC_NETWORK})`);
  } catch (error) {
    console.warn(`[${nowIso()}] Circle x402 route disabled: check @circle-fin/x402-batching and @x402/evm dependencies.`);
    console.warn(`[${nowIso()}] ${error.message}`);
  }
}

app.get('/api/market/summary', async (req, res) => {
  try {
    const report = await getMarketReport();
    res.json({ status: 'success', data: { summary: summarizeMarketReport(report) } });
  } catch (error) {
    console.error(`[${nowIso()}] market summary failed: ${error.message}`);
    res.status(503).json({ error: 'Market data unavailable' });
  }
});

app.get('/api/gateway/balance', async (req, res) => {
  const address = String(req.query.address || '');
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }
  try {
    const response = await fetch('https://gateway-api-testnet.circle.com/v1/balances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'USDC', sources: [{ depositor: address, domain: 26 }] }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `Gateway balance request failed (${response.status})`);
    const balance = data.balances?.[0];
    res.json({
      status: 'success',
      data: {
        address: ethers.getAddress(address),
        available: balance?.balance || '0',
        pendingBatch: balance?.pendingBatch || '0',
        network: ARC_NETWORK
      }
    });
  } catch (error) {
    console.error(`[${nowIso()}] gateway balance lookup failed: ${error.message}`);
    res.status(503).json({ error: 'Circle Gateway balance is temporarily unavailable' });
  }
});

app.get('/health', async (req, res) => {
  try {
    const arc = await getArcNetworkStatus();
    res.status(arc.ok ? 200 : 503).json({
      status: arc.ok ? 'ok' : 'degraded',
      service: 'arc-agent',
      network: ARC_CHAIN_NAME,
      arc
    });
  } catch (error) {
    res.status(503).json({
      status: 'degraded',
      service: 'arc-agent',
      network: ARC_CHAIN_NAME
    });
  }
});

app.get('/api/status', async (req, res) => {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '') || req.header('x-status-token');
  if (!ADMIN_STATUS_TOKEN || !secretsEqual(token, ADMIN_STATUS_TOKEN)) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const arc = await getArcNetworkStatus();
    res.json({
      service: 'arc-agent',
      network: ARC_CHAIN_NAME,
      sellerAddress: SELLER_RECEIPT_ADDRESS,
      x402Price: X402_PRICE,
      paidProduct: 'BTC/ETH market analysis',
      reportCacheMs: REPORT_CACHE_MS,
      arc
    });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

const configProblems = validateStartupConfig();
if (configProblems.length > 0) {
  console.error(`[${nowIso()}] Configuration error:`);
  for (const problem of configProblems) {
    console.error(`- ${problem}`);
  }
  process.exit(1);
}

await attachCircleGatewayRoutes();

app.listen(PORT, HOST, () => {
  console.log(`[${nowIso()}] ARC agent listening on ${HOST}:${PORT}`);
  console.log(`[${nowIso()}] Network: ${ARC_CHAIN_NAME} (${EXPECTED_CHAIN_ID.toString()})`);
  console.log(`[${nowIso()}] Seller: ${SELLER_RECEIPT_ADDRESS}`);
});
