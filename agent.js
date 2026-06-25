import dotenv from 'dotenv';
import fs from 'fs/promises';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createEIP1193Provider } from '@circle-fin/developer-controlled-wallets/evm';
import { BatchEvmScheme, CHAIN_CONFIGS } from '@circle-fin/x402-batching/client';
import { formatUnits, getAddress, parseUnits } from 'viem';
import { isMarketReport } from './research.js';

dotenv.config();

const PORT = process.env.PORT || 3000;
const CHAIN = process.env.AGENT_CHAIN || 'arcTestnet';
const TARGET_URL = process.env.AGENT_TARGET_URL || `http://127.0.0.1:${PORT}/api/premium/x402/market-analysis`;
const SUMMARY_URL = process.env.AGENT_SUMMARY_URL || `http://127.0.0.1:${PORT}/api/market/summary`;
const PAID_DATA_URLS = (process.env.AGENT_PAID_DATA_URLS || TARGET_URL).split(',').map((value) => value.trim()).filter(Boolean);
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
const CIRCLE_ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET;
const CIRCLE_BUYER_WALLET_ID = process.env.CIRCLE_BUYER_WALLET_ID;
const CIRCLE_BASE_URL = process.env.CIRCLE_BASE_URL;
const CIRCLE_BUYER_ADDRESS = process.env.CIRCLE_BUYER_ADDRESS;
const INTERVAL_MS = Number(process.env.AGENT_INTERVAL_MS || 30000);
const MIN_PURCHASE_INTERVAL_MS = Number(process.env.AGENT_MIN_PURCHASE_INTERVAL_MS || 15 * 60 * 1000);
const DAILY_BUDGET = parseUnits(process.env.AGENT_DAILY_BUDGET_USDC || '0.01', 6);
const MAX_PURCHASE = parseUnits(process.env.AGENT_MAX_PURCHASE_USDC || '0.002', 6);
const STATE_FILE = process.env.AGENT_STATE_FILE || '.agent-state.json';
const MIN_GATEWAY_BALANCE = parseUnits(process.env.AGENT_MIN_GATEWAY_BALANCE || '0.001', 6);
const GATEWAY_DEPOSIT_ON_START = process.env.AGENT_GATEWAY_DEPOSIT_ON_START === 'true';
const GATEWAY_DEPOSIT_AMOUNT = process.env.AGENT_GATEWAY_DEPOSIT_AMOUNT || '1.0';

if (!CIRCLE_API_KEY || !CIRCLE_ENTITY_SECRET || !CIRCLE_BUYER_WALLET_ID) {
  console.error('Missing CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, or CIRCLE_BUYER_WALLET_ID in .env.');
  process.exit(1);
}

if (!Number.isFinite(INTERVAL_MS) || INTERVAL_MS < 5000) {
  console.error('AGENT_INTERVAL_MS must be a number greater than or equal to 5000.');
  process.exit(1);
}

const chainConfig = CHAIN_CONFIGS[CHAIN];
if (!chainConfig) {
  console.error(`Unsupported AGENT_CHAIN "${CHAIN}". Use arcTestnet for ARC testnet.`);
  process.exit(1);
}

const walletClient = initiateDeveloperControlledWalletsClient({
  apiKey: CIRCLE_API_KEY,
  entitySecret: CIRCLE_ENTITY_SECRET,
  ...(CIRCLE_BASE_URL ? { baseUrl: CIRCLE_BASE_URL } : {})
});

const circleProvider = createEIP1193Provider({
  apiKey: CIRCLE_API_KEY,
  entitySecret: CIRCLE_ENTITY_SECRET,
  chain: chainConfig.chain.id,
  ...(CIRCLE_BASE_URL ? { baseUrl: CIRCLE_BASE_URL } : {}),
  fallback: {
    request: async ({ method, params }) => {
      const response = await fetch(process.env.RPC_URL || chainConfig.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params: params || []
        })
      });
      const json = await response.json();
      if (json.error) {
        throw new Error(json.error.message || JSON.stringify(json.error));
      }
      return json.result;
    }
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyJson(value) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function defaultState() {
  return { day: utcDay(), spentAtomic: '0', lastPurchaseAt: 0, purchases: 0, failures: 0, sources: {} };
}

