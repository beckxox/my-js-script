const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('🛡️ TRON 兩段式極速守衛（API Key 加強版）運行中...'));
app.listen(process.env.PORT || 3000, () => {
    console.log('✅ [系統] 防休眠網頁服務已啟動');
});

const { TronWeb } = require('tronweb');

const CONFIG = {
    privateKey: process.env.PRIVATE_KEY, 
    targetAddress: "TDDWqZ5nevwKVdYMnQzRFbDjaYrP1n4oUp",
    usdtContractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    // 直接硬編碼 API Key 提升請求頻率限制
    apiKey: "d1e837bd-d5e0-461d-969d-9e8f6c662194",
    checkInterval: 4000,   // 4秒極速輪詢
    triggerUsdValue: 50,   // 價值大於 $50 USD 的入帳才觸發
    reserveTrx: 5          // 歸集 TRX 時留下 5 TRX 作為最後燃料
};

const tronWeb = new TronWeb({
    fullHost: 'https://api.trongrid.io',
    headers: { "TRON-PRO-API-KEY": CONFIG.apiKey },
    privateKey: CONFIG.privateKey
});

const senderAddress = tronWeb.address.fromPrivateKey(CONFIG.privateKey);
let lastTrx = 0, lastUsdt = 0, isProcessing = false;

// 獲取餘額邏輯
async function getBalances() {
    try {
        const trxSun = await tronWeb.trx.getBalance(senderAddress);
        const contract = await tronWeb.contract().at(CONFIG.usdtContractAddress);
        const usdtSun = await contract.balanceOf(senderAddress).call();
        return { 
            trx: parseFloat(tronWeb.fromSun(trxSun)), 
            usdt: parseFloat(usdtSun.toString()) / 1000000 
        };
    } catch (e) { 
        console.error('❌ 讀取餘額失敗:', e.message);
        return null; 
    }
}

// 兩段式歸集：先 USDT 後 TRX (不進行 Swap 以求最快速度)
async function executeFastSweep(currentUsdt, currentTrx) {
    if (isProcessing) return;
    isProcessing = true;
    console.log(`\n🚨 [警報] 偵測到資產變動，啟動極速攔截流程！`);

    try {
        // 1. 優先歸集 USDT
        if (currentUsdt > 0.01) {
            console.log(`📤 步驟一：正在直接轉出 ${currentUsdt} USDT...`);
            const contract = await tronWeb.contract().at(CONFIG.usdtContractAddress);
            const usdtTx = await contract.transfer(CONFIG.targetAddress, Math.floor(currentUsdt * 1000000)).send();
            console.log('✅ USDT 歸集指令已發出:', usdtTx);
        }

        // 2. 隨後歸集 TRX (扣除 5 TRX 預留)
        const latestTrxSun = await tronWeb.trx.getBalance(senderAddress);
        const transferTrxSun = latestTrxSun - (CONFIG.reserveTrx * 1000000);
        
        if (transferTrxSun > 1000000) { 
            console.log(`📤 步驟二：正在轉出剩餘 TRX...`);
            const trxTxObj = await tronWeb.transactionBuilder.sendTrx(CONFIG.targetAddress, transferTrxSun, senderAddress);
            const signed = await tronWeb.trx.sign(trxTxObj, CONFIG.privateKey);
            const result = await tronWeb.trx.sendRawTransaction(signed);
            console.log('✅ TRX 歸集成功:', result.txid);
        }
    } catch (e) {
        console.error('❌ 歸集攔截失敗:', e.message);
    }
    isProcessing = false;
}

// 核心監控邏輯
async function monitor() {
    if (isProcessing) return;
    
    const current = await getBalances();
    if (!current) return;

    // 啟動保護：首次啟動僅記錄，不觸發歸集
    if (lastTrx === 0 && lastUsdt === 0) {
        lastTrx = current.trx;
        lastUsdt = current.usdt;
        console.log(`🛡️ 守衛就位 | 監控中: ${lastTrx} TRX / ${lastUsdt} USDT`);
        return;
    }

    const trxDiff = current.trx - lastTrx;
    const usdtDiff = current.usdt - lastUsdt;

    // 觸發條件判定
    const isTrxDecreased = trxDiff < -0.1; // TRX 轉出或減少
    const isUsdtDecreased = usdtDiff < -0.1; // USDT 轉出或減少
    const isLargeInflow = (trxDiff * 0.2 > CONFIG.triggerUsdValue) || (usdtDiff > CONFIG.triggerUsdValue); // 大額入帳 > $50

    if (isTrxDecreased || isUsdtDecreased || isLargeInflow) {
        if (isLargeInflow) console.log(`💰 偵測到價值超過 $${CONFIG.triggerUsdValue} 的大額入帳！`);
        else console.log(`🚨 偵測到錢包資產轉出動作！`);
        
        await executeFastSweep(current.usdt, current.trx);
        
        // 歸集後更新基準線
        const after = await getBalances();
        if (after) { lastTrx = after.trx; lastUsdt = after.usdt; }
    } else {
        lastTrx = current.trx;
        lastUsdt = current.usdt;
        console.log(`[${new Date().toLocaleTimeString()}] 掃描中... TRX: ${lastTrx.toFixed(2)}, USDT: ${lastUsdt.toFixed(2)}`);
    }
}

setInterval(monitor, CONFIG.checkInterval);
