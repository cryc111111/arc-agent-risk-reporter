const assetGrid = document.querySelector('#asset-grid');
const refreshButton = document.querySelector('#refresh-button');
const statusDot = document.querySelector('.status-dot');
const purchaseButton = document.querySelector('#purchase-button');
const purchaseStatus = document.querySelector('#purchase-status');
const ARC_CHAIN_ID = '0x4cef52';
const PAID_REPORT_URL = '/api/premium/x402/market-analysis';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const ARC_GATEWAY_WALLET = '0x0077777d7eba4688bdef3e311b846f25870a19b9';
const REPORT_PRICE_ATOMIC = '100000';
const SELLER_ADDRESS = '0x89ad0edc173536284bbdea086a1f6b5793fc40aa';

const labels = {
  risk: { low: '低风险', medium: '中等风险', high: '高风险' },
  trend: { bullish: '偏多趋势', neutral: '震荡趋势', bearish: '偏空趋势' },
  signal: { BUY: '偏向买入', HOLD: '保持观察', SELL: '偏向卖出' }
};

function formatPrice(value) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: value >= 10000 ? 0 : 2 }).format(value);
}

function signalCopy(asset) {
  if (asset.signal === 'BUY') return `多项指标偏强，当前观点倾向积极，但仍需留意${labels.risk[asset.risk]}。`;
  if (asset.signal === 'SELL') return `短期指标偏弱，当前观点倾向谨慎，避免忽视价格反弹风险。`;
  return `指标暂未形成一致方向，当前更适合等待新的市场信号。`;
}

function rangePercent(asset) {
  const width = asset.resistance - asset.support;
  if (!Number.isFinite(width) || width <= 0) return 50;
  return Math.max(4, Math.min(96, ((asset.price - asset.support) / width) * 100));
}

function renderAsset(asset) {
  const changeClass = asset.change24hPercent >= 0 ? 'positive' : 'negative';
  const changePrefix = asset.change24hPercent >= 0 ? '+' : '';
  return `
    <article class="asset-card">
      <div class="asset-top">
        <div class="asset-name">
          <span class="asset-symbol">${asset.symbol[0]}</span>
          <div><h2>${asset.symbol}</h2><span>${labels.trend[asset.trend] || asset.trend}</span></div>
        </div>
        <span class="risk-badge risk-${asset.risk}">${labels.risk[asset.risk] || asset.risk}</span>
      </div>
      <div class="price-row">
        <span class="price">${formatPrice(asset.price)}</span>
        <span class="change ${changeClass}">${changePrefix}${asset.change24hPercent.toFixed(2)}%</span>
      </div>
      <div class="signal-row">
        <span class="signal-badge signal-${asset.signal.toLowerCase()}">${labels.signal[asset.signal]}</span>
        <p class="signal-copy">${signalCopy(asset)}</p>
      </div>
      <div class="range">
        <div class="range-track"><div class="range-position" style="width:${rangePercent(asset)}%"></div></div>
        <div class="range-labels"><span>支撑 ${formatPrice(asset.support)}</span><span>阻力 ${formatPrice(asset.resistance)}</span></div>
      </div>
      <p class="quality">可信度 ${Math.round(asset.confidence * 100)}% · ${asset.dataQuality.technicalProviderCount} 个独立交易所 · 价差 ${asset.dataQuality.providerDivergencePercent.toFixed(3)}%</p>
    </article>`;
}

function marketMessage(assets) {
  const highRisk = assets.some((asset) => asset.risk === 'high');
  const buys = assets.filter((asset) => asset.signal === 'BUY').map((asset) => asset.symbol);
  const sells = assets.filter((asset) => asset.signal === 'SELL').map((asset) => asset.symbol);
  if (highRisk) return '市场波动处于较高水平。当前报告建议优先关注风险控制，不要只依据单一信号行动。';
  if (buys.length) return `${buys.join('、')} 的技术指标相对积极；其余资产暂未形成同等强度的方向共识。`;
  if (sells.length) return `${sells.join('、')} 的短期指标偏弱，市场整体更适合保持谨慎。`;
  return '多个行情源暂未显示明确的单边方向，BTC 与 ETH 当前以观察和等待确认为主。';
}