async function loadState() {
  try {
    const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    if (state.day !== utcDay()) {
      return { ...defaultState(), sources: state.sources || {} };
    }
    return { ...defaultState(), ...state };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[state] Could not read ${STATE_FILE}: ${error.message}`);
    return defaultState();
  }
}

async function saveState(state) {
  const temporary = `${STATE_FILE}.tmp`;
  await fs.writeFile(temporary, `${stringifyJson(state)}\n`, { mode: 0o600 });
  await fs.rename(temporary, STATE_FILE);
}

async function getPublicSummary() {
  const response = await fetch(SUMMARY_URL, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Public summary failed with status ${response.status}`);
  const data = await response.json();
  const summary = data.data?.summary;
  if (!summary || !Array.isArray(summary.assets)) throw new Error('Public summary has an invalid format.');
  return summary;
}

function decidePurchase(summary, state) {
  const spent = BigInt(state.spentAtomic || '0');
  if (spent >= DAILY_BUDGET) return { buy: false, reason: 'daily-budget-exhausted' };
  if (!state.lastPurchaseAt) return { buy: true, reason: 'initial-research' };
  const elapsed = Date.now() - Number(state.lastPurchaseAt);
  const highRisk = summary.assets.some((asset) => asset.risk === 'high');
  const expired = Date.parse(summary.expiresAt || '') <= Date.now() + 60000;
  if (elapsed >= MIN_PURCHASE_INTERVAL_MS && (expired || highRisk)) {
    return { buy: true, reason: expired ? 'report-expiring' : 'high-market-risk' };
  }
  return { buy: false, reason: elapsed < MIN_PURCHASE_INTERVAL_MS ? 'purchase-cooldown' : 'public-data-sufficient' };
}

function selectPaidSource(state) {
  return [...PAID_DATA_URLS].sort((left, right) => {
    const leftStats = state.sources[left] || {};
    const rightStats = state.sources[right] || {};
    const leftScore = Number(leftStats.successes || 0) - Number(leftStats.failures || 0) * 2;
    const rightScore = Number(rightStats.successes || 0) - Number(rightStats.failures || 0) * 2;
    return rightScore - leftScore;
  })[0];
}

function encodePaymentHeader(paymentPayload, paymentRequired, accepted) {
  return Buffer.from(stringifyJson({
    ...paymentPayload,
    resource: paymentRequired.resource,
    accepted
  })).toString('base64');
}

async function getCircleWalletTokenBalances() {
  const response = await walletClient.getWalletTokenBalance({
    id: CIRCLE_BUYER_WALLET_ID
  });

  return response.data?.tokenBalances || [];
}

async function getGatewayBalance(address) {
  const apiBaseUrl = chainConfig.chain.testnet
    ? 'https://gateway-api-testnet.circle.com/v1'
    : 'https://gateway-api.circle.com/v1';

  const response = await fetch(`${apiBaseUrl}/balances`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: 'USDC',
      sources: [{ depositor: address, domain: chainConfig.domain }]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || response.statusText);
  }

  const balance = data.balances?.[0] || {};
  const available = parseUnits(balance.balance || '0', 6);
  const withdrawing = parseUnits(balance.withdrawing || '0', 6);
  const withdrawable = parseUnits(balance.withdrawable || '0', 6);

  return {
    available,
    withdrawing,
    withdrawable,
    formattedAvailable: formatUnits(available, 6),
    formattedWithdrawing: formatUnits(withdrawing, 6),
    formattedWithdrawable: formatUnits(withdrawable, 6)
  };
}

async function printBalances(address) {
  try {
    const tokenBalances = await getCircleWalletTokenBalances();
    const usdcBalances = tokenBalances.filter((balance) => {
      const token = balance.token || {};
      return token.symbol === 'USDC' || balance.symbol === 'USDC';
    });

    if (usdcBalances.length === 0) {
      console.log('[balance] Circle wallet USDC: not found in wallet token balances');
    } else {
      for (const balance of usdcBalances) {
        const token = balance.token || {};
        const chain = token.blockchain || balance.blockchain || 'unknown-chain';
        console.log(`[balance] Circle wallet USDC on ${chain}: ${balance.amount || '0'}`);
      }
    }
  } catch (error) {
    console.warn(`[balance] Could not read Circle wallet token balances: ${error.message}`);
  }

  try {
    const gatewayBalance = await getGatewayBalance(address);
    console.log(`[balance] Circle Gateway available on ${CHAIN}: ${gatewayBalance.formattedAvailable} USDC`);
    console.log(`[balance] Circle Gateway withdrawing: ${gatewayBalance.formattedWithdrawing} USDC`);
    console.log(`[balance] Circle Gateway withdrawable: ${gatewayBalance.formattedWithdrawable} USDC`);

    if (gatewayBalance.available < MIN_GATEWAY_BALANCE) {
      console.warn(`[balance] Gateway available balance is below ${formatUnits(MIN_GATEWAY_BALANCE, 6)} USDC. x402 payments may fail until you deposit/fund Gateway.`);
    }
  } catch (error) {
    console.warn(`[balance] Could not read Circle Gateway balance: ${error.message}`);
  }
}

async function waitForCircleTransaction(transactionId, label) {
  const response = await walletClient.getTransaction({
    id: transactionId,
    waitForState: 'COMPLETE',
    pollingInterval: 2000
  });
  const transaction = response.data?.transaction;

  if (!transaction?.txHash) {
    throw new Error(`${label} completed without a transaction hash.`);
  }

  console.log(`[deposit] ${label} tx: ${transaction.txHash}`);
  return transaction;
}

async function executeCircleContractTransaction(contractAddress, abiFunctionSignature, abiParameters, label) {
  const response = await walletClient.createContractExecutionTransaction({
    walletId: CIRCLE_BUYER_WALLET_ID,
    contractAddress,
    abiFunctionSignature,
    abiParameters,
    fee: {
      type: 'level',
      config: { feeLevel: 'MEDIUM' }
    }
  });
  const transactionId = response.data?.id;

  if (!transactionId) {
    throw new Error(`Circle did not return a transaction ID for ${label}.`);
  }

  console.log(`[deposit] ${label} submitted: ${transactionId}`);
  return waitForCircleTransaction(transactionId, label);
}

async function maybeDepositToGateway(address) {
  if (!GATEWAY_DEPOSIT_ON_START) {
    return;
  }

  const amount = parseUnits(GATEWAY_DEPOSIT_AMOUNT, 6);
  if (amount <= 0n) {
    throw new Error('AGENT_GATEWAY_DEPOSIT_AMOUNT must be greater than zero.');
  }

  const current = await getGatewayBalance(address);
  if (current.available >= amount) {
    console.log(`[deposit] Gateway already has at least ${GATEWAY_DEPOSIT_AMOUNT} USDC available; skipping deposit.`);
    return;
  }

  console.log(`[deposit] Depositing ${GATEWAY_DEPOSIT_AMOUNT} USDC from Circle wallet to Gateway.`);
  console.log(`[deposit] USDC: ${chainConfig.usdc}`);
  console.log(`[deposit] GatewayWallet: ${chainConfig.gatewayWallet}`);

  await executeCircleContractTransaction(
    chainConfig.usdc,
    'approve(address,uint256)',
    [chainConfig.gatewayWallet, amount.toString()],
    'USDC approval'
  );

  await executeCircleContractTransaction(
    chainConfig.gatewayWallet,
    'deposit(address,uint256)',
    [chainConfig.usdc, amount.toString()],
    'Gateway deposit'
  );

  const updated = await getGatewayBalance(address);
  console.log(`[deposit] Gateway available after deposit: ${updated.formattedAvailable} USDC`);
}