function decodeBase64Json(value) {
  return JSON.parse(atob(value));
}

function encodeBase64Json(value) {
  return btoa(JSON.stringify(value));
}

function createNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function usdcToAtomic(value) {
  const [whole = '0', fraction = ''] = String(value).split('.');
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}

function addressWord(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('钱包返回了无效地址。');
  return address.slice(2).toLowerCase().padStart(64, '0');
}

function uintWord(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

async function walletCall(to, data, from) {
  return window.ethereum.request({ method: 'eth_call', params: [{ to, data, from }, 'latest'] });
}

async function getArcUsdcBalance(address) {
  const result = await walletCall(ARC_USDC, `0x70a08231${addressWord(address)}`, address);
  return BigInt(result || '0x0');
}

async function getGatewayAllowance(address) {
  const data = `0xdd62ed3e${addressWord(address)}${addressWord(ARC_GATEWAY_WALLET)}`;
  const result = await walletCall(ARC_USDC, data, address);
  return BigInt(result || '0x0');
}

async function waitForTransaction(hash, label) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const receipt = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`${label}链上执行失败。`);
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${label}等待链上确认超时。`);
}

async function sendContractTransaction(from, to, data, label) {
  const hash = await window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, data, value: '0x0' }]
  });
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) throw new Error(`${label}没有返回有效交易哈希。`);
  return waitForTransaction(hash, label);
}

async function getGatewayBalance(address) {
  const response = await fetch(`/api/gateway/balance?address=${encodeURIComponent(address)}`, { cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '无法查询 Circle Gateway 余额。');
  return body.data;
}

async function waitForGatewayBalance(address, requiredAtomic) {
  const deadline = Date.now() + 90000;
  let latest = '0';
  while (Date.now() < deadline) {
    const balance = await getGatewayBalance(address);
    latest = balance.available;
    if (usdcToAtomic(latest) >= requiredAtomic) return balance;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`存入交易已成功，但 Circle Gateway 尚未更新余额（当前 ${latest} USDC），请稍后重试购买。`);
}

async function ensureGatewayBalance(address, currentBalance, requiredAtomic) {
  const currentAtomic = usdcToAtomic(currentBalance.available);
  if (currentAtomic >= requiredAtomic) return currentBalance;
  const depositAmount = requiredAtomic - currentAtomic;
  const tokenBalance = await getArcUsdcBalance(address);
  if (tokenBalance < depositAmount) {
    throw new Error(`钱包 ARC USDC 不足，需要至少 ${(Number(depositAmount) / 1000000).toFixed(6)} USDC。`);
  }
  const nativeBalance = BigInt(await window.ethereum.request({ method: 'eth_getBalance', params: [address, 'latest'] }));
  if (nativeBalance === 0n) throw new Error('钱包没有可用于 ARC 交易 Gas 的原生 USDC。');

  const depositDisplay = (Number(depositAmount) / 1000000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  const allowance = await getGatewayAllowance(address);
  if (allowance < depositAmount) {
    purchaseStatus.textContent = `请确认授权 Circle Gateway 使用 ${depositDisplay} USDC。`;
    const approveData = `0x095ea7b3${addressWord(ARC_GATEWAY_WALLET)}${uintWord(depositAmount)}`;
    await sendContractTransaction(address, ARC_USDC, approveData, 'USDC 授权');
  }

  purchaseStatus.textContent = `授权成功，请确认向 Circle Gateway 存入 ${depositDisplay} USDC。`;
  const depositData = `0x47e7ef24${addressWord(ARC_USDC)}${uintWord(depositAmount)}`;
  await sendContractTransaction(address, ARC_GATEWAY_WALLET, depositData, 'Gateway 存入');
  purchaseStatus.textContent = '存入交易已确认，正在等待 Circle Gateway 更新余额…';
  return waitForGatewayBalance(address, requiredAtomic);
}

async function connectArcWallet() {
  if (!window.ethereum) throw new Error('未检测到浏览器钱包，请先安装兼容 EVM 的钱包。');
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (!accounts?.[0]) throw new Error('钱包没有返回可用地址。');
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ARC_CHAIN_ID }] });
  } catch (error) {
    if (error.code !== 4902) throw error;
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: ARC_CHAIN_ID,
        chainName: 'Arc Testnet',
        nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
        rpcUrls: ['https://rpc.testnet.arc.network']
      }]
    });
  }
  return accounts[0];
}

function selectArcRequirement(paymentRequired) {
  return paymentRequired.accepts?.find((item) =>
    item.scheme === 'exact' &&
    item.network === 'eip155:5042002' &&
    item.asset?.toLowerCase() === ARC_USDC &&
    item.amount === REPORT_PRICE_ATOMIC &&
    item.payTo?.toLowerCase() === SELLER_ADDRESS &&
    Number(item.maxTimeoutSeconds) >= 604900 &&
    Number(item.maxTimeoutSeconds) <= 605000 &&
    item.extra?.name === 'GatewayWalletBatched' &&
    item.extra?.version === '1' &&
    item.extra?.verifyingContract?.toLowerCase() === ARC_GATEWAY_WALLET
  );
}

async function signPayment(address, paymentRequired, accepted) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: address,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: String(now - 600),
    validBefore: String(now + 604900),
    nonce: createNonce()
  };
  const typedData = {
    domain: {
      name: 'GatewayWalletBatched',
      version: '1',
      chainId: 5042002,
      verifyingContract: accepted.extra.verifyingContract
    },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' }
      ],
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' }
      ]
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization
  };
  const signature = await window.ethereum.request({
    method: 'eth_signTypedData_v4',
    params: [address, JSON.stringify(typedData)]
  });
  return {
    x402Version: paymentRequired.x402Version || 2,
    payload: { authorization, signature },
    resource: paymentRequired.resource,
    accepted
  };
}

function renderPremiumReport(report, paymentResponse) {
  const section = document.querySelector('#premium-report');
  const content = document.querySelector('#premium-content');
  content.replaceChildren();
  for (const asset of report.assets) {
    const article = document.createElement('article');
    article.className = 'premium-analysis';
    const heading = document.createElement('h3');
    heading.textContent = `${asset.symbol} · ${labels.signal[asset.signal]}`;
    article.append(heading);
    const metrics = document.createElement('dl');
    const rows = [
      ['RSI 14', asset.indicators.rsi14],
      ['24小时波动率', `${asset.indicators.volatility24hPercent}%`],
      ['短期均线', formatPrice(asset.indicators.sma9)],
      ['中期均线', formatPrice(asset.indicators.sma21)]
    ];
    for (const [name, value] of rows) {
      const wrap = document.createElement('div');
      const term = document.createElement('dt');
      const detail = document.createElement('dd');
      term.textContent = name;
      detail.textContent = value;
      wrap.append(term, detail);
      metrics.append(wrap);
    }
    article.append(metrics);
    const list = document.createElement('ul');
    for (const reason of asset.rationale || []) {
      const item = document.createElement('li');
      item.textContent = reason;
      list.append(item);
    }
    article.append(list);
    content.append(article);
  }
  document.querySelector('#payment-reference').textContent = paymentResponse?.transaction ? `Payment ${paymentResponse.transaction}` : `Report ${report.reportId}`;
  section.hidden = false;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function purchaseReport() {
  purchaseButton.disabled = true;
  purchaseStatus.className = 'purchase-status';
  purchaseStatus.textContent = '正在读取 ARC x402 付款要求…';
  try {
    const initial = await fetch(PAID_REPORT_URL, { cache: 'no-store' });
    if (initial.status !== 402) throw new Error(`付费接口状态异常：${initial.status}`);
    const requiredHeader = initial.headers.get('PAYMENT-REQUIRED');
    if (!requiredHeader) throw new Error('卖方没有返回 PAYMENT-REQUIRED。');
    const paymentRequired = decodeBase64Json(requiredHeader);
    const accepted = selectArcRequirement(paymentRequired);
    if (!accepted) throw new Error('付款参数未通过 ARC Circle Gateway 安全校验。');

    purchaseStatus.textContent = '请在钱包中确认 ARC x402 签名。';
    const address = await connectArcWallet();
    purchaseStatus.textContent = '正在检查该钱包的 Circle Gateway 可用余额…';
    let gatewayBalance = await getGatewayBalance(address);
    gatewayBalance = await ensureGatewayBalance(address, gatewayBalance, BigInt(REPORT_PRICE_ATOMIC));
    purchaseStatus.textContent = `Gateway 可用余额 ${gatewayBalance.available} USDC，请在钱包中确认 ARC x402 签名。`;
    const paymentPayload = await signPayment(address, paymentRequired, accepted);
    purchaseStatus.textContent = '签名完成，Circle Gateway 正在结算…';
    const paid = await fetch(PAID_REPORT_URL, {
      headers: { 'Payment-Signature': encodeBase64Json(paymentPayload) },
      cache: 'no-store'
    });
    const body = await paid.json().catch(() => ({}));
    if (!paid.ok) throw new Error(body.reason || body.error || `付款失败：${paid.status}`);
    const responseHeader = paid.headers.get('PAYMENT-RESPONSE');
    const paymentResponse = responseHeader ? decodeBase64Json(responseHeader) : null;
    if (!body.data?.report) throw new Error('付款成功，但报告内容缺失。');
    renderPremiumReport(body.data.report, paymentResponse);
    purchaseStatus.textContent = '付款成功，完整报告已展开。';
  } catch (error) {
    purchaseStatus.className = 'purchase-status error';
    purchaseStatus.textContent = error.code === 4001 ? '你已取消钱包操作。' : error.message;
  } finally {
    purchaseButton.disabled = false;
  }
}

async function loadSummary() {
  refreshButton.disabled = true;
  try {
    const response = await fetch('/api/market/summary', { cache: 'no-store' });
    if (!response.ok) throw new Error('summary unavailable');
    const summary = (await response.json()).data.summary;
    assetGrid.innerHTML = summary.assets.map(renderAsset).join('');
    document.querySelector('#market-message').textContent = marketMessage(summary.assets);
    document.querySelector('#updated-at').textContent = new Date(summary.generatedAt).toLocaleString('zh-CN', { hour12: false });
    document.querySelector('#report-id').textContent = `Report ${summary.reportId.slice(0, 8)}`;
    const providers = [...new Set(summary.assets.flatMap((asset) => asset.dataQuality.providers))];
    document.querySelector('#source-list').innerHTML = providers.map((provider) => `<span class="source-chip">${provider}</span>`).join('');
    document.querySelector('#service-status').textContent = '数据正常';
    statusDot.className = 'status-dot online';
  } catch {
    document.querySelector('#service-status').textContent = '数据暂不可用';
    statusDot.className = 'status-dot offline';
    document.querySelector('#market-message').textContent = '暂时无法取得足够的独立行情来源，系统不会展示未经交叉验证的结论。';
    assetGrid.innerHTML = '<div class="asset-card"><h2>报告暂不可用</h2><p class="market-message">行情恢复并通过多源校验后，页面会自动更新。</p></div>';
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener('click', loadSummary);
purchaseButton.addEventListener('click', purchaseReport);
loadSummary();
setInterval(loadSummary, 60000);