async function getBuyerAddress() {
  if (CIRCLE_BUYER_ADDRESS) {
    return getAddress(CIRCLE_BUYER_ADDRESS);
  }

  const response = await walletClient.getWallet({ id: CIRCLE_BUYER_WALLET_ID });
  const wallet = response.data?.wallet;
  const address = wallet?.address;

  if (!address) {
    throw new Error('Could not resolve buyer wallet address from Circle. Set CIRCLE_BUYER_ADDRESS in .env.');
  }

  return getAddress(address);
}

function createCircleSigner(address) {
  return {
    address,
    signTypedData: async ({ domain, types, primaryType, message }) => {
      const typedData = {
        domain,
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' }
          ],
          ...types
        },
        primaryType,
        message
      };

      return circleProvider.request({
        method: 'eth_signTypedData_v4',
        params: [address, stringifyJson(typedData)]
      });
    }
  };
}

function selectGatewayBatchingOption(paymentRequired) {
  const expectedNetwork = `eip155:${chainConfig.chain.id}`;
  const accepts = paymentRequired.accepts || [];
  const option = accepts.find((candidate) => {
    const extra = candidate.extra || {};
    return candidate.network === expectedNetwork &&
      extra.name === 'GatewayWalletBatched' &&
      extra.version === '1' &&
      typeof extra.verifyingContract === 'string';
  });

  if (!option) {
    throw new Error(`No Circle Gateway batching option available for ${expectedNetwork}.`);
  }

  return option;
}

async function payWithCircleWalletApi(url, batchScheme, remainingBudget) {
  const initialResponse = await fetch(url, {
    method: 'GET',
    headers: { 'content-type': 'application/json' }
  });

  if (initialResponse.status !== 402) {
    if (!initialResponse.ok) {
      throw new Error(`Initial request failed with status ${initialResponse.status}`);
    }

    return {
      data: await initialResponse.json(),
      amount: 0n,
      formattedAmount: '0',
      transaction: '',
      status: initialResponse.status
    };
  }

  const paymentRequiredHeader = initialResponse.headers.get('PAYMENT-REQUIRED');
  if (!paymentRequiredHeader) {
    throw new Error('Missing PAYMENT-REQUIRED header in 402 response.');
  }

  const paymentRequired = JSON.parse(Buffer.from(paymentRequiredHeader, 'base64').toString('utf-8'));
  const accepted = selectGatewayBatchingOption(paymentRequired);
  const x402Version = paymentRequired.x402Version || 2;
  const amount = BigInt(accepted.amount);

  if (amount > MAX_PURCHASE) {
    throw new Error(`Source price ${formatUnits(amount, 6)} USDC exceeds the per-purchase limit.`);
  }
  if (amount > remainingBudget) {
    throw new Error(`Source price ${formatUnits(amount, 6)} USDC exceeds the remaining daily budget.`);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const paymentPayload = await batchScheme.createPaymentPayload(x402Version, accepted);
    const paymentHeader = encodePaymentHeader(paymentPayload, paymentRequired, accepted);

    const paidResponse = await fetch(url, {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        'Payment-Signature': paymentHeader
      }
    });

    let settleResponse;
    const paymentResponseHeader = paidResponse.headers.get('PAYMENT-RESPONSE');
    if (paymentResponseHeader) {
      settleResponse = JSON.parse(Buffer.from(paymentResponseHeader, 'base64').toString('utf-8'));
    }

    const recovery = await batchScheme.dispatchPaymentResponse({
      paymentPayload: {
        x402Version: paymentPayload.x402Version,
        payload: paymentPayload.payload
      },
      requirements: accepted,
      paymentRequired,
      settleResponse,
      error: paidResponse.ok ? undefined : new Error(`Payment failed with status ${paidResponse.status}`)
    });

    if (recovery?.recovered && attempt === 0) {
      continue;
    }

    if (!paidResponse.ok) {
      const error = await paidResponse.json().catch(() => ({}));
      throw new Error(`Payment failed: ${error.error || paidResponse.statusText}`);
    }

    return {
      data: await paidResponse.json(),
      amount,
      formattedAmount: formatUnits(amount, 6),
      transaction: settleResponse?.transaction || '',
      status: paidResponse.status
    };
  }

  throw new Error('Payment failed after retry.');
}

async function run() {
  const buyerAddress = await getBuyerAddress();
  const batchScheme = new BatchEvmScheme(createCircleSigner(buyerAddress));

  batchScheme
    .onBeforePaymentCreation(async (ctx) => {
      console.log(`[x402] selected amount: ${ctx.selectedRequirements?.amount || 'unknown'} atomic USDC`);
    })
    .onAfterPaymentCreation(async () => {
      console.log('[x402] Circle Wallet API signed payment authorization');
    })
    .onPaymentResponse(async (ctx) => {
      console.log(`[x402] settlement: ${stringifyJson(ctx.settleResponse || {})}`);
    });

  console.log('====================================================');
  console.log('Circle Wallet API x402 buyer agent started');
  console.log(`Chain: ${CHAIN} (${chainConfig.chain.id})`);
  console.log(`Buyer wallet id: ${CIRCLE_BUYER_WALLET_ID}`);
  console.log(`Buyer address: ${buyerAddress}`);
  console.log(`Target: ${TARGET_URL}`);
  console.log(`Paid sources: ${PAID_DATA_URLS.length}`);
  console.log(`Interval: ${INTERVAL_MS} ms`);
  console.log(`Daily x402 budget: ${formatUnits(DAILY_BUDGET, 6)} USDC`);
  console.log(`Max purchase: ${formatUnits(MAX_PURCHASE, 6)} USDC`);
  console.log('====================================================');

  await printBalances(buyerAddress);
  await maybeDepositToGateway(buyerAddress);

  let state = await loadState();
  let cycleCount = 1;
  while (true) {
    try {
      if (state.day !== utcDay()) state = { ...defaultState(), sources: state.sources || {} };
      const summary = await getPublicSummary();
      const decision = decidePurchase(summary, state);
      console.log(`[Cycle #${cycleCount}] research decision=${decision.buy ? 'BUY_DATA' : 'SKIP'} reason=${decision.reason}`);

      if (decision.buy) {
        const source = selectPaidSource(state);
        if (!source) throw new Error('No paid x402 data source is configured.');
        const spent = BigInt(state.spentAtomic || '0');
        const result = await payWithCircleWalletApi(source, batchScheme, DAILY_BUDGET - spent);

        state.spentAtomic = (spent + result.amount).toString();
        state.lastPurchaseAt = Date.now();
        state.purchases = Number(state.purchases || 0) + 1;
        state.sources[source] = {
          ...(state.sources[source] || {}),
          successes: Number(state.sources[source]?.successes || 0) + 1,
          lastSuccessAt: Date.now()
        };
        await saveState(state);

        const report = result.data?.data?.report;
        if (!isMarketReport(report)) throw new Error('Paid source returned an invalid market report.');
        console.log(`[Cycle #${cycleCount}] paid ${result.formattedAmount} USDC through Circle Gateway x402`);
        console.log(`[Cycle #${cycleCount}] transaction=${result.transaction || 'pending/batched'}`);
        console.log(`[Cycle #${cycleCount}] report=${report.reportId} engine=${report.engine}`);
        for (const asset of report.assets) {
          console.log(`[research] ${asset.symbol} ${asset.signal} confidence=${asset.confidence} risk=${asset.risk} price=${asset.price}`);
        }
        console.log(`[budget] spent=${formatUnits(BigInt(state.spentAtomic), 6)} remaining=${formatUnits(DAILY_BUDGET - BigInt(state.spentAtomic), 6)} USDC`);
      }
    } catch (error) {
      state.failures = Number(state.failures || 0) + 1;
      await saveState(state).catch(() => {});
      console.error(`[Cycle #${cycleCount}] failed: ${error.message}`);
    }

    cycleCount += 1;
    await sleep(INTERVAL_MS);
  }
}

run();
